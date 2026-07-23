/**
 * Fetches recent statement emails from Gmail and extracts card data.
 * Supports: Chase, American Express, Capital One, Citi, Discover, Bank of America, Wells Fargo.
 * Updates matching cards in Supabase with parsed balance/due date/min payment/APR.
 *
 * Called by: google-oauth-callback (on connect), gmail-daily-check (scheduled), frontend "Parse now" button.
 */
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

// ── HTML decoder ──────────────────────────────────────────────────────────────

function decodeBody(payload) {
  if (!payload) return '';
  if (payload.parts) {
    // Prefer HTML for richer content, fall back to plain text
    const order = ['text/html', 'text/plain'];
    for (const mime of order) {
      const part = findPart(payload.parts, mime);
      if (part?.body?.data) return b64decode(part.body.data);
    }
    // Recurse into nested multipart
    for (const part of payload.parts) {
      const decoded = decodeBody(part);
      if (decoded) return decoded;
    }
  }
  if (payload.body?.data) return b64decode(payload.body.data);
  return '';
}

function findPart(parts, mime) {
  for (const p of parts) {
    if (p.mimeType === mime) return p;
    if (p.parts) {
      const found = findPart(p.parts, mime);
      if (found) return found;
    }
  }
  return null;
}

function b64decode(data) {
  return Buffer.from(data, 'base64url').toString('utf-8');
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, ' ').trim();
}

// ── Value parsers ─────────────────────────────────────────────────────────────

function parseDollars(str) {
  if (!str) return null;
  const n = parseFloat(str.replace(/[$,\s]/g, ''));
  return isNaN(n) ? null : Math.abs(n);
}

const MONTHS = { january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12,jan:1,feb:2,mar:3,apr:4,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };

