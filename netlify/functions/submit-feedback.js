const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method not allowed' };

  const { message, category, userEmail, page } = JSON.parse(event.body || '{}');
  if (!message?.trim()) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'message required' }) };

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const { error } = await supabase.from('feedback').insert({
    message: message.trim(),
    category: category || 'general',
    user_email: userEmail || null,
    page: page || null,
    status: 'new',
  });

  if (error) {
    if (error.code === '42P01') {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Feedback table does not exist yet. Run the migration from the Admin panel → Database Tools.' }) };
    }
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
};
