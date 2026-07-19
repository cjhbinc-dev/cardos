/**
 * Returns pending access requests. Admin only (JWT required, must match ADMIN_EMAIL).
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

  // Verify caller is admin
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const jwt = authHeader.replace('Bearer ', '').trim();
  if (!jwt) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Authorization required' }) };

  const { data: { user }, error: userErr } = await supabase.auth.getUser(jwt);
  if (userErr || !user) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid session' }) };

  const adminEmail = (process.env.ADMIN_EMAIL || '').toLowerCase();
  if (!adminEmail || user.email?.toLowerCase() !== adminEmail) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Admin only' }) };
  }

  const { data: requests, error } = await supabase
    .from('access_requests')
    .select('email, status, requested_at')
    .order('requested_at', { ascending: false });

  if (error) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ requests: requests || [] }),
  };
};
