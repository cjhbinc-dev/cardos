/**
 * Sends email notifications for upcoming payment due dates via SendGrid.
 * Fires at 7-day and 3-day marks before each due date.
 * Set SENDGRID_API_KEY and NOTIFICATION_EMAIL in Netlify env vars.
 */
const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T12:00:00Z');
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return Math.round((d - today) / 86400000);
}

function fmt(n) { return '$' + (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2 }); }

function buildEmailHtml(cards) {
  const urgentCards = cards.filter(c => {
    const d = daysUntil(c.dueDate);
    return d !== null && d >= 0 && d <= 7;
  }).sort((a, b) => daysUntil(a.dueDate) - daysUntil(b.dueDate));

  if (!urgentCards.length) return null;

  const rows = urgentCards.map(c => {
    const d = daysUntil(c.dueDate);
    const urgency = d <= 1 ? '#ff5757' : d <= 3 ? '#f5a623' : '#5b7fff';
    const label = d === 0 ? 'TODAY' : d === 1 ? 'TOMORROW' : `in ${d} days`;
    return `
      <tr style="border-bottom:1px solid #252d45">
        <td style="padding:12px 16px">
          <strong style="color:#e8eaf2">${c.name}</strong>
          <span style="color:#7e8aaa"> ••${c.last4}</span>
        </td>
        <td style="padding:12px 16px;color:#e8eaf2">${fmt(c.minPayment)}</td>
        <td style="padding:12px 16px;color:#e8eaf2">${fmt(c.balance)}</td>
        <td style="padding:12px 16px">
          <span style="color:${urgency};font-weight:700">${label}</span>
        </td>
        <td style="padding:12px 16px">
          <span style="color:${c.autopay ? '#22d98a' : '#f5a623'}">${c.autopay ? '✓ Autopay' : '⚠ Manual'}</span>
        </td>
      </tr>`;
  }).join('');

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif;background:#0b0e15;color:#e8eaf2;margin:0;padding:0">
  <div style="max-width:600px;margin:0 auto;padding:32px 16px">
    <div style="text-align:center;margin-bottom:32px">
      <div style="display:inline-block;background:linear-gradient(135deg,#5b7fff,#a78bfa);padding:10px 20px;border-radius:10px;font-size:20px;font-weight:800;color:#fff;letter-spacing:-0.5px">CardOS</div>
      <h2 style="color:#e8eaf2;margin:16px 0 4px">Upcoming Payment Due Dates</h2>
      <p style="color:#7e8aaa;margin:0">You have ${urgentCards.length} payment${urgentCards.length > 1 ? 's' : ''} due within 7 days</p>
    </div>

    <div style="background:#111520;border:1px solid #252d45;border-radius:12px;overflow:hidden;margin-bottom:24px">
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="background:#1f2540">
            <th style="padding:10px 16px;text-align:left;color:#7e8aaa;font-size:11px;text-transform:uppercase;letter-spacing:.07em">Card</th>
            <th style="padding:10px 16px;text-align:left;color:#7e8aaa;font-size:11px;text-transform:uppercase;letter-spacing:.07em">Min. Payment</th>
            <th style="padding:10px 16px;text-align:left;color:#7e8aaa;font-size:11px;text-transform:uppercase;letter-spacing:.07em">Balance</th>
            <th style="padding:10px 16px;text-align:left;color:#7e8aaa;font-size:11px;text-transform:uppercase;letter-spacing:.07em">Due</th>
            <th style="padding:10px 16px;text-align:left;color:#7e8aaa;font-size:11px;text-transform:uppercase;letter-spacing:.07em">Autopay</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>

    <div style="text-align:center;margin-bottom:24px">
      <a href="https://cardos-manager.netlify.app" style="display:inline-block;background:#5b7fff;color:#fff;text-decoration:none;padding:12px 32px;border-radius:8px;font-weight:600">Open CardOS →</a>
    </div>

    <p style="color:#3d4860;font-size:11px;text-align:center">
      CardOS — personal credit card manager<br>
      <a href="https://cardos-manager.netlify.app" style="color:#3d4860">cardos-manager.netlify.app</a>
    </p>
  </div>
</body>
</html>`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
  const TO_EMAIL = process.env.NOTIFICATION_EMAIL;

  if (!SENDGRID_KEY) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ skipped: true, reason: 'SENDGRID_API_KEY not set' }) };
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: cardRows } = await supabase.from('cards').select('data');
  const cards = (cardRows || []).map(r => r.data).filter(c => c.status === 'active');

  const html = buildEmailHtml(cards);
  if (!html) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ sent: false, reason: 'No upcoming due dates' }) };
  }

  const urgentCount = cards.filter(c => {
    const d = daysUntil(c.dueDate);
    return d !== null && d >= 0 && d <= 7;
  }).length;

  const sgMail = require('@sendgrid/mail');
  sgMail.setApiKey(SENDGRID_KEY);

  try {
    await sgMail.send({
      to: TO_EMAIL,
      from: { email: 'noreply@cardos-manager.netlify.app', name: 'CardOS' },
      subject: `CardOS — ${urgentCount} payment${urgentCount > 1 ? 's' : ''} due within 7 days`,
      html,
    });
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ sent: true, to: TO_EMAIL, count: urgentCount }) };
  } catch (e) {
    console.error('SendGrid error:', e.response?.body || e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
