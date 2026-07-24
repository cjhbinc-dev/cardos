// Scheduled daily sync — iterates ONLY type:'plaid' connections, refreshing
// cached balances via the free /accounts/get. Transactions are pulled by the
// webhook/on-demand path, not here, to keep this within the function budget.
//
// Runs under the Netlify scheduler (no user JWT). It is technically reachable
// over HTTP, so it returns nothing but counts and requires either the
// scheduler payload or MIGRATION_SECRET to run at all.
const { getPlaidClient, getSupabaseAdmin, plaidErrorInfo, logPlaidOk, mapPlaidAccountToCard } = require('./lib/plaid-client');

exports.handler = async (event) => {
  // Gate: Netlify scheduled invocations POST a JSON body containing next_run.
  let scheduled = false;
  try { scheduled = !!JSON.parse(event.body || '{}').next_run; } catch {}
  const secretOk = event.queryStringParameters?.secret &&
    process.env.MIGRATION_SECRET &&
    event.queryStringParameters.secret === process.env.MIGRATION_SECRET;
  if (!scheduled && !secretOk) {
    return { statusCode: 401, body: 'scheduled function' };
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, body: 'not configured' };
  }

  const supabase = getSupabaseAdmin();
  const plaid = getPlaidClient();

  const { data: connRows, error } = await supabase
    .from('connections').select('id, user_id, data')
    .eq('data->>type', 'plaid');
  if (error) { console.error('[plaid-daily] connections load failed:', error.message); return { statusCode: 500, body: 'load failed' }; }

  const results = { synced: 0, disconnected: 0, errors: 0, skipped: 0 };

  for (const conn of connRows || []) {
    const itemId = conn.data?.itemId;
    if (!itemId || !conn.user_id) { results.skipped++; continue; }

    const { data: enr } = await supabase
      .from('enrollments').select('access_token')
      .eq('item_id', itemId).eq('user_id', conn.user_id).maybeSingle();
    if (!enr?.access_token) { results.skipped++; continue; }

    try {
      const resp = await plaid.accountsGet({ access_token: enr.access_token });
      logPlaidOk('/accounts/get (daily)', resp);
      const creditAccounts = (resp.data.accounts || []).filter(a => a.type === 'credit');

      const { data: cardRows } = await supabase
        .from('cards').select('id, data')
        .eq('user_id', conn.user_id).eq('data->>connectionId', conn.id);
      const cards = (cardRows || []).map(r => r.data).filter(Boolean);

      for (const acc of creditAccounts) {
        const existing = cards.find(c => c.plaidAccountId === acc.account_id || c.id === acc.account_id) || null;
        const card = mapPlaidAccountToCard(acc, conn.id, existing, { id: conn.data?.institutionId, name: conn.data?.institutionName });
        const { data: saved, error: cardErr } = await supabase
          .from('cards').upsert({ id: card.id, user_id: conn.user_id, data: card }).select('id');
        if (cardErr || !saved?.length) console.error('[plaid-daily] card upsert failed for', card.id, ':', cardErr?.message || '0 rows');
      }

      const updated = { ...conn.data, lastSync: new Date().toISOString().slice(0, 10), syncStatus: 'ok', syncError: null };
      await supabase.from('connections').update({ data: updated }).eq('id', conn.id).eq('user_id', conn.user_id).select('id');
      results.synced++;
    } catch (err) {
      const info = plaidErrorInfo('/accounts/get (daily)', err);
      if (info.error_code === 'ITEM_LOGIN_REQUIRED' || info.error_code === 'PENDING_EXPIRATION' || info.error_code === 'PENDING_DISCONNECT') {
        const updated = { ...conn.data, syncStatus: 'disconnected', syncError: 'Bank connection needs to be re-linked' };
        await supabase.from('connections').update({ data: updated }).eq('id', conn.id).eq('user_id', conn.user_id).select('id');
        results.disconnected++;
      } else {
        results.errors++;
      }
    }
  }

  console.log('[plaid-daily] done:', JSON.stringify(results));
  return { statusCode: 200, body: JSON.stringify(results) };
};
