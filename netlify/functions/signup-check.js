const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (_) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { email, password } = body;
  if (!email || !password) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Email and password are required' }) };
  }
  if (password.length < 8) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Password must be at least 8 characters' }) };
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase not configured' }) };
  }

  const emailLower = email.trim().toLowerCase();
  const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // Admin email is always allowed (bootstrap — lets the admin create their first account)
  let allowed = adminEmail && emailLower === adminEmail;

  if (!allowed) {
    // Check the allowed_emails table in Supabase
    const { data, error } = await supabase
      .from('allowed_emails')
      .select('email')
      .ilike('email', emailLower)
      .maybeSingle();

    if (error) {
      console.error('[signup-check] allowed_emails lookup error:', error.message);
      // Fail CLOSED: if the allowlist can't be read, only an explicit ALLOWED_EMAILS
      // env entry gets in. An empty list must never mean "everyone".
      const envList = (process.env.ALLOWED_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
      allowed = envList.includes(emailLower);
    } else {
      allowed = !!data;
    }
  }

  if (!allowed) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Access restricted — invite only' }) };
  }

  // Create the user with email auto-confirmed (no verification email)
  const { data: userData, error: createErr } = await supabase.auth.admin.createUser({
    email: email.trim(),
    password,
    email_confirm: true,
  });

  if (createErr) {
    const msg = createErr.message || '';
    if (msg.includes('already been registered') || msg.includes('already exists') || msg.includes('duplicate')) {
      return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: 'An account with this email already exists. Try signing in.' }) };
    }
    console.error('[signup-check] createUser error:', msg);
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: msg }) };
  }

  console.log('[signup-check] Created user:', userData.user.id, '|', email.trim());
  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, userId: userData.user.id }) };
};
