/**
 * Admin-only: set feature flags on a user via Supabase app_metadata.
 * POST { userId, features: { canConnectBanks, canViewTransactions, ... } }
 * Authorization: Bearer <admin-jwt>
 */
const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

const ALL_FEATURES = ['canConnectBanks', 'canViewTransactions', 'canViewReports', 'canViewLedger', 'canViewBenefits', 'canViewBudgets'];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase not configured' }) };
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Authorization required' }) };

  const { data: { user: caller } } = await supabase.auth.getUser(jwt);
  const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (!caller || caller.email?.toLowerCase() !== adminEmail) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Admin only' }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) {}
  const { userId, features } = body;
  if (!userId || !features) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'userId and features required' }) };

  // Sanitize — only allow known feature keys
  const clean = {};
  ALL_FEATURES.forEach(f => { if (typeof features[f] === 'boolean') clean[f] = features[f]; });

  const { error } = await supabase.auth.admin.updateUserById(userId, {
    app_metadata: { features: clean },
  });

  if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };

  console.log('[set-user-features] updated userId:', userId, '| features:', JSON.stringify(clean), '| by:', caller.email);
  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, features: clean }) };
};
