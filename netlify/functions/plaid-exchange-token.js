// Removed — Plaid replaced by Teller. See teller-enroll.js.
exports.handler = async () => ({
  statusCode: 410,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ error: 'Plaid replaced by Teller. Use /.netlify/functions/teller-enroll.' }),
});
