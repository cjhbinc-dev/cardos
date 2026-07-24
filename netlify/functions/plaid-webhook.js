// Plaid webhook receiver with signature verification
// (plaid.com/docs/api/webhooks/webhook-verification/):
//   1. decode Plaid-Verification JWT header (alg must be ES256), extract kid
//   2. /webhook_verification_key/get → JWK public key (cached per kid)
//   3. verify signature, 4. iat no older than 5 minutes,
//   5. sha256(body) must equal request_body_sha256 (constant-time compare)
//
// Handled webhooks:
//   TRANSACTIONS / SYNC_UPDATES_AVAILABLE → run a cursor sync for that item
//   ITEM / ERROR (ITEM_LOGIN_REQUIRED), PENDING_EXPIRATION, PENDING_DISCONNECT,
//     USER_PERMISSION_REVOKED → mark the connection disconnected
// Anything else: acknowledged and logged.
const crypto = require('crypto');
const { getPlaidClient, getSupabaseAdmin, plaidErrorInfo } = require('./lib/plaid-client');

const keyCache = {}; // kid → JWK (per-instance cache)

function b64urlToBuf(s) { return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }

async function verifyPlaidJwt(token, rawBody) {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, why: 'malformed JWT' };
  let header, payload;
  try {
    header = JSON.parse(b64urlToBuf(parts[0]).toString('utf8'));
    payload = JSON.parse(b64urlToBuf(parts[1]).toString('utf8'));
  } catch { return { ok: false, why: 'undecodable JWT' }; }
  if (header.alg !== 'ES256') return { ok: false, why: 'alg is not ES256' };
  if (!header.kid) return { ok: false, why: 'missing kid' };

  if (!keyCache[header.kid]) {
    const plaid = getPlaidClient();
    try {
      const resp = await plaid.webhookVerificationKeyGet({ key_id: header.kid });
      keyCache[header.kid] = resp.data.key;
    } catch (err) {
      // Sandbox-fired webhooks (test harness) sign with sandbox keys — try the
      // sandbox environment before rejecting, when a sandbox secret exists.
      if (process.env.PLAID_SECRET_SANDBOX) {
        try {
          const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
          const sbx = new PlaidApi(new Configuration({
            basePath: PlaidEnvironments.sandbox,
            baseOptions: { headers: { 'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID, 'PLAID-SECRET': process.env.PLAID_SECRET_SANDBOX } },
          }));
          const resp2 = await sbx.webhookVerificationKeyGet({ key_id: header.kid });
          keyCache[header.kid] = resp2.data.key;
        } catch (err2) {
          plaidErrorInfo('/webhook_verification_key/get', err2);
          return { ok: false, why: 'could not fetch verification key' };
        }
      } else {
        plaidErrorInfo('/webhook_verification_key/get', err);
        return { ok: false, why: 'could not fetch verification key' };
      }
    }
  }
  const jwk = keyCache[header.kid];

  let publicKey;
  try { publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' }); }
  catch { return { ok: false, why: 'bad JWK' }; }

  // ES256 signature: JOSE (r||s) → DER for crypto.verify
  const sig = b64urlToBuf(parts[2]);
  const verified = crypto.verify(
    'sha256',
    Buffer.from(parts[0] + '.' + parts[1]),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    sig
  );
  if (!verified) return { ok: false, why: 'signature invalid' };

  if (!payload.iat || (Date.now() / 1000 - payload.iat) > 300) {
    return { ok: false, why: 'webhook older than 5 minutes' };
  }

  const bodyHash = crypto.createHash('sha256').update(rawBody, 'utf8').digest('hex');
  const claimed = payload.request_body_sha256 || '';
  const a = Buffer.from(bodyHash), b = Buffer.from(claimed);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, why: 'body hash mismatch' };
  }
  return { ok: true };
}

