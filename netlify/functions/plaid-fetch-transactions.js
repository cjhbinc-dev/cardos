// /transactions/sync with a stored cursor (plaid.com/docs/api/products/transactions/#transactionssync).
//
// Cursor safety (the highest-risk part of this build):
//   - The stored cursor is only advanced AFTER a page's rows are written.
//     Order per page: write added/modified → delete removed → persist next_cursor.
//     A cursor advanced past a failed write would lose those transactions
//     permanently, so any write failure aborts WITHOUT advancing.
//   - An empty next_cursor means the initial historical pull is still running
//     (Quickstart pattern): sleep 2s and re-poll. An empty cursor is NEVER
//     persisted — that would reset the Item to full history next run.
//   - Docs: on pagination failure, restart from the first-page cursor of the
//     update — which is exactly what not-advancing achieves.
//   - Pending→posted (failure mode 3): the posted transaction arrives in
//     `added` with a NEW transaction_id and a pending_transaction_id pointing
//     at the old row; user fields are carried over before the pending row is
//     dropped via `removed`.
//
// Netlify functions have a ~10s budget: the loop is time-boxed and returns
// { hasMore: true } when it runs out — the caller re-invokes to continue.
const { CORS, getPlaidClient, getSupabaseAdmin, getUserFromJWT, plaidErrorInfo } = require('./lib/plaid-client');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const TIME_BUDGET_MS = 7500;

