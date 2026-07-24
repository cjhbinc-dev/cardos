/**
 * Approves an access request:
 * 1. Adds email to allowed_emails table
 * 2. Creates user account via Supabase admin
 * 3. Sends invite email via Supabase (user sets their own password via the link)
 * 4. Marks request as approved
 *
 * POST { email }
 * Authorization: Bearer <admin-jwt> — the caller's verified email MUST equal
 * ADMIN_EMAIL. (Previously gated on a shared secret that was hardcoded in the
 * frontend — a client-visible string that let anyone self-approve access.)
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

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) {}

  const { email } = body;
  if (!email) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'email required' }) };

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase not configured' }) };
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // Server-side admin gate: the verified JWT's email must equal ADMIN_EMAIL.
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Authorization required' }) };
  const { data: { user }, error: authErr } = await supabase.auth.getUser(jwt);
  if (authErr || !user) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid session' }) };
  const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (!adminEmail || (user.email || '').trim().toLowerCase() !== adminEmail) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Admin only' }) };
  }
  const approverId = user.id;

  const normalizedEmail = email.trim().toLowerCase();

  // 1. Add to allowed_emails
  const { error: allowErr } = await supabase.from('allowed_emails').upsert({
    email: normalizedEmail,
    invited_by: approverId,
  }, { onConflict: 'email', ignoreDuplicates: true });
  if (allowErr) {
    console.error('[approve-access] allowed_emails upsert error:', allowErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Failed to add to allow list: ' + allowErr.message }) };
  }

  // 2. Send Supabase invite email (creates account + sends set-password link)
  const SITE_URL = process.env.URL || 'https://cardos-manager.netlify.app';
  const { data: inviteData, error: inviteErr } = await supabase.auth.admin.inviteUserByEmail(normalizedEmail, {
    redirectTo: SITE_URL,
  });

  let inviteNote = null;
  if (inviteErr) {
    // User might already exist — that's fine, just note it
    inviteNote = inviteErr.message.includes('already been registered')
      ? 'User already has an account'
      : 'Invite email failed: ' + inviteErr.message;
    console.warn('[approve-access] invite warning:', inviteNote);
  } else {
    console.log('[approve-access] invite sent to:', normalizedEmail, '| userId:', inviteData?.user?.id);
  }

  // 3. Mark request as approved
  await supabase.from('access_requests').update({
    status: 'approved',
    approved_at: new Date().toISOString(),
    approved_by: approverId,
  }).eq('email', normalizedEmail);

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      ok: true,
      email: normalizedEmail,
      inviteNote,
      message: inviteNote || 'Invite email sent — they can set their password via the link.',
    }),
  };
};
