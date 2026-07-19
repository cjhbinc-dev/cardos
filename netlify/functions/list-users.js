/**
 * Admin-only: returns all Supabase Auth users with their app_metadata (features/permissions).
 * GET — requires Authorization: Bearer <admin-jwt>
 */
const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

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

  const { data: usersData, error } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };

  const users = (usersData?.users || []).map(u => ({
    id: u.id,
    email: u.email,
    createdAt: u.created_at,
    lastSignIn: u.last_sign_in_at,
    features: u.app_metadata?.features || null,
    confirmed: !!u.email_confirmed_at,
  }));

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ users }) };
};