// Time-boxed transactions sync for one enrollment (webhook context — no user
// JWT; trust derives from signature verification, scoping from the enrollment
// row's own user_id). Same cursor rules as plaid-fetch-transactions: advance
// only after writes succeed, never persist an empty cursor.
async function syncItemTransactions(supabase, plaid, enrollment, budgetMs) {
  const started = Date.now();
  const userId = enrollment.user_id;
  const { data: connRows } = await supabase
    .from('connections').select('id, data')
    .eq('user_id', userId).eq('data->>itemId', enrollment.item_id);
  const conn = (connRows || [])[0];
  const connectionId = conn?.id || null;

  let cursor = enrollment.transaction_cursor || undefined;
  let added = 0, hasMore = true;
  while (hasMore && (Date.now() - started) < budgetMs) {
    let data;
    try {
      const resp = await plaid.transactionsSync({ access_token: enrollment.access_token, ...(cursor ? { cursor } : {}), count: 500 });
      data = resp.data;
    } catch (err) {
      plaidErrorInfo('/transactions/sync (webhook)', err);
      return { added, incomplete: true };
    }
    if (data.next_cursor === '') { await new Promise(r => setTimeout(r, 2000)); continue; }

    const nowIso = new Date().toISOString();
    const rows = [...data.added, ...data.modified].map(tx => ({
      id: tx.transaction_id, card_id: tx.account_id, tx_date: tx.authorized_date || tx.date,
      user_id: userId, updated_at: nowIso,
      data: {
        id: tx.transaction_id, card_id: tx.account_id, connection_id: connectionId,
        account_id: tx.account_id, user_id: userId,
        amount: typeof tx.amount === 'number' ? tx.amount : parseFloat(tx.amount) || 0,
        description: tx.merchant_name || tx.name || '',
        category: 'other', user_category: null,
        tx_date: tx.authorized_date || tx.date,
        status: tx.pending ? 'pending' : 'posted', pending: !!tx.pending,
        notes: '', tags: [], split_data: null,
        iso_currency_code: tx.iso_currency_code || tx.unofficial_currency_code || 'USD',
      },
    }));
    for (let i = 0; i < rows.length; i += 100) {
      const chunk = rows.slice(i, i + 100);
      const { data: saved, error } = await supabase.from('transactions').upsert(chunk).select('id');
      if (error || (saved || []).length !== chunk.length) {
        console.error('[plaid-webhook] tx write failed — cursor not advanced:', error?.message);
        return { added, incomplete: true };
      }
    }
    const removedIds = (data.removed || []).map(r => r.transaction_id).filter(Boolean);
    if (removedIds.length) {
      const { error } = await supabase.from('transactions').delete().in('id', removedIds).eq('user_id', userId);
      if (error) { console.error('[plaid-webhook] tx delete failed — cursor not advanced:', error.message); return { added, incomplete: true }; }
    }
    const { data: curSaved, error: curErr } = await supabase
      .from('enrollments').update({ transaction_cursor: data.next_cursor }).eq('id', enrollment.id).select('id');
    if (curErr || !curSaved?.length) { console.error('[plaid-webhook] cursor persist failed'); return { added, incomplete: true }; }
    cursor = data.next_cursor;
    added += data.added.length;
    hasMore = data.has_more;
  }
  return { added, incomplete: hasMore };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'method not allowed' };
  const rawBody = event.body || '';

  const jwtHeader = event.headers['plaid-verification'] || event.headers['Plaid-Verification'] || '';
  if (!jwtHeader) { console.warn('[plaid-webhook] missing Plaid-Verification header'); return { statusCode: 401, body: 'unverified' }; }
  const check = await verifyPlaidJwt(jwtHeader, rawBody);
  if (!check.ok) { console.warn('[plaid-webhook] verification failed:', check.why); return { statusCode: 401, body: 'unverified' }; }

  let hook;
  try { hook = JSON.parse(rawBody); } catch { return { statusCode: 400, body: 'bad json' }; }
  const { webhook_type: type, webhook_code: code, item_id: itemId } = hook;
  console.log('[plaid-webhook] verified:', type, code, 'item:', itemId);

  if (!itemId) return { statusCode: 200, body: 'ok' };

  const supabase = getSupabaseAdmin();
  const { data: enrollment } = await supabase
    .from('enrollments').select('id, item_id, access_token, transaction_cursor, user_id')
    .eq('item_id', itemId).maybeSingle();
  if (!enrollment) { console.warn('[plaid-webhook] unknown item:', itemId); return { statusCode: 200, body: 'ok' }; }

  if (type === 'TRANSACTIONS' && code === 'SYNC_UPDATES_AVAILABLE') {
    const plaid = getPlaidClient();
    const result = await syncItemTransactions(supabase, plaid, enrollment, 6000);
    console.log('[plaid-webhook] tx sync:', JSON.stringify(result));
  } else if (
    (type === 'ITEM' && (code === 'ERROR' || code === 'PENDING_EXPIRATION' || code === 'PENDING_DISCONNECT' || code === 'USER_PERMISSION_REVOKED')) ||
    code === 'ITEM_LOGIN_REQUIRED'
  ) {
    const isError = code === 'ERROR' ? (hook.error?.error_code || 'ERROR') : code;
    const { data: connRows } = await supabase
      .from('connections').select('id, user_id, data')
      .eq('user_id', enrollment.user_id).eq('data->>itemId', itemId);
    for (const conn of connRows || []) {
      const updated = { ...conn.data, syncStatus: 'disconnected', syncError: 'Bank connection needs to be re-linked (' + isError + ')' };
      await supabase.from('connections').update({ data: updated }).eq('id', conn.id).eq('user_id', conn.user_id).select('id');
    }
    console.log('[plaid-webhook] marked disconnected:', itemId, isError);
  }

  return { statusCode: 200, body: 'ok' };
};
