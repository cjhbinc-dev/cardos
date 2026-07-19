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
    tellerAppId: process.env.TELLER_APPLICATION_ID || 'sandbox',
    tellerEnvironment: process.env.TELLER_ENVIRONMENT || 'development',
    adminEmail: process.env.ADMIN_EMAIL || '',
    siteUrl: process.env.URL || 'https://cardos-manager.netlify.app',
  }),
});
