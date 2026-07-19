/**
 * Handles Google OAuth callback after user approves access.
 * Exchanges the authorization code for access + refresh tokens
 * and stores them in Supabase for use by gmail-parse-emails and gcal-sync.
 */
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'https://cardos-manager.netlify.app/.netlify/functions/google-oauth-callback'
  );
}

const SUCCESS_HTML = (email) => `
<html><body style="font-family:sans-serif;padding:32px;background:#0b0e15;color:#e8eaf2;text-align:center">
  <div style="max-width:480px;margin:80px auto">
    <div style="font-size:48px;margin-bottom:16px">✅</div>
    <h2 style="color:#22d98a;margin-bottom:8px">Google connected!</h2>
    <p style="color:#7e8aaa">Authorized as <strong style="color:#e8eaf2">${email}</strong></p>
    <p style="color:#7e8aaa">Gmail and Google Calendar are now linked to CardOS.<br>
    Statement emails will be parsed automatically each day.<br>
    Your calendar will be updated with due dates.</p>
    <a href="https://cardos-manager.netlify.app" style="display:inline-block;margin-top:24px;padding:12px 28px;background:#5b7fff;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Back to CardOS →</a>
  </div>
</body></html>`;

const ERROR_HTML = (msg) => `
<html><body style="font-family:sans-serif;padding:32px;background:#0b0e15;color:#e8eaf2;text-align:center">
  <div style="max-width:480px;margin:80px auto">
    <div style="font-size:48px;margin-bottom:16px">❌</div>
    <h2 style="color:#ff5757">Authorization failed</h2>
    <p style="color:#7e8aaa">${msg}</p>
    <a href="https://cardos-manager.netlify.app" style="display:inline-block;margin-top:24px;padding:12px 28px;background:#5b7fff;color:#fff;border-radius:8px;text-decoration:none">Back to CardOS</a>
  </div>
</body></html>`;

exports.handler = async (event) => {
  const { code, error } = event.queryStringParameters || {};

  if (error) {
    return { statusCode: 200, headers: { 'Content-Type': 'text/html' }, body: ERROR_HTML(error) };
  }
  if (!code) {
    return { statusCode: 200, headers: { 'Content-Type': 'text/html' }, body: ERROR_HTML('No authorization code received') };
  }

  try {
    const auth = getOAuthClient();
    const { tokens } = await auth.getToken(code);
    auth.setCredentials(tokens);

    // Get the authorized user's email
    const gmail = google.gmail({ version: 'v1', auth });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const email = profile.data.emailAddress;

    // Store tokens in Supabase connections table
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    await supabase.from('connections').upsert({
      id: 'google_oauth',
      data: {
        id: 'google_oauth',
        type: 'google_oauth',
        label: `Google — ${email}`,
        email,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        tokenExpiry: tokens.expiry_date,
        scopes: tokens.scope,
        lastSync: new Date().toISOString().slice(0, 10),
        syncStatus: 'ok',
      },
    });

    // Immediately do a first parse of statement emails
    await fetch('https://cardos-manager.netlify.app/.netlify/functions/gmail-parse-emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ daysBack: 60 }), // scan last 60 days on first connect
    }).catch(() => {});

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html' },
      body: SUCCESS_HTML(email),
    };
  } catch (err) {
    console.error('OAuth callback error:', err);
    return { statusCode: 200, headers: { 'Content-Type': 'text/html' }, body: ERROR_HTML(err.message) };
  }
};
