// Feedback submission — strict auth (same pattern as the Plaid functions):
// verify the JWT, scope the row to the verified user_id, never trust a
// client-supplied identity. Emails NOTIFICATION_EMAIL on success. Metadata is
// app/context only (version, view, UA, viewport) — never financial data.
const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

const CATEGORIES = ['bug', 'feature', 'looks_wrong', 'other'];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Not configured' }) };
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Authorization required' }) };
  const { data: { user }, error: authErr } = await supabase.auth.getUser(jwt);
  if (authErr || !user) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid session' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }
  const message = (body.message || '').trim();
  if (!message) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'A message is required' }) };
  const category = CATEGORIES.includes(body.category) ? body.category : 'other';

  // Whitelist metadata — app/context only, never anything from financial data.
  const m = body.metadata || {};
  const metadata = {
    appVersion: typeof m.appVersion === 'string' ? m.appVersion.slice(0, 60) : null,
    view: typeof m.view === 'string' ? m.view.slice(0, 40) : null,
    userAgent: typeof m.userAgent === 'string' ? m.userAgent.slice(0, 300) : null,
    viewport: typeof m.viewport === 'string' ? m.viewport.slice(0, 20) : null,
    screenshotPath: typeof m.screenshotPath === 'string' ? m.screenshotPath.slice(0, 200) : null,
  };

  const { data: saved, error: insErr } = await supabase.from('feedback').insert({
    user_id: user.id,
    category,
    message: message.slice(0, 5000),
    metadata,
    status: 'new',
  }).select('id').single();

  if (insErr) {
    console.error('[feedback] insert failed:', insErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not save your feedback. Please try again.' }) };
  }

  // Notify (best-effort — a mail failure must not fail the submission)
  if (process.env.SENDGRID_API_KEY && process.env.NOTIFICATION_EMAIL) {
    try {
      sgMail.setApiKey(process.env.SENDGRID_API_KEY);
      await sgMail.send({
        to: process.env.NOTIFICATION_EMAIL,
        from: process.env.NOTIFICATION_EMAIL,
        subject: `CardOS feedback: ${category}`,
        text: `From: ${user.email}\nCategory: ${category}\nView: ${metadata.view || '-'}\nVersion: ${metadata.appVersion || '-'}\n\n${message}`,
      });
    } catch (mailErr) {
      console.warn('[feedback] notification email failed:', mailErr.message);
    }
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, id: saved.id }) };
};
