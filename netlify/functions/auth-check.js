/**
 * Password validation for the CardOS app.
 * Returns a daily HMAC token on success so the browser can re-verify
 * without sending the raw password again.
 * Set APP_PASSWORD env var in Netlify to enable; omit to disable auth.
 */
const crypto = require('crypto');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const APP_PASSWORD = process.env.APP_PASSWORD;

  // Auth disabled — allow everything
  if (!APP_PASSWORD) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ token: 'no-auth', disabled: true }) };
  }

  const { password, token } = JSON.parse(event.body || '{}');

  // Daily token — rotates at midnight UTC
  const day = Math.floor(Date.now() / 86400000);
  const validToken = crypto.createHmac('sha256', APP_PASSWORD).update(`cardos:${day}`).digest('hex');

  // Allow re-auth via stored token (avoids re-entering password each day)
  if (token && token === validToken) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ token: validToken }) };
  }

  if (password !== APP_PASSWORD) {
    // Constant-time comparison to prevent timing attacks
    const fake = crypto.createHmac('sha256', 'fake').update(`cardos:${day}`).digest('hex');
    crypto.timingSafeEqual(Buffer.from(validToken), Buffer.from(fake));
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Incorrect password' }) };
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ token: validToken }) };
};
