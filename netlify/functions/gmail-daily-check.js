/**
 * Scheduled function — runs daily at 8:00 AM UTC.
 * Calls gmail-parse-emails to ingest new statement emails,
 * then triggers push + email notifications for upcoming due dates.
 * Schedule configured in netlify.toml.
 */
exports.handler = async () => {
  const BASE = 'https://cardos-manager.netlify.app/.netlify/functions';

  const results = {};

  // 1. Parse new statement emails (last 2 days to avoid re-processing)
  try {
    const r = await fetch(`${BASE}/gmail-parse-emails`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ daysBack: 2 }),
    });
    results.emailParse = await r.json();
    console.log('Email parse:', results.emailParse);
  } catch (e) {
    results.emailParseError = e.message;
  }

  // 2. Sync all Teller connections
  try {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: connRows } = await supabase.from('connections').select('data');
    const tellerConns = (connRows || []).map(r => r.data).filter(c => c.type === 'teller' && c.enrollmentId);

    for (const conn of tellerConns) {
      const r = await fetch(`${BASE}/teller-sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: conn.id }),
      });
      const syncResult = await r.json();
      console.log(`Teller sync ${conn.label}:`, syncResult);
    }
    results.tellerSynced = tellerConns.length;
  } catch (e) {
    results.tellerSyncError = e.message;
  }

  // 3. Send due date notifications
  try {
    const r = await fetch(`${BASE}/notify-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'due-dates' }),
    });
    results.notifications = await r.json();
  } catch (e) {
    results.notificationError = e.message;
  }

  // 4. Send push notifications
  try {
    const r = await fetch(`${BASE}/push-daily`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    results.push = await r.json();
  } catch (e) {
    results.pushError = e.message;
  }

  // 5. Sync Google Calendar
  try {
    const r = await fetch(`${BASE}/gcal-sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    results.gcal = await r.json();
  } catch (e) {
    results.gcalError = e.message;
  }

  console.log('Daily check complete:', JSON.stringify(results, null, 2));
  return { statusCode: 200, body: JSON.stringify(results) };
};
