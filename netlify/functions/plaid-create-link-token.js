// /link/token/create (plaid.com/docs/api/link/#linktokencreate).
//
// New links: products=['transactions'] with transactions.days_requested=730 —
// the documented MAXIMUM. This is a one-way door: it cannot be changed once the
// Item exists (only /item/remove + full re-link). Docs state the only penalty
// for 730 is a longer initial historical poll; there is no stated extra cost.
//
// Update mode: pass { connectionId } — the stored access_token is looked up
// server-side (ownership verified). The client NEVER supplies or receives an
// access token. redirect_uri must be sent on update-mode tokens too.
const { CORS, getPlaidClient, getSupabaseAdmin, getUserFromJWT, plaidErrorInfo, logPlaidOk } = require('./lib/plaid-client');

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
  const { connectionId } = body;

  // Registered redirect URIs are the site roots WITH trailing slash — the
  // token's redirect_uri must match a registered value exactly.
  const redirectUri = (process.env.URL || 'https://cardos-manager.netlify.app').replace(/\/$/, '') + '/';

  const request = {
    client_name: 'CardOS',
    user: { client_user_id: user.id },
    language: 'en',
    country_codes: ['US'],
    redirect_uri: redirectUri,
    // Item-level webhook — set at birth so every Item reports
    // SYNC_UPDATES_AVAILABLE / ITEM_LOGIN_REQUIRED to the receiver
    webhook: (process.env.URL || 'https://cardos-manager.netlify.app').replace(/\/$/, '') + '/.netlify/functions/plaid-webhook',
  };

  if (connectionId) {
    // ── Update mode: ownership-verified lookup of the stored token ──────────
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

    request.access_token = enr.access_token; // update mode — do NOT set products
  } else {
    // ── New link ─────────────────────────────────────────────────────────────
    request.products = ['transactions'];
    request.transactions = { days_requested: 730 };
  }

  const plaid = getPlaidClient();
  try {
    const resp = await plaid.linkTokenCreate(request);
    logPlaidOk('/link/token/create', resp);
    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ link_token: resp.data.link_token, expiration: resp.data.expiration, updateMode: !!connectionId }),
    };
  } catch (err) {
    const info = plaidErrorInfo('/link/token/create', err);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'link token creation failed', plaid: info }) };
  }
};