function autoCategory(description) {
  const d = (description || '').toLowerCase();
  const rules = [
    ['dining', ['restaurant', 'cafe ', 'coffee', 'starbucks', 'doordash', 'uber eat', 'grubhub', 'pizza', 'burger', 'sushi', 'chipotle', 'mcdonald', 'dunkin', 'panera', 'chick-fil', 'bistro', 'grill ', 'diner', 'taco bell', 'kfc', 'wingstop', 'shake shack']],
    ['groceries', ['grocery', 'supermarket', 'whole foods', 'trader joe', 'safeway', 'kroger', 'publix', 'costco', "sam's club", 'aldi', 'wegman', 'h-e-b', 'albertson', 'meijer']],
    ['gas', ['shell ', 'bp ', 'exxon', 'chevron', 'mobil', 'speedway', 'circle k', 'sunoco', 'wawa', 'quiktrip', 'racetrac', "casey's", 'gas station', 'fuel ', 'kwik trip']],
    ['travel', ['delta air', 'united air', 'american air', 'southwest', 'jetblue', 'alaska air', 'hotel ', 'marriott', 'hilton', 'hyatt', 'airbnb', 'vrbo', 'airport', 'airline', 'hertz', 'avis', 'enterprise rent', 'amtrak', 'expedia', 'booking.com']],
    ['subscriptions', ['netflix', 'spotify', 'hulu', 'disney+', 'amazon prime', 'apple.com', 'microsoft 365', 'adobe', 'dropbox', 'zoom', 'github', 'notion', 'youtube premium', 'paramount+', 'peacock', 'chatgpt', 'openai', 'icloud', 'siriusxm']],
    ['shopping', ['amazon.com', 'amazon mktpl', 'ebay', 'etsy', 'best buy', 'home depot', "lowe's", 'ikea', 'nordstrom', 'macy', 'nike', 'apple store', 'wayfair', 'chewy', 'sephora', 'target.com', 'temu', 'shein']],
    ['healthcare', ['pharmacy', 'cvs ', 'walgreen', 'rite aid', 'doctor', 'dental', 'vision', 'hospital', 'medical ', 'urgent care', 'clinic', 'labcorp', 'prescription', 'teladoc']],
    ['utilities', ['verizon', 't-mobile', 'at&t', 'spectrum', 'xfinity', 'comcast', 'internet', 'utility ', 'duke energy', 'national grid', 'water bill', 'electric bill']],
    ['entertainment', ['movie', 'theater', 'cinema', 'ticketmaster', 'stubhub', 'museum', 'concert', 'bowling', 'golf ', 'gym ', 'fitness', 'peloton', 'planet fitness', 'amc ', 'regal ', 'cinemark']],
    ['transport', ['uber ', 'lyft ', 'taxi ', 'transit', 'metro card', 'parking', 'toll ', 'e-z pass', 'zipcar', 'mta ', 'bart ', 'cta ']],
    ['education', ['udemy', 'coursera', 'skillshare', 'masterclass', 'duolingo', 'school ', 'university', 'tuition', 'textbook', 'chegg']],
  ];
  for (const [cat, keywords] of rules) if (keywords.some(kw => d.includes(kw))) return cat;
  return 'other';
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase not configured' }) };
  }

  const supabase = getSupabaseAdmin();
  const user = await getUserFromJWT(supabase, event);
  if (!user) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Authorization required' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }
  const { connectionId } = body;
  if (!connectionId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'connectionId required' }) };

  // Ownership-verified lookups
  const { data: conn, error: connErr } = await supabase
    .from('connections').select('id, user_id, data')
    .eq('id', connectionId).eq('user_id', user.id).maybeSingle();
  if (connErr) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: connErr.message }) };
  if (!conn) return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Connection not found or not yours' }) };
  const itemId = conn.data?.itemId;
  if (!itemId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Connection has no Plaid itemId' }) };

  const { data: enr, error: enrErr } = await supabase
    .from('enrollments').select('id, access_token, transaction_cursor')
    .eq('item_id', itemId).eq('user_id', user.id).maybeSingle();
  if (enrErr) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: enrErr.message }) };
  if (!enr?.access_token) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'No stored access token for this connection' }) };

  const plaid = getPlaidClient();
  const started = Date.now();
  let cursor = enr.transaction_cursor || undefined;
  let added = 0, modified = 0, removed = 0, pages = 0;
  let hasMore = true;
  let initialPullPending = false;

  while (hasMore && (Date.now() - started) < TIME_BUDGET_MS) {
    let data;
    try {
      const resp = await plaid.transactionsSync({
        access_token: enr.access_token,
        ...(cursor ? { cursor } : {}),
        count: 500,
      });
      data = resp.data;
      console.log(`[plaid-tx] page ok request_id=${data.request_id} added=${data.added.length} modified=${data.modified.length} removed=${data.removed.length} has_more=${data.has_more}`);
    } catch (err) {
      const info = plaidErrorInfo('/transactions/sync', err);
      if (info.error_code === 'ITEM_LOGIN_REQUIRED') {
        const updatedConn = { ...conn.data, syncStatus: 'disconnected', syncError: 'Bank connection needs to be re-linked' };
        await supabase.from('connections').update({ data: updatedConn }).eq('id', connectionId).eq('user_id', user.id).select('id');
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ disconnected: true }) };
      }
      // Cursor was not advanced — safe to retry from the same place later.
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'transactions sync failed (cursor not advanced)', plaid: info }) };
    }

    // Initial historical pull still running: empty next_cursor → wait and re-poll.
    if (data.next_cursor === '') {
      initialPullPending = true;
      await sleep(2000);
      continue;
    }
    initialPullPending = false;

    // ── Write this page BEFORE advancing the cursor ──────────────────────────
    const nowIso = new Date().toISOString();
    const upserts = [];
    const pendingIdMap = {}; // pending_transaction_id → user fields to carry over

    const pendingIds = data.added.map(t => t.pending_transaction_id).filter(Boolean);
    if (pendingIds.length) {
      const { data: pendingRows } = await supabase
        .from('transactions').select('id, data').in('id', pendingIds).eq('user_id', user.id);
      for (const row of pendingRows || []) pendingIdMap[row.id] = row.data || {};
    }

    for (const tx of [...data.added, ...data.modified]) {
      const prev = tx.pending_transaction_id ? (pendingIdMap[tx.pending_transaction_id] || {}) : {};
      const desc = tx.merchant_name || tx.name || '';
      upserts.push({
        id: tx.transaction_id,
        card_id: tx.account_id,
        tx_date: tx.authorized_date || tx.date,
        user_id: user.id,
        updated_at: nowIso,
        data: {
          id: tx.transaction_id,
          card_id: tx.account_id,
          connection_id: connectionId,
          account_id: tx.account_id,
          user_id: user.id,
          amount: typeof tx.amount === 'number' ? tx.amount : parseFloat(tx.amount) || 0,
          description: desc,
          category: autoCategory(desc),
          user_category: prev.user_category || null,
          tx_date: tx.authorized_date || tx.date,
          status: tx.pending ? 'pending' : 'posted',
          pending: !!tx.pending,
          notes: prev.notes || '',
          tags: prev.tags || [],
          split_data: prev.split_data || null,
          iso_currency_code: tx.iso_currency_code || tx.unofficial_currency_code || 'USD',
        },
      });
    }

    for (let i = 0; i < upserts.length; i += 100) {
      const chunk = upserts.slice(i, i + 100);
      const { data: saved, error: upErr } = await supabase.from('transactions').upsert(chunk).select('id');
      if (upErr || (saved || []).length !== chunk.length) {
        console.error('[plaid-tx] page write FAILED — cursor NOT advanced:', upErr?.message || `wrote ${(saved || []).length}/${chunk.length}`);
        return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Write failed — cursor not advanced, safe to retry', hasMore: true }) };
      }
    }

    const removedIds = (data.removed || []).map(r => r.transaction_id).filter(Boolean);
    if (removedIds.length) {
      const { error: rmErr } = await supabase
        .from('transactions').delete().in('id', removedIds).eq('user_id', user.id);
      if (rmErr) {
        console.error('[plaid-tx] removed-delete FAILED — cursor NOT advanced:', rmErr.message);
        return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Delete failed — cursor not advanced, safe to retry', hasMore: true }) };
      }
    }

    // TEST HOOK (admin-only, removed with plaid-diag in Phase 5 cleanup):
    // simulates a crash AFTER the page's writes but BEFORE the cursor persists,
    // to prove a failed run never advances the cursor.
    if (body._failTest === true) {
      const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
      if (adminEmail && (user.email || '').trim().toLowerCase() === adminEmail) {
        console.warn('[plaid-tx] _failTest — aborting before cursor persist');
        return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'TEST: simulated failure before cursor persist', testHook: true }) };
      }
    }

    // ── Page fully written → NOW persist the cursor ─────────────────────────
    const { data: curSaved, error: curErr } = await supabase
      .from('enrollments').update({ transaction_cursor: data.next_cursor })
      .eq('id', enr.id).eq('user_id', user.id).select('id');
    if (curErr || !curSaved?.length) {
      console.error('[plaid-tx] cursor persist FAILED:', curErr?.message || '0 rows');
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Cursor persist failed — retry will reprocess this page (idempotent upserts)', hasMore: true }) };
    }

    cursor = data.next_cursor;
    added += data.added.length; modified += data.modified.length; removed += removedIds.length;
    pages++;
    hasMore = data.has_more;
  }

  const budgetExhausted = hasMore || initialPullPending;
  console.log(`[plaid-tx] done pages=${pages} added=${added} modified=${modified} removed=${removed} hasMore=${budgetExhausted} initialPullPending=${initialPullPending}`);
  return {
    statusCode: 200, headers: CORS,
    body: JSON.stringify({ added, modified, removed, pages, hasMore: budgetExhausted, initialPullPending }),
  };
};
