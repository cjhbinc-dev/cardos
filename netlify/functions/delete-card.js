// Service-key card deletion. Auth-gated — only the card owner (or any authenticated user
// for unowned/orphaned rows with user_id = null) can delete their own cards.
const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase not configured' }) };
  }

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Authorization required' }) };
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: { user }, error: authErr } = await supabase.auth.getUser(jwt);
  if (authErr || !user) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid session' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { cardId, connectionId } = body;

  if (!cardId && !connectionId) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'cardId or connectionId required' }) };
  }

  if (cardId) {
    // Single card delete — verify ownership first
    const { data: card, error: fetchErr } = await supabase
      .from('cards').select('user_id').eq('id', cardId).single();
    if (fetchErr || !card) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Card not found' }) };
    }
    if (card.user_id !== null && card.user_id !== user.id) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Not your card' }) };
    }
    const { error: delErr } = await supabase.from('cards').delete().eq('id', cardId);
    if (delErr) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: delErr.message }) };
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ deleted: 1 }) };
  }

  // connectionId: delete all cards for this connection that belong to the user (or are unowned)
  const { data: ownedCards, error: listErr } = await supabase
    .from('cards')
    .select('id, user_id')
    .eq('data->>connectionId', connectionId);

  if (listErr) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: listErr.message }) };
  }

  const allowed = (ownedCards || []).filter(c => c.user_id === null || c.user_id === user.id);
  if (!allowed.length) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ deleted: 0 }) };
  }

  const ids = allowed.map(c => c.id);
  const { error: bulkDelErr } = await supabase.from('cards').delete().in('id', ids);
  if (bulkDelErr) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: bulkDelErr.message }) };
  }
  return { statusCode: 200, headers: CORS, body: JSON.stringify({ deleted: ids.length }) };
};
