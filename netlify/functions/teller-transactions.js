// This endpoint is no longer used by the frontend (superseded by teller-fetch-transactions.js).
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  return { statusCode: 410, headers: CORS, body: JSON.stringify({ error: 'Gone — use teller-fetch-transactions instead' }) };
};
