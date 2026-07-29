// Scheduled daily at 8:00 AM UTC via netlify.toml
// Sends email alerts for due dates, statement closes, high utilization.
// Multi-user: sends each user their own alerts at their registered email.
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T12:00:00Z');
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return Math.round((d - today) / 86400000);
}

function fmt(n) {
  return '$' + (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2 });
}

function utilPct(card) {
  if (!card.limit) return 0;
  return Math.round((card.balance / card.limit) * 100);
}

function buildMime(to, from, subject, html) {
  const boundary = 'cardos_' + Date.now();
  const msg = [
    `From: CardOS <${from}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    html,
    `--${boundary}--`,
  ].join('\r\n');
  return Buffer.from(msg).toString('base64url');
}

async function getGmailClient(supabase) {
  const { data: row } = await supabase
    .from('connections').select('data').eq('id', 'google_oauth').single();
  if (!row?.data?.refreshToken) return null;

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
      try {
        await supabase.from('connections').update({
          data: { ...row.data, accessToken: tokens.access_token, tokenExpiry: tokens.expiry_date }
        }).eq('id', 'google_oauth');
      } catch (_) {}
    }
  });
  return { gmail: google.gmail({ version: 'v1', auth }), email: row.data.email };
}

async function sendViaGmail(gmail, fromEmail, toEmail, subject, html) {
  const raw = buildMime(toEmail, fromEmail, subject, html);
  await gmail.users.messages.send({ userId: 'me', resource: { raw } });
}

function buildEmail({ sections }) {
  const sectionHtml = sections.map(s => `
    <div style="background:#111520;border:1px solid #252d45;border-radius:12px;overflow:hidden;margin-bottom:16px">
      <div style="background:#1f2540;padding:10px 16px;font-size:11px;font-weight:700;color:#7e8aaa;text-transform:uppercase;letter-spacing:.07em">${s.heading}</div>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px">
        <tr style="background:#181d2e"><th style="padding:8px 16px;text-align:left;color:#7e8aaa;font-size:11px">${s.headers.join('</th><th style="padding:8px 16px;text-align:left;color:#7e8aaa;font-size:11px">')}</th></tr>
        ${s.rows.join('')}
      </table>
    </div>`).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif;background:#0b0e15;color:#e8eaf2;margin:0;padding:0">
  <div style="max-width:600px;margin:0 auto;padding:32px 16px">
    <div style="text-align:center;margin-bottom:28px">
      <div style="display:inline-block;background:linear-gradient(135deg,#5b7fff,#a78bfa);padding:10px 20px;border-radius:10px;font-size:20px;font-weight:800;color:#fff;letter-spacing:-0.5px">CardOS</div>
    </div>
    ${sectionHtml}
    <div style="text-align:center;margin:24px 0">
      <a href="https://cardos-manager.netlify.app" style="display:inline-block;background:#5b7fff;color:#fff;text-decoration:none;padding:12px 32px;border-radius:8px;font-weight:600">Open CardOS →</a>
    </div>
    <p style="color:#3d4860;font-size:11px;text-align:center">CardOS · cardos-manager.netlify.app</p>
  </div>
</body></html>`;
}

function cardRow(c, labelHtml, extra = '') {
  return `<tr style="border-bottom:1px solid #1a2035">
    <td style="padding:12px 16px"><strong style="color:#e8eaf2">${c.name}</strong> <span style="color:#7e8aaa">••${c.last4}</span></td>
    ${labelHtml}
    <td style="padding:12px 16px;color:#e8eaf2">${fmt(c.minPayment)}</td>
    <td style="padding:12px 16px;color:#e8eaf2">${fmt(c.balance)}</td>
    <td style="padding:12px 16px"><span style="color:${c.autopay ? '#22d98a' : '#f5a623'}">${c.autopay ? '✓ Auto' : '⚠ Manual'}</span></td>
    ${extra}
  </tr>`;
}

async function trySendGrid(to, subject, html) {
  const key = process.env.SENDGRID_API_KEY;
  if (!key) return false;
  try {
    const sg = require('@sendgrid/mail');
    sg.setApiKey(key);
    await sg.send({ to, from: { email: 'noreply@cardos-manager.netlify.app', name: 'CardOS' }, subject, html });
    return true;
  } catch (e) {
    console.error('SendGrid fallback failed:', e.message);
    return false;
  }
}

async function sendAlertsForUser(supabase, userEmail, cards, gmailCtx) {
  if (!cards.length) return [];

  const activeCards = cards.filter(c => c.status === 'active');
  const sent = [];
  const headers7 = ['Card', 'Due In', 'Min. Due', 'Balance', 'Autopay'];
  const headers0 = ['Card', 'Due', 'Min. Due', 'Balance', 'Autopay'];

  async function send(subject, html) {
    let ok = false;
    if (gmailCtx) {
      try {
        await sendViaGmail(gmailCtx.gmail, gmailCtx.email, userEmail, subject, html);
        ok = true;
      } catch (e) {
        console.error('Gmail send failed:', e.message);
      }
    }
    if (!ok) ok = await trySendGrid(userEmail, subject, html);
    if (!ok) {
      try {
        await supabase.from('notifications').upsert({
          id: 'notif_' + Date.now(),
          data: { subject, sentAt: new Date().toISOString(), status: 'pending_delivery', to: userEmail, html }
        });
      } catch (_) {}
    }
    return ok;
  }

  const due7 = activeCards.filter(c => daysUntil(c.dueDate) === 7);
  if (due7.length) {
    const html = buildEmail({ sections: [{ heading: 'Payment Due in 7 Days', headers: headers7, rows: due7.map(c => cardRow(c, `<td style="padding:12px 16px;color:#5b7fff;font-weight:700">7 days</td>`)) }] });
    if (await send(`CardOS — ${due7.length} payment${due7.length > 1 ? 's' : ''} due in 7 days`, html)) sent.push('7-day');
  }

  const due3 = activeCards.filter(c => daysUntil(c.dueDate) === 3);
  if (due3.length) {
    const html = buildEmail({ sections: [{ heading: '⚠️ Payment Due in 3 Days', headers: headers7, rows: due3.map(c => cardRow(c, `<td style="padding:12px 16px;color:#f5a623;font-weight:700">3 days</td>`)) }] });
    if (await send(`CardOS — ${due3.length} payment${due3.length > 1 ? 's' : ''} due in 3 days`, html)) sent.push('3-day');
  }

  const due0 = activeCards.filter(c => daysUntil(c.dueDate) === 0);
  if (due0.length) {
    const html = buildEmail({ sections: [{ heading: '🚨 Payment Due TODAY', headers: headers0, rows: due0.map(c => cardRow(c, `<td style="padding:12px 16px;color:#ff5757;font-weight:800">TODAY</td>`)) }] });
    if (await send(`CardOS — ${due0.length} payment${due0.length > 1 ? 's' : ''} due TODAY`, html)) sent.push('day-of');
  }

  const close3 = activeCards.filter(c => daysUntil(c.statementClose) === 3);
  if (close3.length) {
    const rows = close3.map(c => `<tr style="border-bottom:1px solid #1a2035">
      <td style="padding:12px 16px"><strong style="color:#e8eaf2">${c.name}</strong> <span style="color:#7e8aaa">••${c.last4}</span></td>
      <td style="padding:12px 16px;color:#f5a623;font-weight:700">${utilPct(c)}%</td>
      <td style="padding:12px 16px;color:#e8eaf2">${fmt(c.balance)}</td>
      <td style="padding:12px 16px;color:#e8eaf2">${fmt(c.limit)}</td>
    </tr>`);
    const html = buildEmail({ sections: [{ heading: 'Statement Closing in 3 Days', headers: ['Card', 'Utilization', 'Balance', 'Limit'], rows }] });
    if (await send(`CardOS — statement${close3.length > 1 ? 's' : ''} closing in 3 days`, html)) sent.push('stmt-close-3day');
  }

  const close0 = activeCards.filter(c => daysUntil(c.statementClose) === 0);
  if (close0.length) {
    const rows = close0.map(c => `<tr style="border-bottom:1px solid #1a2035">
      <td style="padding:12px 16px"><strong style="color:#e8eaf2">${c.name}</strong> <span style="color:#7e8aaa">••${c.last4}</span></td>
      <td style="padding:12px 16px;color:#ff5757;font-weight:700">${utilPct(c)}%</td>
      <td style="padding:12px 16px;color:#e8eaf2">${fmt(c.balance)}</td>
      <td style="padding:12px 16px;color:#e8eaf2">${fmt(c.limit)}</td>
    </tr>`);
    const html = buildEmail({ sections: [{ heading: '📊 Statement Closing Today', headers: ['Card', 'Utilization', 'Balance', 'Limit'], rows }] });
    if (await send(`CardOS — statement${close0.length > 1 ? 's' : ''} closing today`, html)) sent.push('stmt-close-today');
  }

  const today = new Date().toISOString().slice(0, 10);
  const highUtil = activeCards.filter(c => !c.isBusiness && c.limit > 0 && utilPct(c) > 30 && c.lastSync === today);
  if (highUtil.length) {
    const rows = highUtil.map(c => {
      const pct = utilPct(c);
      return `<tr style="border-bottom:1px solid #1a2035">
        <td style="padding:12px 16px"><strong style="color:#e8eaf2">${c.name}</strong> <span style="color:#7e8aaa">••${c.last4}</span></td>
        <td style="padding:12px 16px;color:${pct >= 50 ? '#ff5757' : '#f5a623'};font-weight:700">${pct}%</td>
        <td style="padding:12px 16px;color:#e8eaf2">${fmt(c.balance)} / ${fmt(c.limit)}</td>
        <td style="padding:12px 16px;color:#7e8aaa">${c.dueDate || '—'}</td>
      </tr>`;
    });
    const html = buildEmail({ sections: [{ heading: '⚠️ High Utilization Alert — Above 30%', headers: ['Card', 'Utilization', 'Balance / Limit', 'Due Date'], rows }] });
    if (await send(`CardOS — high utilization on ${highUtil.length} card${highUtil.length > 1 ? 's' : ''}`, html)) sent.push('util-alert');
  }

  return sent;
}

// A genuine Netlify scheduled invocation POSTs a JSON body containing next_run.
// Any other (manual/HTTP) trigger must present ?secret=MIGRATION_SECRET — the same
// gate the other crons (backup-daily, plaid-daily-sync) use. Without it this
// endpoint is a public button that emails every user and reveals who has alerts.
function isAuthorizedInvocation(event) {
  let scheduled = false;
  try { scheduled = !!JSON.parse(event?.body || '{}').next_run; } catch (_) {}
  if (scheduled) return true;
  const provided = (event?.queryStringParameters || {}).secret;
  return !!(provided && process.env.MIGRATION_SECRET && provided === process.env.MIGRATION_SECRET);
}

exports.handler = async (event) => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, body: 'Supabase not configured' };
  }
  if (!isAuthorizedInvocation(event)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const gmailCtx = await getGmailClient(supabase).catch(() => null);

  // Get all users
  const { data: usersData, error: usersErr } = await supabase.auth.admin.listUsers();
  if (usersErr) {
    // Do NOT fall back to emailing all cards to one inbox — that mixes users'
    // data. Fail the run instead so it can be retried.
    console.error('Failed to list users:', usersErr.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Could not list users', detail: usersErr.message }) };
  }

  const users = usersData?.users || [];
  const allSent = [];

  for (const user of users) {
    const email = user.email;
    if (!email) continue;

    const { data: cardRows } = await supabase
      .from('cards').select('data').eq('user_id', user.id);
    const cards = (cardRows || []).map(r => r.data).filter(Boolean);

    if (!cards.length) continue;

    const sent = await sendAlertsForUser(supabase, email, cards, gmailCtx);
    if (sent.length) allSent.push({ email, triggers: sent });
    console.log(`[notify] ${email}: ${sent.length ? sent.join(', ') : 'nothing triggered'}`);
  }

  console.log('Daily notify complete:', allSent.length, 'users notified');
  return { statusCode: 200, body: JSON.stringify({ usersNotified: allSent.length, detail: allSent }) };
};
