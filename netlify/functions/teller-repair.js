/**
 * GET /.netlify/functions/teller-repair?userId=<uuid>
 *
 * Finds all Teller enrollments that belong to this user's connections
 * but are missing a user_id (orphaned), and sets user_id on them.
 *
 * This happens when the Teller Connect flow completes but the user's
 * JWT was not present at enroll time, so the enrollment row was saved
 * without a user_id and later queries (filtered by user_id) miss it.
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

  // ── Auth: require valid Supabase JWT; userId param must match caller ───────
  const _authHeader = event.headers.authorization || event.headers.Authorization || '';
  const _jwt = _authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!_jwt) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Authorization required' }) };
  const { data: { user: _caller }, error: _callerErr } = await supabase.auth.getUser(_jwt);
  if (_callerErr || !_caller) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid session' }) };
  // ── End Auth ───────────────────────────────────────────────────────────────

  const userId = _caller.id;
  if (!userId) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'userId query param required' }) };
  }
  const report = { userId, fixed: [], alreadyLinked: [], noConnectionsFound: false };

  // 1. Get all connections for this user to find their enrollmentIds
  const { data: userConns, error: connErr } = await supabase
    .from('connections').select('id, data').eq('user_id', userId);

  if (connErr) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'connections query failed: ' + connErr.message }) };
  }

  const enrollmentIds = (userConns || []).map(r => r.data?.enrollmentId).filter(Boolean);

  if (!enrollmentIds.length) {
    report.noConnectionsFound = true;
    report.summary = 'No connections found for this user — nothing to repair. The user needs to reconnect their bank from scratch.';
    return { statusCode: 200, headers: CORS, body: JSON.stringify(report, null, 2) };
  }

  // 2. Look up those enrollments
  const { data: enrollments, error: enrollErr } = await supabase
    .from('enrollments').select('id, enrollment_id, institution_name, user_id')
    .in('enrollment_id', enrollmentIds);

  if (enrollErr) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'enrollments query failed: ' + enrollErr.message }) };
  }

  // 3. Fix orphaned ones (missing user_id) and also fix cards missing user_id
  for (const enrollment of (enrollments || [])) {
    if (enrollment.user_id && enrollment.user_id === userId) {
      report.alreadyLinked.push({ enrollmentId: enrollment.enrollment_id, institution: enrollment.institution_name });
      continue;
    }

    // Set user_id on the enrollment
    const { error: updateErr } = await supabase
      .from('enrollments')
      .update({ user_id: userId })
      .eq('enrollment_id', enrollment.enrollment_id);

    if (updateErr) {
      report.fixed.push({ enrollmentId: enrollment.enrollment_id, institution: enrollment.institution_name, error: updateErr.message });
      continue;
    }

    // Also fix any cards that belong to this connection but are missing user_id
    const conn = (userConns || []).find(c => c.data?.enrollmentId === enrollment.enrollment_id);
    if (conn) {
      const { data: cardRows } = await supabase.from('cards').select('id, data').eq('data->>connectionId', conn.id);
      for (const cardRow of (cardRows || [])) {
        if (!cardRow.data?.user_id) {
          await supabase.from('cards').update({ user_id: userId }).eq('id', cardRow.id);
        }
      }
    }

    report.fixed.push({ enrollmentId: enrollment.enrollment_id, institution: enrollment.institution_name, status: 'linked' });
  }

  report.summary = report.fixed.length > 0
    ? `Fixed ${report.fixed.length} orphaned enrollment(s). Sync should now work — try syncing the connection.`
    : report.alreadyLinked.length > 0
      ? 'All enrollments were already linked to this user. If sync still fails, the user may need to Reconnect.'
      : 'No matching enrollments found in the database. The user needs to reconnect their bank.';

  return { statusCode: 200, headers: CORS, body: JSON.stringify(report, null, 2) };
};
