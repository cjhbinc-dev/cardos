const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  // ── Auth: admin only ───────────────────────────────────────────────────────
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const _authHeader = event.headers.authorization || event.headers.Authorization || '';
  const _jwt = _authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!_jwt) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Authorization required' }) };
  const { data: { user: _caller }, error: _callerErr } = await supabase.auth.getUser(_jwt);
  if (_callerErr || !_caller) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid session' }) };
  const _adminEmail = (process.env.ADMIN_EMAIL || '').toLowerCase();
  if (!_adminEmail || _caller.email?.toLowerCase() !== _adminEmail) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Admin only' }) };
  }
  // ── End Auth ───────────────────────────────────────────────────────────────

  // POST: mark a single item as read
  if (event.httpMethod === 'POST') {
    const { action, id } = JSON.parse(event.body || '{}');
    if (action === 'mark_read' && id) {
      await supabase.from('feedback').update({ status: 'read' }).eq('id', id);
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
  }

  // GET: list all feedback
  const { data, error } = await supabase
    .from('feedback')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(500);

  if (error) {
    if (error.code === '42P01') {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ feedback: [], missing_table: true }) };
    }
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ feedback: data || [] }) };
};
