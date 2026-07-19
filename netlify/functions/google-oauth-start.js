/**
 * Starts Google OAuth flow for Gmail + Google Calendar access.
 * Redirects the user to Google's consent screen.
 * After approval, Google redirects to /google-oauth-callback.
 *
 * Usage: navigate browser to /.netlify/functions/google-oauth-start
 */
const { google } = require('googleapis');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar',
];

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'https://cardos-manager.netlify.app/.netlify/functions/google-oauth-callback'
  );
}

exports.handler = async () => {
  if (!process.env.GOOGLE_CLIENT_ID) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html' },
      body: `<html><body style="font-family:sans-serif;padding:32px;background:#0b0e15;color:#e8eaf2">
        <h2 style="color:#5b7fff">Google OAuth not configured</h2>
        <p>Set <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> in Netlify environment variables.</p>
        <p>Then visit <a href="https://console.cloud.google.com" style="color:#5b7fff">console.cloud.google.com</a> to create credentials.</p>
      </body></html>`,
    };
  }

  const auth = getOAuthClient();
  const url = auth.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',  // force refresh_token issuance
  });

  return {
    statusCode: 302,
    headers: { Location: url },
    body: '',
  };
};
