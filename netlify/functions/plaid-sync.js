// Balance refresh for one connection via /accounts/get — the FREE cached-
// balance endpoint (plaid.com/docs/api/accounts/: "free to use and retrieves
// cached information"). We deliberately do NOT call /accounts/balance/get,
// which bills $0.10/call. Cached balances update ~daily on Transactions items.
//
// On ITEM_LOGIN_REQUIRED: marks the connection disconnected and returns
// { disconnected: true } with HTTP 200 — the frontend renders Reconnect.
const { CORS, getPlaidClient, getSupabaseAdmin, getUserFromJWT, plaidErrorInfo, logPlaidOk, mapPlaidAccountToCard } = require('./lib/plaid-client');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase not configured' }) };
  }

  const supabase = getSupabaseAdmin();
  const user = await getUserFromJWT(supabase, event);
  if (!user) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Authorization required' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }
  const { connectionId } = body;
  if (!connectionId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'connectionId required' }) };

  // Ownership-verified lookups, no fallbacks
  const { data: conn, error: connErr } = await supabase
    .from('connections').select('id, user_id, data')
    .eq('id', connectionId).eq('user_id', user.id).maybeSingle();
  if (connErr) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: connErr.message }) };
  if (!conn) return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Connection not found or not yours' }) };
  const itemId = conn.data?.itemId;
  if (!itemId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Connection has no Plaid itemId' }) };

  const { data: enr, error: enrErr } = await supabase
    .from('enrollments').select('access_token')
    .eq('item_id', itemId).eq('user_id', user.id).maybeSingle();
  if (enrErr) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: enrErr.message }) };
  if (!enr?.access_token) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'No stored access token for this connection' }) };

  const plaid = getPlaidClient();
  let accounts;
  try {
    const resp = await plaid.accountsGet({ access_token: enr.access_token });
    logPlaidOk('/accounts/get', resp);
    accounts = resp.data.accounts || [];
  } catch (err) {
    const info = plaidErrorInfo('/accounts/get', err);
    if (info.error_code === 'ITEM_LOGIN_REQUIRED' || info.error_code === 'PENDING_EXPIRATION' || info.error_code === 'PENDING_DISCONNECT') {
      const updated = { ...conn.data, syncStatus: 'disconnected', syncError: 'Bank connection needs to be re-linked' };
      await supabase.from('connections').update({ data: updated }).eq('id', connectionId).eq('user_id', user.id).select('id');
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ disconnected: true, plaid: { error_code: info.error_code, request_id: info.request_id } }) };
    }
    const updated = { ...conn.data, syncStatus: 'error', syncError: info.error_code };
    await supabase.from('connections').update({ data: updated }).eq('id', connectionId).eq('user_id', user.id).select('id');
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Sync failed', plaid: info }) };
  }

  const creditAccounts = accounts.filter(a => a.type === 'credit');

  // Load this user's cards for the connection, update balances
  const { data: cardRows } = await supabase
    .from('cards').select('id, data')
    .eq('user_id', user.id).eq('data->>connectionId', connectionId);
  const cards = (cardRows || []).map(r => r.data).filter(Boolean);

  const updated = [];
  for (const acc of creditAccounts) {
    const existing = cards.find(c => c.plaidAccountId === acc.account_id || c.id === acc.account_id)
      || cards.find(c => acc.mask && c.last4 === acc.mask) || null;
    const card = mapPlaidAccountToCard(acc, connectionId, existing);
    const { data: saved, error: cardErr } = await supabase
      .from('cards').upsert({ id: card.id, user_id: user.id, data: card }).select('id');
    if (cardErr || !saved?.length) console.error('[plaid-sync] card upsert FAILED for', card.id, ':', cardErr?.message || '0 rows');
    else updated.push({ id: card.id, last4: card.last4, balance: card.balance, limit: card.limit });
  }

  const connData = { ...conn.data, lastSync: new Date().toISOString().slice(0, 10), syncStatus: 'ok', syncError: null };
  const { data: connSaved, error: connUpdErr } = await supabase
    .from('connections').update({ data: connData }).eq('id', connectionId).eq('user_id', user.id).select('id');
  if (connUpdErr || !connSaved?.length) console.warn('[plaid-sync] connection update failed:', connUpdErr?.message || '0 rows');

  console.log('[plaid-sync] ok —', updated.length, 'cards updated for connection', connectionId);
  return { statusCode: 200, headers: CORS, body: JSON.stringify({ updated, accounts: creditAccounts.length }) };
};
