// SECURITY: calendar feed disabled — was leaking card data (names, last-4, balances,
// due dates) to anyone with the URL. Returning 403 until rebuilt with per-user signed tokens.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Calendar feed temporarily disabled pending auth rebuild' }) };
};
