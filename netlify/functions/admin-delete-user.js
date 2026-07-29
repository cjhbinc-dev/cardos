/**
 * Admin-only: fully deletes a user — all their data rows + auth account.
 * POST { userId } — requires Authorization: Bearer <admin-jwt>
 */
const { createClient } = require('@supabase/supabase-js');
const { getPlaidClient, plaidErrorInfo } = require('./lib/plaid-client');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

const DATA_TABLES = ['cards', 'connections', 'offers', 'balance_history', 'transactions', 'enrollments'];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase not configured' }) };
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Authorization required' }) };

  const { data: { user: caller }, error: callerErr } = await supabase.auth.getUser(jwt);
  if (callerErr || !caller) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid session' }) };

  const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (!adminEmail || caller.email?.toLowerCase() !== adminEmail) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Admin only' }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) {}

  const { userId } = body;
  if (!userId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'userId is required' }) };
  if (userId === caller.id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "You can't delete your own account" }) };

  // 0. Release every Plaid Item this user owns BEFORE deleting the tokens.
  //    Each live Item bills monthly; deleting the enrollment row without calling
  //    /item/remove first would strand an unstoppable charge.
  const plaidRemoved = [];
  const plaidConfigured = !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
  try {
    const { data: enrollRows, error: enrErr } = await supabase
      .from('enrollments').select('id, access_token').eq('user_id', userId);
    if (enrErr) {
      plaidRemoved.push('lookup error: ' + enrErr.message);
    } else if ((enrollRows || []).length && plaidConfigured) {
      const plaid = getPlaidClient();
      for (const row of enrollRows) {
        if (!row.access_token) { plaidRemoved.push((row.id || '?') + ': no token'); continue; }
        try {
          await plaid.itemRemove({ access_token: row.access_token });
          plaidRemoved.push((row.id || '?') + ': removed');
        } catch (rmErr) {
          plaidErrorInfo('/item/remove (delete-user)', rmErr);
          // Abort the delete so the token isn't lost while the Item is still billing.
          return { statusCode: 502, headers: CORS, body: JSON.stringify({
            error: 'Could not release a Plaid connection (still billing) — deletion aborted so it can be retried.',
            item: row.id, plaidRemoved,
          }) };
        }
      }
    } else if ((enrollRows || []).length && !plaidConfigured) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Plaid not configured — cannot release live Items; deletion aborted.' }) };
    }
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Plaid cleanup failed: ' + e.message }) };
  }

  // 1. Delete all data rows for this user
  const deleted = { plaidItems: plaidRemoved };
  for (const table of DATA_TABLES) {
    try {
      const { count, error } = await supabase
        .from(table)
        .delete()
        .eq('user_id', userId)
        .select('*', { count: 'exact', head: true });
      deleted[table] = error ? ('error: ' + error.message) : (count ?? 0);
    } catch (e) {
      deleted[table] = 'error: ' + e.message;
    }
  }

  // 2. Delete the auth account
  const { error: authErr } = await supabase.auth.admin.deleteUser(userId);
  if (authErr) {
    console.error('[admin-delete-user] auth delete error:', authErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: authErr.message, dataDeleted: deleted }) };
  }

  console.log('[admin-delete-user] fully deleted userId:', userId, '| by:', caller.email, '| rows:', JSON.stringify(deleted));
  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, deleted }) };
};