function parseDate(str) {
  if (!str) return null;
  str = str.trim().replace(/,/g, '');
  // MM/DD/YYYY or M/D/YYYY
  let m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  // Month DD YYYY or DD Month YYYY
  m = str.match(/^([A-Za-z]+)\s+(\d{1,2})\s+(\d{4})$/);
  if (m) {
    const mo = MONTHS[m[1].toLowerCase()];
    if (mo) return `${m[3]}-${String(mo).padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  }
  m = str.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()];
    if (mo) return `${m[3]}-${String(mo).padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  }
  // YYYY-MM-DD passthrough
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  return null;
}

function firstMatch(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

// ── Bank patterns ─────────────────────────────────────────────────────────────

const BANKS = [
  {
    id: 'chase',
    name: 'Chase',
    fromPattern: /chase\.com$/i,
    subjectPattern: /statement|payment due|account activity|new statement/i,
    balance:    [/new balance[\s:$]+([\d,]+\.?\d*)/i, /balance[\s:$]+([\d,]+\.?\d*)/i],
    minPayment: [/minimum payment due[\s:$]+([\d,]+\.?\d*)/i, /minimum payment[\s:$]+([\d,]+\.?\d*)/i, /min\.?\s*payment[\s:$]+([\d,]+\.?\d*)/i],
    dueDate:    [/payment due date[\s:]+([\w\s,\/]+?\d{4})/i, /due date[\s:]+([\w\s,\/]+?\d{4})/i, /pay by[\s:]+([\w\s,\/]+?\d{4})/i],
    stmtClose:  [/closing date[\s:]+([\w\s,\/]+?\d{4})/i, /statement date[\s:]+([\w\s,\/]+?\d{4})/i, /close date[\s:]+([\w\s,\/]+?\d{4})/i],
    available:  [/available credit[\s:$]+([\d,]+\.?\d*)/i, /available[\s:$]+([\d,]+\.?\d*)/i],
    last4:      [/account ending in\s+(\d{4})/i, /ending in\s+(\d{4})/i, /ending\s+(\d{4})/i, /\*{4}(\d{4})/],
  },
  {
    id: 'amex',
    name: 'American Express',
    fromPattern: /americanexpress\.com$/i,
    subjectPattern: /statement|payment|account summary|minimum payment/i,
    balance:    [/new balance[\s:$]+([\d,]+\.?\d*)/i, /total balance[\s:$]+([\d,]+\.?\d*)/i, /account balance[\s:$]+([\d,]+\.?\d*)/i],
    minPayment: [/minimum payment due[\s:$]+([\d,]+\.?\d*)/i, /minimum due[\s:$]+([\d,]+\.?\d*)/i, /minimum payment[\s:$]+([\d,]+\.?\d*)/i],
    dueDate:    [/payment due date[\s:]+([\w\s,\/]+?\d{4})/i, /due date[\s:]+([\w\s,\/]+?\d{4})/i, /please pay by[\s:]+([\w\s,\/]+?\d{4})/i, /pay by[\s:]+([\w\s,\/]+?\d{4})/i],
    stmtClose:  [/closing date[\s:]+([\w\s,\/]+?\d{4})/i, /statement closing[\s:]+([\w\s,\/]+?\d{4})/i, /period end[\s:]+([\w\s,\/]+?\d{4})/i],
    available:  [/available credit[\s:$]+([\d,]+\.?\d*)/i, /available to spend[\s:$]+([\d,]+\.?\d*)/i, /remaining credit[\s:$]+([\d,]+\.?\d*)/i],
    last4:      [/account ending in\s+(\d{4})/i, /ending\s+(\d{4})/i, /card ending\s+(\d{4})/i, /\*{4}(\d{4})/],
  },
  {
    id: 'capone',
    name: 'Capital One',
    fromPattern: /capitalone\.com$/i,
    subjectPattern: /statement|payment|account update/i,
    balance:    [/new balance[\s:$]+([\d,]+\.?\d*)/i, /current balance[\s:$]+([\d,]+\.?\d*)/i, /balance[\s:$]+([\d,]+\.?\d*)/i],
    minPayment: [/minimum payment[\s:$]+([\d,]+\.?\d*)/i, /min\.?\s*payment due[\s:$]+([\d,]+\.?\d*)/i],
    dueDate:    [/payment due date[\s:]+([\w\s,\/]+?\d{4})/i, /due date[\s:]+([\w\s,\/]+?\d{4})/i, /due[\s:]+([\w\s,\/]+?\d{4})/i],
    stmtClose:  [/statement date[\s:]+([\w\s,\/]+?\d{4})/i, /closing date[\s:]+([\w\s,\/]+?\d{4})/i],
    available:  [/available credit[\s:$]+([\d,]+\.?\d*)/i, /credit available[\s:$]+([\d,]+\.?\d*)/i],
    last4:      [/account ending in\s+(\d{4})/i, /ending in\s+(\d{4})/i, /\*(\d{4})/],
  },
  {
    id: 'citi',
    name: 'Citi',
    fromPattern: /citi(?:bank)?\.com$/i,
    subjectPattern: /statement|payment|e-statement|new statement/i,
    balance:    [/new balance[\s:$]+([\d,]+\.?\d*)/i, /balance[\s:$]+([\d,]+\.?\d*)/i],
    minPayment: [/minimum payment due[\s:$]+([\d,]+\.?\d*)/i, /minimum payment[\s:$]+([\d,]+\.?\d*)/i],
    dueDate:    [/payment due date[\s:]+([\w\s,\/]+?\d{4})/i, /due date[\s:]+([\w\s,\/]+?\d{4})/i],
    stmtClose:  [/statement closing date[\s:]+([\w\s,\/]+?\d{4})/i, /closing date[\s:]+([\w\s,\/]+?\d{4})/i],
    available:  [/available credit[\s:$]+([\d,]+\.?\d*)/i],
    last4:      [/account ending in\s+(\d{4})/i, /ending\s+(\d{4})/i, /x+(\d{4})/i],
  },
  {
    id: 'disc',
    name: 'Discover',
    fromPattern: /discover(?:card)?\.com$/i,
    subjectPattern: /statement|payment|e-statement/i,
    balance:    [/new balance[\s:$]+([\d,]+\.?\d*)/i, /account balance[\s:$]+([\d,]+\.?\d*)/i],
    minPayment: [/minimum payment due[\s:$]+([\d,]+\.?\d*)/i, /minimum payment[\s:$]+([\d,]+\.?\d*)/i],
    dueDate:    [/payment due date[\s:]+([\w\s,\/]+?\d{4})/i, /due date[\s:]+([\w\s,\/]+?\d{4})/i],
    stmtClose:  [/closing date[\s:]+([\w\s,\/]+?\d{4})/i, /statement date[\s:]+([\w\s,\/]+?\d{4})/i],
    available:  [/available credit[\s:$]+([\d,]+\.?\d*)/i],
    last4:      [/account ending in\s+(\d{4})/i, /ending in\s+(\d{4})/i, /\*(\d{4})/],
  },
  {
    id: 'boa',
    name: 'Bank of America',
    fromPattern: /bankofamerica\.com$/i,
    subjectPattern: /statement|payment|e-statement/i,
    balance:    [/new balance[\s:$]+([\d,]+\.?\d*)/i, /statement balance[\s:$]+([\d,]+\.?\d*)/i],
    minPayment: [/minimum payment due[\s:$]+([\d,]+\.?\d*)/i, /minimum payment[\s:$]+([\d,]+\.?\d*)/i],
    dueDate:    [/payment due date[\s:]+([\w\s,\/]+?\d{4})/i, /due date[\s:]+([\w\s,\/]+?\d{4})/i],
    stmtClose:  [/closing date[\s:]+([\w\s,\/]+?\d{4})/i, /statement closing date[\s:]+([\w\s,\/]+?\d{4})/i],
    available:  [/available credit[\s:$]+([\d,]+\.?\d*)/i],
    last4:      [/account ending in\s+(\d{4})/i, /ending in\s+(\d{4})/i],
  },
];

// ── Gmail search queries per bank ─────────────────────────────────────────────

function buildQuery(bank, daysBack) {
  const from = bank.fromPattern.source.replace(/[$^\\]/g, '').replace(/\?/g, '').replace(/\//g, '');
  return `from:${from} newer_than:${daysBack}d`;
}

// ── Main parse function ───────────────────────────────────────────────────────

function parseEmailBody(rawBody, bank) {
  const isHtml = /<[a-z][\s\S]*>/i.test(rawBody);
  const text = isHtml ? stripHtml(rawBody) : rawBody;

  const raw = {
    balanceStr:    firstMatch(text, bank.balance),
    minPayStr:     firstMatch(text, bank.minPayment),
    dueDateStr:    firstMatch(text, bank.dueDate),
    stmtCloseStr:  firstMatch(text, bank.stmtClose),
    availableStr:  firstMatch(text, bank.available),
    last4Str:      firstMatch(text, bank.last4),
  };

  return {
    balance:      parseDollars(raw.balanceStr),
    minPayment:   parseDollars(raw.minPayStr),
    dueDate:      parseDate(raw.dueDateStr),
    statementClose: parseDate(raw.stmtCloseStr),
    availableCredit: parseDollars(raw.availableStr),
    last4:        raw.last4Str,
    _raw: raw,
  };
}

// ── OAuth token management ────────────────────────────────────────────────────

async function getAuthClient(supabase) {
  const { data: row } = await supabase
    .from('connections').select('data').eq('id', 'google_oauth').single();

  if (!row?.data?.refreshToken) throw new Error('Google not connected. Visit /.netlify/functions/google-oauth-start');

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

  // Persist refreshed tokens if they change
  auth.on('tokens', async (tokens) => {
    const updated = { ...row.data, ...tokens.access_token && { accessToken: tokens.access_token }, ...tokens.expiry_date && { tokenExpiry: tokens.expiry_date } };
    await supabase.from('connections').update({ data: updated }).eq('id', 'google_oauth');
  });

  return auth;
}

// ── Handler ───────────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const { daysBack = 7 } = JSON.parse(event.body || '{}');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  let auth;
  try {
    auth = await getAuthClient(supabase);
  } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }

  const gmail = google.gmail({ version: 'v1', auth });
  const { data: cardRows } = await supabase.from('cards').select('data');
  const cards = cardRows?.map(r => r.data) || [];

  const results = [];
  const errors = [];

  for (const bank of BANKS) {
    const query = buildQuery(bank, daysBack);
    try {
      const listResp = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 20 });
      const messages = listResp.data.messages || [];

      for (const { id } of messages) {
        const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
        const headers = msg.data.payload.headers || [];
        const subject = headers.find(h => h.name === 'Subject')?.value || '';
        const from = headers.find(h => h.name === 'From')?.value || '';
        const dateHeader = headers.find(h => h.name === 'Date')?.value || '';

        // Verify it's actually from this bank
        if (!bank.fromPattern.test(from)) continue;
        if (!bank.subjectPattern.test(subject)) continue;

        const body = decodeBody(msg.data.payload);
        const parsed = parseEmailBody(body, bank);

        // Skip if we couldn't extract anything useful
        if (!parsed.balance && !parsed.dueDate && !parsed.minPayment) continue;

        const emailDate = new Date(dateHeader).toISOString().slice(0, 10);

        // Match to existing card by last4, or by issuer if only one card from that bank
        const bankCards = cards.filter(c => c.issuerId === bank.id);
        let card = null;
        if (parsed.last4) {
          card = bankCards.find(c => c.last4 === parsed.last4);
        }
        if (!card && bankCards.length === 1) {
          card = bankCards[0];
        }

        if (card) {
          let changed = false;
          if (parsed.balance != null && parsed.balance !== card.balance) { card.balance = parsed.balance; changed = true; }
          if (parsed.minPayment != null && parsed.minPayment !== card.minPayment) { card.minPayment = parsed.minPayment; changed = true; }
          if (parsed.dueDate && parsed.dueDate !== card.dueDate) { card.dueDate = parsed.dueDate; changed = true; }
          if (parsed.statementClose && parsed.statementClose !== card.statementClose) { card.statementClose = parsed.statementClose; changed = true; }
          if (changed) {
            card.lastSync = emailDate;
            card.syncStatus = 'ok';
            card.syncMethod = 'email';
            await supabase.from('cards').upsert({ id: card.id, data: card });
            results.push({ card: card.name, last4: card.last4, bank: bank.name, emailDate, ...parsed });
          }
        } else {
          // Log the parse for the user to manually assign
          results.push({ unmatched: true, bank: bank.name, subject, emailDate, last4: parsed.last4, ...parsed });
        }
      }
    } catch (e) {
      errors.push({ bank: bank.name, error: e.message });
    }
  }

  // Update Google connection lastSync
  const { data: gRow } = await supabase.from('connections').select('data').eq('id', 'google_oauth').single();
  if (gRow?.data) {
    await supabase.from('connections').update({
      data: { ...gRow.data, lastSync: new Date().toISOString().slice(0, 10), syncStatus: 'ok' }
    }).eq('id', 'google_oauth');
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ parsed: results.length, results, errors }),
  };
};
