// Runs every day at 7:00 AM UTC (scheduled via netlify.toml)
// Syncs all users' Teller connections using service key (bypasses RLS).
const { createClient } = require('@supabase/supabase-js');
const { tellerRequest } = require('./lib/teller-client');

const sleep = ms => new Promise(r => setTimeout(r, ms));

exports.handler = async () => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('Missing Supabase config');
    return { statusCode: 500, body: 'Missing Supabase config' };
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const { data: connRows } = await supabase.from('connections').select('id, user_id, data');
  const tellerConns = (connRows || []).filter(r => r.data?.type === 'teller');

  if (!tellerConns.length) {
    console.log('No Teller connections to sync');
    return { statusCode: 200, body: 'No connections' };
  }

  const results = [];

  for (let ri = 0; ri < tellerConns.length; ri++) {
    if (ri > 0) await sleep(1200); // pace requests — avoid Teller rate limits
    const row = tellerConns[ri];
    const conn = row.data;
    const userId = row.user_id || null;
    if (!conn.enrollmentId) continue;

    const { data: enrollment } = await supabase
      .from('enrollments')
      .select('access_token')
      .eq('enrollment_id', conn.enrollmentId)
      .single();

    if (!enrollment?.access_token) {
      results.push(`SKIP ${conn.label}: no access token`);
      continue;
    }

    try {
      const accounts = await tellerRequest('/accounts', enrollment.access_token);
      const creditAccounts = accounts.filter(a => a.type === 'credit');

      const balances = [];
      for (const acc of creditAccounts) {
        const b = await tellerRequest(`/accounts/${acc.id}/balances`, enrollment.access_token).catch(() => null);
        balances.push(b);
      }

      // Load cards scoped to this user
      let cardsQ = supabase.from('cards').select('id, user_id, data');
      if (userId) cardsQ = cardsQ.eq('user_id', userId);
      const { data: cardRows } = await cardsQ;
      const cards = (cardRows || []).map(r => ({ ...r.data, _rowUserId: r.user_id }));

      for (let i = 0; i < creditAccounts.length; i++) {
        const acc = creditAccounts[i];
        const bal = balances[i];
        const card = cards.find(c =>
          c.tellerAccountId === acc.id ||
          (acc.last_four && c.last4 === acc.last_four && c.connectionId === conn.id)
        );
        if (!card) continue;

        const ledger = parseFloat(bal?.ledger ?? 0);
        const available = parseFloat(bal?.available ?? 0);
        card.balance = Math.round(ledger);
        if (ledger + available > 0) card.limit = Math.round(ledger + available);
        card.lastSync = new Date().toISOString().slice(0, 10);
        card.syncStatus = 'ok';
        card.syncError = null;

        const cardRow = { id: card.id, data: card };
        const cardUserId = userId || card._rowUserId;
        if (cardUserId) cardRow.user_id = cardUserId;
        await supabase.from('cards').upsert(cardRow);
        results.push(`Updated ${card.name} ••${card.last4}: $${card.balance}`);
      }

      const connUpdate = { data: { ...conn, lastSync: new Date().toISOString().slice(0, 10), syncStatus: 'ok', syncError: null } };
      if (userId) connUpdate.user_id = userId;
      await supabase.from('connections').update(connUpdate).eq('id', conn.id);

    } catch (err) {
      console.error(`Sync failed for ${conn.id}:`, err.message);
      const disconnected = err.disconnected || false;
      const errUpdate = { data: { ...conn, syncStatus: disconnected ? 'disconnected' : 'error', syncError: err.message } };
      if (userId) errUpdate.user_id = userId;
      await supabase.from('connections').update(errUpdate).eq('id', conn.id);
      results.push(`ERROR ${conn.label}: ${err.message}`);
    }
  }

  console.log('Daily Teller sync complete:', results);
  return { statusCode: 200, body: JSON.stringify({ synced: results.length, results }) };
};
