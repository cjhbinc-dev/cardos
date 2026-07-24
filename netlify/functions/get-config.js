exports.handler = async () => ({
  statusCode: 200,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  },
  body: JSON.stringify({
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
    plaidEnv: process.env.PLAID_ENV || 'production',
    adminEmail: process.env.ADMIN_EMAIL || '',
    siteUrl: process.env.URL || 'https://cardos-manager.netlify.app',
  }),
});
