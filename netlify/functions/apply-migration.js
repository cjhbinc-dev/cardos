/**
 * One-time migration: adds user_id columns + enables RLS on all CardOS tables.
 * Call once after deploy: GET /.netlify/functions/apply-migration?secret=YOUR_SECRET
 * Requires SUPABASE_ACCESS_TOKEN env var (Supabase personal access token from
 * https://supabase.com/dashboard/account/tokens) and MIGRATION_SECRET.
 */
const https = require('https');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const PROJECT_REF = 'urkeufuebcvlsrkigqij';

const MIGRATION_SQL = `
-- Step 1: Add user_id uuid columns (handles pre-existing text columns from old single-user code)
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['cards','connections','offers','balance_history','transactions','enrollments']
  LOOP
    -- If column exists but is the wrong type (e.g. text from old hardcoded 'cardos-user'), drop and recreate
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=tbl AND column_name='user_id'
        AND data_type <> 'uuid'
    ) THEN
      EXECUTE format('ALTER TABLE public.%I DROP COLUMN user_id', tbl);
    END IF;
    -- Add as uuid if missing
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=tbl AND column_name='user_id'
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN user_id uuid REFERENCES auth.users ON DELETE CASCADE', tbl);
    END IF;
  END LOOP;
END $$;

-- Step 2: Enable RLS on all tables
ALTER TABLE public.cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.balance_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.enrollments ENABLE ROW LEVEL SECURITY;

-- Step 3: Drop old policies (idempotent)
DROP POLICY IF EXISTS "users_own_cards_select" ON public.cards;
DROP POLICY IF EXISTS "users_own_cards_insert" ON public.cards;
DROP POLICY IF EXISTS "users_own_cards_update" ON public.cards;
DROP POLICY IF EXISTS "users_own_cards_delete" ON public.cards;
DROP POLICY IF EXISTS "users_own_connections_select" ON public.connections;
DROP POLICY IF EXISTS "users_own_connections_insert" ON public.connections;
DROP POLICY IF EXISTS "users_own_connections_update" ON public.connections;
DROP POLICY IF EXISTS "users_own_connections_delete" ON public.connections;
DROP POLICY IF EXISTS "users_own_offers_select" ON public.offers;
DROP POLICY IF EXISTS "users_own_offers_insert" ON public.offers;
DROP POLICY IF EXISTS "users_own_offers_update" ON public.offers;
DROP POLICY IF EXISTS "users_own_offers_delete" ON public.offers;
DROP POLICY IF EXISTS "users_own_balance_history_select" ON public.balance_history;
DROP POLICY IF EXISTS "users_own_balance_history_insert" ON public.balance_history;
DROP POLICY IF EXISTS "users_own_balance_history_update" ON public.balance_history;
DROP POLICY IF EXISTS "users_own_balance_history_delete" ON public.balance_history;
DROP POLICY IF EXISTS "users_own_transactions_select" ON public.transactions;
DROP POLICY IF EXISTS "users_own_transactions_insert" ON public.transactions;
DROP POLICY IF EXISTS "users_own_transactions_update" ON public.transactions;
DROP POLICY IF EXISTS "users_own_transactions_delete" ON public.transactions;
DROP POLICY IF EXISTS "users_own_enrollments_select" ON public.enrollments;
DROP POLICY IF EXISTS "users_own_enrollments_insert" ON public.enrollments;
DROP POLICY IF EXISTS "users_own_enrollments_update" ON public.enrollments;
DROP POLICY IF EXISTS "users_own_enrollments_delete" ON public.enrollments;

-- Step 3b: Create allowed_emails table for invite management
CREATE TABLE IF NOT EXISTS public.allowed_emails (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  email text UNIQUE NOT NULL,
  invited_by uuid REFERENCES auth.users ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.allowed_emails ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "no_public_access_allowed_emails" ON public.allowed_emails;
CREATE POLICY "no_public_access_allowed_emails" ON public.allowed_emails USING (false);

-- Step 3c: Create access_requests table for invite request workflow
CREATE TABLE IF NOT EXISTS public.access_requests (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  email text UNIQUE NOT NULL,
  status text DEFAULT 'pending',
  requested_at timestamptz DEFAULT now(),
  approved_at timestamptz,
  approved_by uuid REFERENCES auth.users ON DELETE SET NULL
);

-- Step 4: Create RLS policies
CREATE POLICY "users_own_cards_select" ON public.cards FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "users_own_cards_insert" ON public.cards FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users_own_cards_update" ON public.cards FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "users_own_cards_delete" ON public.cards FOR DELETE USING (auth.uid() = user_id);

CREATE POLICY "users_own_connections_select" ON public.connections FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "users_own_connections_insert" ON public.connections FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users_own_connections_update" ON public.connections FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "users_own_connections_delete" ON public.connections FOR DELETE USING (auth.uid() = user_id);

CREATE POLICY "users_own_offers_select" ON public.offers FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "users_own_offers_insert" ON public.offers FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users_own_offers_update" ON public.offers FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "users_own_offers_delete" ON public.offers FOR DELETE USING (auth.uid() = user_id);

CREATE POLICY "users_own_balance_history_select" ON public.balance_history FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "users_own_balance_history_insert" ON public.balance_history FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users_own_balance_history_update" ON public.balance_history FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "users_own_balance_history_delete" ON public.balance_history FOR DELETE USING (auth.uid() = user_id);

CREATE POLICY "users_own_transactions_select" ON public.transactions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "users_own_transactions_insert" ON public.transactions FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users_own_transactions_update" ON public.transactions FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "users_own_transactions_delete" ON public.transactions FOR DELETE USING (auth.uid() = user_id);

CREATE POLICY "users_own_enrollments_select" ON public.enrollments FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "users_own_enrollments_insert" ON public.enrollments FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users_own_enrollments_update" ON public.enrollments FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "users_own_enrollments_delete" ON public.enrollments FOR DELETE USING (auth.uid() = user_id);
`;

function supabaseQuery(sql, accessToken) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query: sql });
    const options = {
      hostname: 'api.supabase.com',
      path: `/v1/projects/${PROJECT_REF}/database/query`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (_) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const secret = event.queryStringParameters?.secret || (JSON.parse(event.body || '{}').secret);
  const migrationSecret = process.env.MIGRATION_SECRET;
  if (migrationSecret && secret !== migrationSecret) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized — pass ?secret=MIGRATION_SECRET' }) };
  }

  const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
  if (!accessToken) {
    return {
      statusCode: 500, headers: CORS,
      body: JSON.stringify({
        error: 'SUPABASE_ACCESS_TOKEN not set.',
        instructions: 'Get your personal access token at https://supabase.com/dashboard/account/tokens and add it as SUPABASE_ACCESS_TOKEN in Netlify env vars.',
      }),
    };
  }

  console.log('[apply-migration] Running migration SQL...');
  try {
    const result = await supabaseQuery(MIGRATION_SQL, accessToken);
    console.log('[apply-migration] API response status:', result.status);
    if (result.status >= 400) {
      console.error('[apply-migration] Error:', JSON.stringify(result.body));
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Migration failed', details: result.body }) };
    }
    console.log('[apply-migration] Migration succeeded');
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, message: 'Migration applied successfully. RLS is now active on all CardOS tables.' }) };
  } catch (err) {
    console.error('[apply-migration] Exception:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
