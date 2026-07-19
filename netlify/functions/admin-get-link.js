/**
 * Admin-only: generates an onboarding link for a user.
 *
 * 1. Creates the account (new user) or updates existing user — sets must_set_password:true.
 * 2. Generates a Supabase magic-link token via the admin API.
 * 3. Returns a /auth/confirm URL containing token_hash + type=email.
 *    The /auth/confirm page calls verifyOtp() to establish the session.
 *    initAuth() then detects must_set_password and shows the "Create password" modal.
 *
 * POST { email } — requires Authorization: Bearer <admin-jwt>
 * Returns { link, email }
 */
const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

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

  const email = (body.email || '').trim().toLowerCase();
  if (!email) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'email is required' }) };

  const SITE_URL = process.env.URL || 'https://cardos-manager.netlify.app';

  // Add to allowed list
  await supabase.from('allowed_emails').upsert(
    { email, invited_by: caller.id },
    { onConflict: 'email', ignoreDuplicates: true }
  );

  // Check if user exists
  const { data: listData } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  const existingUser = (listData?.users || []).find(u => u.email?.toLowerCase() === email);

  if (!existingUser) {
    // Step 1: Create account with must_set_password flag
    const { error: createErr } = await supabase.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { must_set_password: true },
    });
    if (createErr) {
      console.error('[admin-get-link] createUser error:', createErr.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not create account: ' + createErr.message }) };
    }
  } else {
    // Existing user — flag them to set a new password on next login
    await supabase.auth.admin.updateUserById(existingUser.id, {
      user_metadata: { must_set_password: true },
    });
  }

  // Step 2: Generate magic-link token — redirectTo is /auth/confirm
  const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email,
    options: { redirectTo: `${SITE_URL}/auth/confirm` },
  });

  if (linkErr) {
    console.error('[admin-get-link] generateLink error:', linkErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: linkErr.message }) };
  }

  // Step 3: Build the /auth/confirm URL using the hashed_token
  // The confirm page calls verifyOtp({ token_hash, type:'email' }) to create the session.
  const hashed_token = linkData?.properties?.hashed_token;
  if (!hashed_token) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'No token returned — check Supabase service key permissions' }) };
  }

  const link = `${SITE_URL}/?token_hash=${encodeURIComponent(hashed_token)}&type=email`;

  console.log('[admin-get-link] onboarding link for', email, '| new:', !existingUser, '| by', caller.email);
  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ link, type: existingUser ? 'recovery' : 'invite', email }),
  };
};
