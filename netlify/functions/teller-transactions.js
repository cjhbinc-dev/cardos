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

  const { connectionId, accountId, count, fromId } = JSON.parse(event.body || '{}');
  if (!connectionId || !accountId) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'connectionId and accountId are required' }) };
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase not configured' }) };
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const accessToken = await getAccessToken(supabase, connectionId);

    let path = `/accounts/${accountId}/transactions`;
    const params = [];
    if (count) params.push(`count=${count}`);
    if (fromId) params.push(`from_id=${fromId}`);
    if (params.length) path += '?' + params.join('&');

    const transactions = await tellerRequest(path, accessToken);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ transactions }),
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
