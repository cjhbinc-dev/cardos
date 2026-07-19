const { createClient } = require('@supabase/supabase-js');
const { tellerRequest, getCertOptions, CORS } = require('./lib/teller-client');

async function getUserFromJWT(supabase, event) {
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return null;
  const { data: { user }, error } = await supabase.auth.getUser(jwt);
  if (error || !user) return null;
  return user;
}

async function getAccessToken(supabase, connectionId, userId) {
  // Try user-scoped first; fall back to unscoped for orphaned connections (saved without user_id)
  let connRow = null;
  let connErr = null;
  if (userId) {
    const r = await supabase.from('connections').select('data').eq('id', connectionId).eq('user_id', userId).single();
    connRow = r.data; connErr = r.error;
  }
  if (!connRow) {
    const r = await supabase.from('connections').select('data').eq('id', connectionId).single();
    if (!r.error && r.data) {
      connRow = r.data; connErr = null;
      if (userId) console.log('[sync] connection found via fallback (orphaned — no user_id on row)');
    }
  }
  if (connErr || !connRow) throw new Error('Connection lookup failed: ' + (connErr?.message || 'not found') + ' (id: ' + connectionId + ')');
  if (!connRow?.data?.enrollmentId) throw new Error('Connection not found or missing enrollmentId (id: ' + connectionId + ')');

  const enrollmentId = connRow.data.enrollmentId;
  console.log('[sync] looking up enrollment_id:', enrollmentId);

  // Enrollment lookup is by enrollment_id only — no user_id filter needed here
  const { data: enrollment, error: enrollErr } = await supabase
    .from('enrollments').select('access_token').eq('enrollment_id', enrollmentId).single();
  if (enrollErr) throw new Error('Enrollment lookup failed: ' + enrollErr.message);
  if (!enrollment?.access_token) throw new Error('Enrollment not found (enrollment_id: ' + enrollmentId + ')');

  console.log('[sync] access token loaded:', enrollment.access_token.slice(0, 8) + '…');
  return { accessToken: enrollment.access_token, conn: connRow.data };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const { connectionId } = JSON.parse(event.body || '{}');
  if (!connectionId) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'connectionId is required' }) };
  }

  console.log('[sync] ── START — connectionId:', connectionId);

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase not configured' }) };
  }

  const certOpts = getCertOptions();
  const certOk = !!(certOpts.cert && certOpts.key);
  if (!certOk) {
    const src = process.env.TELLER_CERT_B64 ? 'TELLER_CERT_B64' : process.env.TELLER_CERT_PATH ? 'TELLER_CERT_PATH' : 'NONE';
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'mTLS certificate not loaded — check ' + src }) };
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const user = await getUserFromJWT(supabase, event);
  const userId = user?.id || null;
  console.log('[sync] userId:', userId || '(no JWT)');

  try {
    const { accessToken, conn } = await getAccessToken(supabase, connectionId, userId);

    console.log('[sync] step 2 — calling Teller GET /accounts...');
    let accounts;
    try {
      accounts = await tellerRequest('/accounts', accessToken);
    } catch (tellerErr) {
      console.error('[sync] step 2 FAILED — Teller /accounts:', tellerErr.message);
      throw tellerErr;
    }

    const creditAccounts = accounts.filter(a => a.type === 'credit');
    console.log('[sync] step 2 done — total:', accounts.length, '| credit:', creditAccounts.length);

    // Sequential fetches — avoid triggering Teller rate limits with parallel requests
    const balanceResults = [];
    for (const acc of creditAccounts) {
      try {
        const b = await tellerRequest(`/accounts/${acc.id}/balances`, accessToken);
        balanceResults.push({ id: acc.id, data: b });
      } catch (e) {
        console.warn('[sync] balance failed for', acc.id, ':', e.message);
        balanceResults.push({ id: acc.id, data: null });
      }
    }

    const balances = {};
    for (const { id, data } of balanceResults) {
      if (data) balances[id] = { ledger: data.ledger, available: data.available };
    }

    // Load cards for this user; fall back to connection-scoped lookup for orphaned cards
    let cardRows = null;
    let cardsErr = null;
    if (userId) {
      const r = await supabase.from('cards').select('data').eq('user_id', userId);
      cardRows = r.data; cardsErr = r.error;
    }
    if ((!cardRows || cardRows.length === 0) && !cardsErr) {
      // No user-scoped cards — try fetching by connectionId (handles orphaned cards)
      const r = await supabase.from('cards').select('data').eq('data->>connectionId', connectionId);
      if (!r.error && r.data?.length) {
        cardRows = r.data;
        if (userId) console.log('[sync] found cards via fallback connectionId filter (orphaned cards)');
      }
    }
    if (cardsErr) console.warn('[sync] could not load cards:', cardsErr.message);
    const cards = (cardRows || []).map(r => r.data).filter(Boolean);
    console.log('[sync] loaded', cards.length, 'cards');

    const updated = [];
    for (const acc of creditAccounts) {
      const bal = balances[acc.id] || null;
      const card = cards.find(c =>
        c.tellerAccountId === acc.id ||
        (acc.last_four && c.last4 === acc.last_four && c.connectionId === connectionId)
      );
      if (!card) { console.warn('[sync] no matching card for', acc.id); continue; }

      const ledger = parseFloat(bal?.ledger ?? 0);
      const available = parseFloat(bal?.available ?? 0);
      card.balance = Math.round(ledger);
      if (ledger + available > 0) card.limit = Math.round(ledger + available);
      card.lastSync = new Date().toISOString().slice(0, 10);
      card.syncStatus = 'ok';
      card.syncError = null;
      card.tellerAccountId = acc.id;

      const cardRow = { id: card.id, data: card };
      if (userId) cardRow.user_id = userId;

      const { error: cardErr } = await supabase.from('cards').upsert(cardRow);
      if (cardErr) console.error('[sync] card upsert failed for', card.id, ':', cardErr.message);
      else { updated.push({ id: card.id, last4: card.last4, balance: card.balance }); }
    }

    // Update connection status — use only connectionId (not user_id) to handle orphaned connections
    const updatedConn = { ...conn, lastSync: new Date().toISOString().slice(0, 10), syncStatus: 'ok', syncError: null };
    const { error: connUpdateErr } = await supabase.from('connections').update({ data: updatedConn }).eq('id', connectionId);
    if (connUpdateErr) console.warn('[sync] connection update failed:', connUpdateErr.message);

    console.log('[sync] ── SUCCESS — updated', updated.length, 'cards');
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ accounts: creditAccounts, balances, updated }) };

  } catch (err) {
    const disconnected = err.disconnected || false;
    console.error('[sync] ── ERROR:', err.message, '| disconnected:', disconnected);

    try {
      const { data: connRow } = await supabase.from('connections').select('data').eq('id', connectionId).single();
      if (connRow?.data) {
        await supabase.from('connections').update({
          data: { ...connRow.data, syncStatus: disconnected ? 'disconnected' : 'error', syncError: err.message },
        }).eq('id', connectionId);
      }
    } catch (_) {}

    return { statusCode: disconnected ? 401 : 500, headers: CORS, body: JSON.stringify({ error: err.message, disconnected }) };
  }
};
