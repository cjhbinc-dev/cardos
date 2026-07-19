/**
 * Stores a browser push notification subscription in Supabase.
 * Called from the frontend after the user grants notification permission.
 */
const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const { subscription } = JSON.parse(event.body || '{}');
  if (!subscription?.endpoint) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'No subscription provided' }) };
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // Use endpoint URL hash as stable ID (each browser/device has a unique endpoint)
  const id = 'push_' + Buffer.from(subscription.endpoint).toString('base64').slice(-20).replace(/[^a-zA-Z0-9]/g, '');

  await supabase.from('connections').upsert({
    id,
    data: {
      id,
      type: 'push_subscription',
      label: 'Browser Push Notification',
      subscription,
      createdAt: new Date().toISOString(),
      lastSync: new Date().toISOString().slice(0, 10),
      syncStatus: 'ok',
    },
  });

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, id }) };
};
