/**
 * Admin API for managing the allowed_emails invite list.
 * All requests require Authorization: Bearer <supabase-jwt>
 * and the JWT must belong to the ADMIN_EMAIL user.
 *
 * GET  → list all allowed emails
 * POST { action: 'add',    email } → add email to list
 * POST { action: 'remove', email } → remove email from list
 */
const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

async function getUser(supabase, event) {
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase not configured' }) };
  }

  const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (!adminEmail) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'ADMIN_EMAIL env var not set' }) };
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const user = await getUser(supabase, event);
  if (!user) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized — sign in first' }) };
  }
  if (user.email.toLowerCase() !== adminEmail) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Admin access only' }) };
  }

  // ── GET: list all allowed emails ────────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    const { data, error } = await supabase
      .from('allowed_emails')
      .select('id, email, created_at')
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[admin-emails] list error:', error.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ emails: data || [] }) };
  }

  // ── POST: add or remove email ────────────────────────────────────────────────
  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch (_) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    const { action, email } = body;
    if (!action || !email) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'action and email are required' }) };
    }

    const emailClean = email.trim().toLowerCase();

    if (action === 'add') {
      const { data, error } = await supabase
        .from('allowed_emails')
        .upsert({ email: emailClean, invited_by: user.id }, { onConflict: 'email' })
        .select()
        .single();

      if (error) {
        console.error('[admin-emails] add error:', error.message);
        return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
      }
      console.log('[admin-emails] added:', emailClean, 'by', user.email);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, record: data }) };
    }

    if (action === 'remove') {
      const { error } = await supabase
        .from('allowed_emails')
        .delete()
        .ilike('email', emailClean);

      if (error) {
        console.error('[admin-emails] remove error:', error.message);
        return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
      }
      console.log('[admin-emails] removed:', emailClean, 'by', user.email);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    if (action === 'delete-request') {
      const { error } = await supabase
        .from('access_requests')
        .delete()
        .ilike('email', emailClean);

      if (error) {
        console.error('[admin-emails] delete-request error:', error.message);
        return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
      }
      console.log('[admin-emails] deleted request:', emailClean, 'by', user.email);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown action — use add, remove, or delete-request' }) };
  }

  return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
};
