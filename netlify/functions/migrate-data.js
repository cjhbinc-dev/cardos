/**
 * Assigns all rows with user_id IS NULL to the specified user.
 *
 * Admin mode (no JWT needed):
 *   POST { secret: MIGRATION_SECRET, email: "user@example.com" }
 *
 * User mode (JWT required):
 *   POST {} with Authorization: Bearer <jwt>
 */
const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

const TABLES = ['cards', 'connections', 'offers', 'balance_history', 'transactions', 'enrollments'];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase not configured' }) };
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) {}

  let userId;

  // Admin mode: secret + email
  const migrationSecret = process.env.MIGRATION_SECRET;
  if (body.secret && migrationSecret && body.secret === migrationSecret && body.email) {
    const { data: usersData, error: listErr } = await supabase.auth.admin.listUsers();
    if (listErr) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not list users: ' + listErr.message }) };
    }
    const match = (usersData?.users || []).find(u => u.email?.toLowerCase() === body.email.toLowerCase());
    if (!match) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'No user found with email: ' + body.email }) };
    }
    userId = match.id;
    console.log('[migrate-data] admin mode — email:', body.email, '| userId:', userId);
  } else {
    // User mode: JWT
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    const jwt = authHeader.replace('Bearer ', '').trim();
    if (!jwt) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Provide either {secret, email} or Authorization: Bearer <jwt>' }) };
    }
    const { data: { user }, error: userErr } = await supabase.auth.getUser(jwt);
    if (userErr || !user) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid or expired session' }) };
    }
    userId = user.id;
    console.log('[migrate-data] JWT mode — userId:', userId);
  }

  const results = {};
  for (const table of TABLES) {
    try {
      // Count how many orphaned rows exist first
      const { count: orphanCount } = await supabase
        .from(table)
        .select('*', { count: 'exact', head: true })
        .is('user_id', null);

      if (!orphanCount) {
        results[table] = { claimed: 0 };
        continue;
      }

      // Claim them
      const { error } = await supabase
        .from(table)
        .update({ user_id: userId })
        .is('user_id', null);

      if (error) {
        results[table] = { error: error.message };
      } else {
        results[table] = { claimed: orphanCount };
      }
    } catch (e) {
      results[table] = { error: e.message };
    }
  }

  console.log('[migrate-data] done | userId:', userId, '| results:', JSON.stringify(results));
  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ ok: true, userId, results }),
  };
};
