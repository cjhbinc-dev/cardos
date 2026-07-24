// Billing kill switch. /item/remove is the ONLY way to end a Transactions
// subscription (plaid.com/docs/api/items/#itemremove: "Required to end
// subscription billing for the Item").
//
// Order of operations is deliberate:
//   verify ownership → /item/remove at Plaid → only then delete local rows.
// If /item/remove fails, the enrollment row (and its access_token) is KEPT —
// deleting it would orphan a live billable subscription with no way to stop it.
//
// Accepts { connectionId } (normal user delete path) or { itemId } (direct
// cleanup; admins may remove any item, others only their own).
const { CORS, getPlaidClient, getSupabaseAdmin, getUserFromJWT, plaidErrorInfo, logPlaidOk } = require('./lib/plaid-client');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase not configured' }) };
  }

  const supabase = getSupabaseAdmin();
  const user = await getUserFromJWT(supabase, event);
  if (!user) return { statusCodes: 401, statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Authorization required' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }
  const { connectionId, itemId } = body;
  if (!connectionId && !itemId) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'connectionId or itemId required' }) };
  }

  const isAdmin = (process.env.ADMIN_EMAIL || '').trim().toLowerCase() === (user.email || '').trim().toLowerCase();

  // ── Resolve the enrollment (ownership enforced) ─────────────────────────────
  let enrollment = null;
  let connRow = null;

  if (connectionId) {
    const { data: conn, error: connErr } = await supabase
      .from('connections').select('id, user_id, data')
      .eq('id', connectionId).eq('user_id', user.id).maybeSingle();
    if (connErr) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: connErr.message }) };
    if (!conn) return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Connection not found or not yours' }) };
    connRow = conn;
    const itemFromConn = conn.data?.itemId;
    if (!itemFromConn) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Connection has no Plaid itemId' }) };
    const { data: enr, error: enrErr } = await supabase
      .from('enrollments').select('id, item_id, access_token, user_id')
      .eq('item_id', itemFromConn).eq('user_id', user.id).maybeSingle();
    if (enrErr) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: enrErr.message }) };
    enrollment = enr;
  } else {
    let q = supabase.from('enrollments').select('id, item_id, access_token, user_id').eq('item_id', itemId);
    if (!isAdmin) q = q.eq('user_id', user.id); // admins may clean up any item
    const { data: enr, error: enrErr } = await q.maybeSingle();
    if (enrErr) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: enrErr.message }) };
    if (!enr) return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Item not found or not yours' }) };
    enrollment = enr;
    const { data: conns } = await supabase
      .from('connections').select('id, user_id, data')
      .eq('user_id', enr.user_id).eq('data->>itemId', enr.item_id);
    connRow = (conns || [])[0] || null;
  }

  // ── Call Plaid /item/remove BEFORE any local deletion ───────────────────────
  let plaidRemoved = false;
  if (enrollment?.access_token) {
    const plaid = getPlaidClient();
    try {
      const resp = await plaid.itemRemove({ access_token: enrollment.access_token });
      logPlaidOk('/item/remove', resp);
      plaidRemoved = true;
    } catch (err) {
      const info = plaidErrorInfo('/item/remove', err);
      // ITEM_NOT_FOUND / INVALID_ACCESS_TOKEN mean the Item is already gone at
      // Plaid — safe to clean up locally. Anything else: keep the token.
      if (info.error_code === 'ITEM_NOT_FOUND' || info.error_code === 'INVALID_ACCESS_TOKEN') {
        console.warn('[plaid-remove-item] item already gone at Plaid — proceeding with local cleanup');
        plaidRemoved = true;
      } else {
        console.error('[plaid-remove-item] KEEPING enrollment row — /item/remove failed; the subscription may still be billing. Retry required.');
        return {
          statusCode: 502, headers: CORS,
          body: JSON.stringify({
            error: 'Plaid /item/remove failed — nothing was deleted. Retry, or contact support with the request_id.',
            plaid: info,
          }),
        };
      }
    }
  } else if (enrollment) {
    // No token stored (shouldn't happen) — nothing to remove at Plaid
    console.warn('[plaid-remove-item] enrollment has no access_token; local cleanup only');
    plaidRemoved = true;
  }

  // ── Local cleanup (only after Plaid removal succeeded) ─────────────────────
  const ownerId = enrollment?.user_id || user.id;
  const cleanup = { enrollment: 0, connection: 0, cards: 0, transactions: 0, history: 0 };

  if (connRow) {
    const { data: cardRows } = await supabase
      .from('cards').select('id')
      .eq('user_id', ownerId).eq('data->>connectionId', connRow.id);
    const cardIds = (cardRows || []).map(c => c.id);
    if (cardIds.length) {
      const { data: delTx } = await supabase.from('transactions').delete().in('card_id', cardIds).eq('user_id', ownerId).select('id');
      cleanup.transactions = (delTx || []).length;
      const { data: delHist } = await supabase.from('balance_history').delete().in('card_id', cardIds).eq('user_id', ownerId).select('id');
      cleanup.history = (delHist || []).length;
      const { data: delCards } = await supabase.from('cards').delete().in('id', cardIds).eq('user_id', ownerId).select('id');
      cleanup.cards = (delCards || []).length;
    }
    const { data: delConn } = await supabase.from('connections').delete().eq('id', connRow.id).eq('user_id', ownerId).select('id');
    cleanup.connection = (delConn || []).length;
  }
  if (enrollment) {
    const { data: delEnr } = await supabase.from('enrollments').delete().eq('id', enrollment.id).select('id');
    cleanup.enrollment = (delEnr || []).length;
  }

  console.log('[plaid-remove-item] done — plaidRemoved:', plaidRemoved, '| cleanup:', JSON.stringify(cleanup));
  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, plaidRemoved, cleanup }) };
};
