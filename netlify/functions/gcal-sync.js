/**
 * Syncs card due dates and statement close dates to Google Calendar.
 * Creates or updates events for each card.
 * Adds 3-day and 1-day reminders to payment due events.
 * Idempotent — safe to call multiple times (uses stable event IDs).
 */
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const CALENDAR_ID = 'primary';

function stableId(prefix, cardId) {
  // Google Calendar requires event IDs to be [a-v0-9] max 1024 chars
  return (prefix + cardId).toLowerCase().replace(/[^a-v0-9]/g, '').slice(0, 60);
}

function toGCalDate(isoDate) {
  return { date: isoDate };
}

async function getAuthClient(supabase) {
  const { data: row } = await supabase
    .from('connections').select('data').eq('id', 'google_oauth').single();
  if (!row?.data?.refreshToken) throw new Error('Google not connected');

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'https://cardos-manager.netlify.app/.netlify/functions/google-oauth-callback'
  );
  auth.setCredentials({
    access_token: row.data.accessToken,
    refresh_token: row.data.refreshToken,
    expiry_date: row.data.tokenExpiry,
  });
  auth.on('tokens', async (tokens) => {
    if (tokens.access_token) {
      await supabase.from('connections').update({
        data: { ...row.data, accessToken: tokens.access_token, tokenExpiry: tokens.expiry_date }
      }).eq('id', 'google_oauth');
    }
  });
  return auth;
}

async function upsertEvent(calendar, eventId, event) {
  try {
    // Try update first
    await calendar.events.update({
      calendarId: CALENDAR_ID,
      eventId,
      resource: event,
    });
    return 'updated';
  } catch (e) {
    if (e.code === 404) {
      // Create if not found
      await calendar.events.insert({
        calendarId: CALENDAR_ID,
        resource: { ...event, id: eventId },
      });
      return 'created';
    }
    throw e;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  let auth;
  try {
    auth = await getAuthClient(supabase);
  } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: e.message, hint: 'Connect Google at /.netlify/functions/google-oauth-start' }) };
  }

  const calendar = google.calendar({ version: 'v3', auth });
  const { data: cardRows } = await supabase.from('cards').select('data');
  const cards = (cardRows || []).map(r => r.data).filter(c => c.status !== 'closed');

  const results = { created: 0, updated: 0, errors: [] };

  for (const c of cards) {
    const cardLabel = `${c.name} ••${c.last4}`;

    // Payment due event
    if (c.dueDate) {
      try {
        const action = await upsertEvent(calendar, stableId('due', c.id), {
          summary: `💳 ${cardLabel} — Payment Due`,
          description: [
            `Minimum payment: $${c.minPayment || 0}`,
            `Current balance: $${c.balance || 0}`,
            c.autopay ? 'Autopay: ON' : '⚠️ Autopay: OFF — manual payment required',
          ].join('\n'),
          start: toGCalDate(c.dueDate),
          end: toGCalDate(c.dueDate),
          colorId: c.autopay ? '2' : '11', // sage if autopay, tomato if not
          reminders: {
            useDefault: false,
            overrides: [
              { method: 'popup', minutes: 3 * 24 * 60 },  // 3 days
              { method: 'popup', minutes: 1 * 24 * 60 },  // 1 day
              { method: 'email', minutes: 3 * 24 * 60 },  // 3-day email
            ],
          },
        });
        results[action]++;
      } catch (e) {
        results.errors.push({ card: cardLabel, type: 'due', error: e.message });
      }
    }

    // Statement close event
    if (c.statementClose) {
      try {
        const action = await upsertEvent(calendar, stableId('close', c.id), {
          summary: `📊 ${cardLabel} — Statement Closes`,
          description: [
            `Balance: $${c.balance || 0}`,
            `Utilization: ${c.limit ? Math.round(c.balance / c.limit * 100) : 0}%`,
            'Pay before this date to lower reported utilization.',
          ].join('\n'),
          start: toGCalDate(c.statementClose),
          end: toGCalDate(c.statementClose),
          colorId: '5', // banana
          reminders: {
            useDefault: false,
            overrides: [{ method: 'popup', minutes: 24 * 60 }], // 1 day
          },
        });
        results[action]++;
      } catch (e) {
        results.errors.push({ card: cardLabel, type: 'close', error: e.message });
      }
    }

    // Annual fee event
    if (c.annualFee && c.annualFeeMonth) {
      const year = new Date().getFullYear();
      const feeDate = `${year}-${String(c.annualFeeMonth).padStart(2, '0')}-01`;
      try {
        const action = await upsertEvent(calendar, stableId('fee', c.id), {
          summary: `💸 ${cardLabel} — Annual Fee $${c.annualFee}`,
          description: `Annual fee of $${c.annualFee} charges this month.\nCall issuer for retention offer — often waived or offset with credits.`,
          start: toGCalDate(feeDate),
          end: toGCalDate(feeDate),
          colorId: '6', // tangerine
          reminders: {
            useDefault: false,
            overrides: [
              { method: 'popup', minutes: 30 * 24 * 60 },  // 30 days
              { method: 'email', minutes: 30 * 24 * 60 },
            ],
          },
        });
        results[action]++;
      } catch (e) {
        results.errors.push({ card: cardLabel, type: 'fee', error: e.message });
      }
    }
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify(results) };
};
