const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) {}

  const email = (body.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Valid email required' }) };
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase not configured' }) };
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // Check if email is already in allowed_emails (already approved)
  const { data: existing } = await supabase
    .from('allowed_emails').select('email').ilike('email', email).maybeSingle();
  if (existing) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, alreadyApproved: true }) };
  }

  // Upsert into access_requests (idempotent — same email just refreshes the request)
  const { error } = await supabase.from('access_requests').upsert({
    email,
    status: 'pending',
    requested_at: new Date().toISOString(),
  }, { onConflict: 'email', ignoreDuplicates: false });

  if (error) {
    console.error('[request-access] upsert error:', error.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Failed to save request: ' + error.message }) };
  }

  console.log('[request-access] new request from:', email);
  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
};
