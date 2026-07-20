const https = require('https');
const fs = require('fs');
const path = require('path');

function getCertOptions() {
  const certB64 = process.env.TELLER_CERT_B64 || '';
  const keyB64 = process.env.TELLER_KEY_B64 || '';
  if (certB64 && keyB64) {
    const cert = Buffer.from(certB64, 'base64').toString('utf8');
    const key  = Buffer.from(keyB64, 'base64').toString('utf8');
    console.log('[cert] source: b64 | loaded: true | cert bytes:', cert.length, '| key bytes:', key.length);
    return { cert, key };
  }

  const certPath = process.env.TELLER_CERT_PATH || '';
  const keyPath = process.env.TELLER_KEY_PATH || '';
  if (!certPath || !keyPath) {
    console.error('[cert] source: none | loaded: false — no B64 or PATH vars set');
    return {};
  }

  // If the env var itself contains PEM data, use it directly
  if (certPath.includes('-----BEGIN') && keyPath.includes('-----BEGIN')) {
    const cert = certPath.replace(/\\n/g, '\n');
    const key  = keyPath.replace(/\\n/g, '\n');
    console.log('[cert] source: path-inline | loaded: true | cert bytes:', cert.length, '| key bytes:', key.length);
    return { cert, key };
  }

  // Try multiple base directories — process.cwd() is unreliable in AWS Lambda
  const baseDirs = [
    process.cwd(),
    __dirname,
    path.join(__dirname, '..', '..', '..'),
    path.join(__dirname, '..', '..'),
    '/var/task',
  ];

  for (const base of baseDirs) {
    try {
      const cert = fs.readFileSync(path.resolve(base, certPath));
      const key  = fs.readFileSync(path.resolve(base, keyPath));
      console.log('[cert] source: path | loaded: true | base:', base, '| cert bytes:', cert.length, '| key bytes:', key.length);
      return { cert, key };
    } catch (_) {
      // try next base
    }
  }

  console.error('[cert] source: path | loaded: false — tried bases:', baseDirs.join(', '), '| certPath:', certPath);
  return {};
}

// Raw single attempt — no retry
function _doRequest(urlPath, accessToken) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(accessToken + ':').toString('base64');
    const options = {
      hostname: 'api.teller.io',
      path: urlPath,
      method: 'GET',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json',
      },
      ...getCertOptions(),
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(data); } catch (_) {}

        // 429 — rate limited; signal for retry
        if (res.statusCode === 429) {
          const err = new Error('too_many_requests');
          err.status = 429;
          return reject(err);
        }

        if (res.statusCode === 401 || res.statusCode === 403) {
          const code = body?.error?.code || '';
          const msg  = body?.error?.message || '';
          const disconnected =
            code.startsWith('enrollment.disconnected') ||
            code === 'enrollment.not_found';
          // Include both code and message so callers can show the full context
          const detail = [code, msg].filter(Boolean).join(': ') || `Teller ${res.statusCode}: ${data.slice(0, 200)}`;
          const err = new Error(detail);
          err.status = res.statusCode;
          err.disconnected = disconnected;
          err.tellerCode = code;
          return reject(err);
        }

        if (res.statusCode >= 400) {
          const code = body?.error?.code || '';
          const msg  = body?.error?.message || '';
          const detail = [code, msg].filter(Boolean).join(': ') || `Teller API ${res.statusCode}: ${data.slice(0, 200)}`;
          const err = new Error(detail);
          err.status = res.statusCode;
          err.tellerCode = code;
          err.disconnected = code.startsWith('enrollment.disconnected') || code === 'enrollment.not_found';
          return reject(err);
        }

        if (!body) return reject(new Error('Invalid JSON from Teller'));
        resolve(body);
      });
    });

    req.on('error', (e) => {
      console.error('[teller-client] HTTPS request error:', e.message);
      reject(e);
    });
    req.end();
  });
}

// Retry wrapper — retries up to 3x on 429 with exponential backoff (2s, 4s, 8s)
async function tellerRequest(urlPath, accessToken, retries) {
  const maxRetries = (retries !== undefined) ? retries : 3;
  let lastErr;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
      console.warn(`[teller-client] 429 rate limited — retrying ${urlPath} in ${delay}ms (attempt ${attempt}/${maxRetries})`);
      await new Promise(r => setTimeout(r, delay));
    }

    try {
      return await _doRequest(urlPath, accessToken);
    } catch (err) {
      if (err.status === 429 && attempt < maxRetries) {
        lastErr = err;
        continue; // retry
      }
      throw err; // non-429, disconnected, or retries exhausted
    }
  }

  throw lastErr;
}

function guessIssuer(acc) {
  const instId = (acc.institution?.id || '').toLowerCase();
  const name = (acc.institution?.name || acc.name || '').toLowerCase();
  if (instId === 'american_express' || name.includes('amex') || name.includes('american express')) return 'amex';
  if (instId === 'chase' || name.includes('chase')) return 'chase';
  if (instId === 'citi' || name.includes('citi')) return 'citi';
  if (instId === 'capital_one' || name.includes('capital one')) return 'capone';
  if (instId === 'discover' || name.includes('discover')) return 'disc';
  if (instId === 'bank_of_america' || name.includes('bank of america')) return 'boa';
  if (instId === 'wells_fargo' || name.includes('wells fargo')) return 'wells';
  if (instId === 'us_bank' || name.includes('us bank')) return 'usb';
  if (instId === 'barclays' || name.includes('barclays')) return 'barc';
  return 'other';
}

function mapAccountToCard(acc, connectionId, balance) {
  const ledger = parseFloat(balance?.ledger ?? 0);
  const available = parseFloat(balance?.available ?? 0);
  const limit = ledger + available || 0;
  return {
    id: 'teller_' + acc.id.slice(-8),
    issuerId: guessIssuer(acc),
    name: acc.name || (acc.institution?.name + ' Card'),
    last4: acc.last_four || '????',
    limit: Math.round(limit),
    balance: Math.round(ledger),
    statementClose: null,
    dueDate: null,
    minPayment: 0,
    apr: null,
    annualFee: 0,
    annualFeeMonth: null,
    autopay: false,
    status: acc.status === 'open' ? 'active' : (acc.status || 'active'),
    notes: '',
    rewardsType: '',
    rewardsNotes: '',
    syncMethod: 'teller',
    connectionId,
    lastSync: new Date().toISOString().slice(0, 10),
    syncStatus: 'ok',
    syncError: null,
    tellerAccountId: acc.id,
  };
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

module.exports = { tellerRequest, guessIssuer, mapAccountToCard, getCertOptions, CORS };
