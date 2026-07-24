// /item/public_token/exchange (plaid.com/docs/api/items/#itempublic_tokenexchange)
// then /accounts/get (free, cached — plaid.com/docs/api/accounts/) and
// /institutions/get_by_id with include_optional_metadata for branding.
//
// Order of operations:
//   1. exchange → access_token + item_id
//   2. PERSIST the enrollment row FIRST (losing the token = unstoppable billing)
//   3. dedupe against the user's existing Plaid items (same institution+masks)
//      → if duplicate: /item/remove the NEW item, clean up, return duplicate:true
//   4. /accounts/get → credit cards; /institutions/get_by_id → branding
//   5. upsert connection (type:'plaid') + cards, all scoped to the caller
// The access_token is never returned to the client.
const { CORS, getPlaidClient, getSupabaseAdmin, getUserFromJWT, plaidErrorInfo, logPlaidOk, mapPlaidAccountToCard } = require('./lib/plaid-client');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase not configured' }) };
  }
  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Plaid not configured' }) };
  }

  const supabase = getSupabaseAdmin();
  const user = await getUserFromJWT(supabase, event);
  if (!user) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Authorization required' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }
  const { publicToken, institution } = body; // institution: { institution_id, name } from Link metadata
  if (!publicToken) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'publicToken required' }) };

  const plaid = getPlaidClient();

  // ── 1. Exchange ─────────────────────────────────────────────────────────────
  let accessToken, itemId;
  try {
    const resp = await plaid.itemPublicTokenExchange({ public_token: publicToken });
    logPlaidOk('/item/public_token/exchange', resp);
    accessToken = resp.data.access_token;
    itemId = resp.data.item_id;
  } catch (err) {
    const info = plaidErrorInfo('/item/public_token/exchange', err);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Token exchange failed', plaid: info }) };
  }

  // ── 2. Persist the enrollment BEFORE anything else ─────────────────────────
  const enrollRow = {
    id: itemId,
    enrollment_id: itemId,
    item_id: itemId,
    access_token: accessToken,
    institution_name: institution?.name || 'Unknown',
    created_at: new Date().toISOString(),
    user_id: user.id,
  };
  {
    const { data: saved, error: enrErr } = await supabase.from('enrollments').upsert(enrollRow).select('id');
    if (enrErr || !saved || !saved.length) {
      console.error('[plaid-exchange] enrollment persist FAILED:', enrErr?.message || '0 rows — token NOT stored');
      // Try to unwind the Item so it can't bill unstoppably
      try { await plaid.itemRemove({ access_token: accessToken }); console.warn('[plaid-exchange] item removed after failed persist'); }
      catch (rmErr) { plaidErrorInfo('/item/remove (unwind)', rmErr); }
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not store enrollment — the new connection was rolled back. Try again.' }) };
    }
  }
  console.log('[plaid-exchange] enrollment stored for item', itemId);

  // ── 3. Accounts (needed for dedupe) ─────────────────────────────────────────
  let accounts = [];
  let institutionId = institution?.institution_id || null;
  try {
    const resp = await plaid.accountsGet({ access_token: accessToken });
    logPlaidOk('/accounts/get', resp);
    accounts = resp.data.accounts || [];
    institutionId = institutionId || resp.data.item?.institution_id || null;
  } catch (err) {
    const info = plaidErrorInfo('/accounts/get', err);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not fetch accounts', plaid: info }) };
  }

  const creditAccounts = accounts.filter(a => a.type === 'credit');
  console.log('[plaid-exchange] accounts:', accounts.length, '| credit:', creditAccounts.length,
    '| types:', accounts.map(a => `${a.type}/${a.subtype}`).join(', '));

  // ── Dedupe: same institution + same account masks already connected? ───────
  const { data: existingConns } = await supabase
    .from('connections').select('id, data')
    .eq('user_id', user.id).eq('data->>type', 'plaid');
  const dupConn = (existingConns || []).find(c =>
    c.data?.institutionId === institutionId && c.data?.itemId !== itemId);
  if (dupConn && creditAccounts.length) {
    const { data: dupCards } = await supabase
      .from('cards').select('data')
      .eq('user_id', user.id).eq('data->>connectionId', dupConn.id);
    const existingMasks = new Set((dupCards || []).map(r => r.data?.last4).filter(Boolean));
    const newMasks = creditAccounts.map(a => a.mask).filter(Boolean);
    const allDuplicate = newMasks.length > 0 && newMasks.every(m => existingMasks.has(m));
    if (allDuplicate) {
      console.warn('[plaid-exchange] duplicate item detected (institution', institutionId, 'masks', newMasks.join(','), ') — removing new item', itemId);
      try {
        const rmResp = await plaid.itemRemove({ access_token: accessToken });
        logPlaidOk('/item/remove (dedupe)', rmResp);
      } catch (rmErr) {
        const info = plaidErrorInfo('/item/remove (dedupe)', rmErr);
        // Keep the enrollment so the token isn't lost; surface loudly.
        return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Duplicate detected but /item/remove failed — enrollment kept for retry', plaid: info }) };
      }
      await supabase.from('enrollments').delete().eq('id', itemId).select('id');
      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({ duplicate: true, message: `${institution?.name || 'This bank'} is already connected — no second subscription was created.`, connectionId: dupConn.id }),
      };
    }
  }

  // ── 4. Institution branding (best-effort) ──────────────────────────────────
  let primaryColor = null, logo = null, institutionUrl = null;
  if (institutionId) {
    try {
      const resp = await plaid.institutionsGetById({
        institution_id: institutionId,
        country_codes: ['US'],
        options: { include_optional_metadata: true },
      });
      logPlaidOk('/institutions/get_by_id', resp);
      primaryColor = resp.data.institution?.primary_color || null;
      logo = resp.data.institution?.logo || null; // base64 152x152 PNG
      institutionUrl = resp.data.institution?.url || null;
    } catch (err) {
      plaidErrorInfo('/institutions/get_by_id', err); // non-fatal
    }
  }

  // ── 5. Upsert connection + cards ────────────────────────────────────────────
  const connectionId = 'p_' + itemId.slice(-16);
  const instName = institution?.name || 'Bank';
  const connData = {
    id: connectionId,
    type: 'plaid',
    label: instName,
    institutionName: instName,
    institutionId,
    institutionUrl,
    itemId,
    primaryColor,
    logo,
    lastSync: new Date().toISOString().slice(0, 10),
    syncStatus: creditAccounts.length ? 'ok' : 'no_credit_accounts',
    syncError: creditAccounts.length ? null : 'No credit card accounts found at this institution',
    cardIds: [],
  };
  {
    const { data: saved, error: connErr } = await supabase
      .from('connections').upsert({ id: connectionId, user_id: user.id, data: connData }).select('id');
    if (connErr || !saved?.length) {
      console.error('[plaid-exchange] connection upsert FAILED:', connErr?.message || '0 rows');
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not save connection' }) };
    }
  }

  // Existing cards for re-link continuity (match by mask+institution)
  const { data: existingCardRows } = await supabase
    .from('cards').select('id, data').eq('user_id', user.id);
  const existingCards = (existingCardRows || []).map(r => r.data).filter(Boolean);

  const savedCards = [];
  for (const acc of creditAccounts) {
    const match = existingCards.find(c =>
      c.plaidAccountId === acc.account_id ||
      (acc.mask && c.last4 === acc.mask && (c.connectionId === connectionId || c.institutionName === instName)));
    const card = mapPlaidAccountToCard(acc, connectionId, match || null, { id: institutionId, name: instName });
    const { data: saved, error: cardErr } = await supabase
      .from('cards').upsert({ id: card.id, user_id: user.id, data: card }).select('id');
    if (cardErr || !saved?.length) console.error('[plaid-exchange] card upsert FAILED for', card.id, ':', cardErr?.message || '0 rows');
    else savedCards.push(card);
  }
  connData.cardIds = savedCards.map(c => c.id);
  await supabase.from('connections').update({ data: connData }).eq('id', connectionId).eq('user_id', user.id).select('id');

  console.log('[plaid-exchange] SUCCESS — connection', connectionId, '| item', itemId, '| cards saved:', savedCards.length);
  return {
    statusCode: 200, headers: CORS,
    body: JSON.stringify({
      connectionId,
      institutionName: instName,
      cards: savedCards,
      cardsSaved: savedCards.length,
      allAccountTypes: accounts.map(a => ({ type: a.type, subtype: a.subtype, name: a.name })),
    }),
  };
};
