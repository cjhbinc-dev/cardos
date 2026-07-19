const { createClient } = require('@supabase/supabase-js');
const { tellerRequest, CORS } = require('./lib/teller-client');

async function getAccessToken(supabase, connectionId) {
  const { data: connRow } = await supabase.from('connections').select('data').eq('id', connectionId).single();
  if (!connRow?.data?.enrollmentId) throw new Error('Connection not found');
  const { data: enrollment } = await supabase
    .from('enrollments').select('access_token').eq('enrollment_id', connRow.data.enrollmentId).single();
  if (!enrollment?.access_token) throw new Error('Enrollment not found');
  return enrollment.access_token;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const { connectionId } = JSON.parse(event.body || '{}');
  if (!connectionId) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'connectionId is required' }) };
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase not configured' }) };
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const accessToken = await getAccessToken(supabase, connectionId);
    const accounts = await tellerRequest('/accounts', accessToken);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ accounts: accounts.filter(a => a.type === 'credit') }),
    };
  } catch (err) {
    const disconnected = err.disconnected || false;
    return {
      statusCode: disconnected ? 401 : 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message, disconnected }),
    };
  }
};
