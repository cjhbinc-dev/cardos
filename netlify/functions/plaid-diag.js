// TEMP diagnostic — Phase 0 smoke test + Phase 4/5 debugging.
// Gated by MIGRATION_SECRET. Calls /institutions/get (count 3) and returns the
// raw response. No secrets in the response. Remove in the Phase 6 sweep.
const { getPlaidClient, plaidErrorInfo, logPlaidOk } = require('./lib/plaid-client');

exports.handler = async (event) => {
  const secret = event.queryStringParameters?.secret || '';
  if (!process.env.MIGRATION_SECRET || secret !== process.env.MIGRATION_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }
  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Plaid env not configured', hasClientId: !!process.env.PLAID_CLIENT_ID, hasSecret: !!process.env.PLAID_SECRET, env: process.env.PLAID_ENV || null }) };
  }
  const plaid = getPlaidClient();

  // mode=accounts&item=<item_id>: raw /accounts/get for a stored enrollment
  // (Phase 4 balance-mapping evidence). Token stays server-side.
  if (event.queryStringParameters?.mode === 'accounts') {
    const itemId = event.queryStringParameters?.item || '';
    const { getSupabaseAdmin } = require('./lib/plaid-client');
    const supabase = getSupabaseAdmin();
    const { data: enr } = await supabase.from('enrollments').select('access_token').eq('item_id', itemId).maybeSingle();
    if (!enr?.access_token) return { statusCode: 404, body: JSON.stringify({ error: 'item not found' }) };
    try {
      const resp = await plaid.accountsGet({ access_token: enr.access_token });
      logPlaidOk('/accounts/get (diag)', resp);
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(resp.data, null, 2) };
    } catch (err) {
      const info = plaidErrorInfo('/accounts/get (diag)', err);
      return { statusCode: 502, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'accounts failed', plaid: info }) };
    }
  }

  try {
    const resp = await plaid.institutionsGet({ count: 3, offset: 0, country_codes: ['US'] });
    logPlaidOk('/institutions/get', resp);
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(resp.data, null, 2) };
  } catch (err) {
    const info = plaidErrorInfo('/institutions/get', err);
    return { statusCode: 502, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'smoke test failed', plaid: info }) };
  }
};
