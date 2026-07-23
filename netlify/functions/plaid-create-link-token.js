// Removed — Plaid is not in use.
exports.handler = async () => ({ statusCode: 410, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Gone.' }) });
