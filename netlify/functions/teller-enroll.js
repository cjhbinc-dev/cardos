const { createClient } = require('@supabase/supabase-js');
const { tellerRequest, mapAccountToCard, getCertOptions, CORS } = require('./lib/teller-client');

async function getUserFromJWT(supabase, event) {
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const jwt = authHeader.replace('Bearer ', '').trim();
  if (!jwt) return null;
  const { data: { user }, error } = await supabase.auth.getUser(jwt);
  if (error || !user) return null;
  return user;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { accessToken, enrollmentId, institution, reconnectConnectionId } = body;

  const tokenPreview = accessToken ? accessToken.slice(0, 8) + '…' : 'MISSING';
  console.log('[enroll] ── START ──');
  console.log('[enroll] enrollmentId:', enrollmentId || 'MISSING');
  console.log('[enroll] accessToken:', tokenPreview, '| length:', accessToken?.length ?? 0);
  console.log('[enroll] institution:', institution?.name || '(not provided)');

  const certOpts = getCertOptions();
  const certSource = process.env.TELLER_CERT_B64 ? 'TELLER_CERT_B64' :
                     process.env.TELLER_CERT_PATH ? 'TELLER_CERT_PATH(' + process.env.TELLER_CERT_PATH + ')' :
                     'NONE';
  const certOk = !!(certOpts.cert && certOpts.key);
  console.log('[enroll] cert source:', certSource, '| loaded:', certOk,
    '| cert bytes:', certOpts.cert?.length ?? 0, '| key bytes:', certOpts.key?.length ?? 0);

  if (!certOk) {
    const msg = 'mTLS certificate not loaded — check ' + certSource + '. Cannot connect to api.teller.io without it.';
    console.error('[enroll] FATAL:', msg);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: msg }) };
  }

  if (!accessToken || !enrollmentId) {
    const msg = 'accessToken and enrollmentId are required. Received: accessToken=' +
      (accessToken ? 'present' : 'missing') + ', enrollmentId=' + (enrollmentId || 'missing');
    console.error('[enroll]', msg);
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: msg }) };
  }

  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!process.env.SUPABASE_URL || !supabaseKey) {
    console.error('[enroll] FATAL: Supabase env vars not set');
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase not configured' }) };
  }

  const supabase = createClient(process.env.SUPABASE_URL, supabaseKey);

  // Resolve the calling user from the JWT
  const user = await getUserFromJWT(supabase, event);
  const userId = user?.id || null;
  console.log('[enroll] userId:', userId || 'anonymous (no JWT)');

  try {
    // ── STEP 1: Save enrollment token FIRST ───────────────────────────────
    const institutionName = institution?.name || 'Unknown';
    console.log('[enroll] step 1 — saving enrollment token to Supabase...');

    const enrollRow = {
      id: enrollmentId,
      enrollment_id: enrollmentId,
      access_token: accessToken,
      institution_name: institutionName,
      created_at: new Date().toISOString(),
    };
    if (userId) enrollRow.user_id = userId;

    const { error: enrollErr } = await supabase.from('enrollments').upsert(enrollRow);

    if (enrollErr) {
      console.error('[enroll] step 1 FAILED — enrollments upsert:',
        enrollErr.message, '| code:', enrollErr.code, '| hint:', enrollErr.hint);
      throw new Error('Failed to save enrollment token: ' + enrollErr.message);
    }
    console.log('[enroll] step 1 done — token saved for enrollmentId:', enrollmentId);

    // ── STEP 2: Fetch accounts from Teller ────────────────────────────────
    console.log('[enroll] step 2 — calling Teller GET /accounts...');
    let accounts;
    try {
      accounts = await tellerRequest('/accounts', accessToken);
    } catch (tellerErr) {
      console.error('[enroll] step 2 FAILED — Teller /accounts error:',
        tellerErr.message, '| disconnected:', tellerErr.disconnected,
        '| status:', tellerErr.status, '| code:', tellerErr.tellerCode);
      throw tellerErr;
    }

    if (!Array.isArray(accounts)) {
      const msg = 'Teller /accounts returned non-array: ' + typeof accounts;
      console.error('[enroll] step 2 FAILED —', msg, '| raw:', JSON.stringify(accounts).slice(0, 200));
      throw new Error(msg);
    }

    const creditAccounts = accounts.filter(a => a.type === 'credit');
    console.log('[enroll] step 2 done — total accounts:', accounts.length,
      '| credit:', creditAccounts.length,
      '| types:', accounts.map(a => a.type + '/' + a.subtype).join(', '));

    if (creditAccounts.length === 0) {
      const allTypes = accounts.map(a => ({ type: a.type, subtype: a.subtype, name: a.name }));
      const noCardConnId = 't' + Date.now();
      const noCardInst = institution?.name || accounts[0]?.institution?.name || 'Unknown';
      console.warn('[enroll] WARNING — no credit accounts at', noCardInst,
        '| Account types found:', JSON.stringify(allTypes));

      const connRow = {
        id: noCardConnId,
        data: {
          id: noCardConnId, type: 'teller', label: 'Teller — ' + noCardInst,
          institutionName: noCardInst, enrollmentId,
          lastSync: new Date().toISOString().slice(0, 10),
          syncStatus: 'no_credit_accounts', syncError: 'No credit card accounts found',
          cardIds: [], consentExpiry: new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10),
        },
      };
      if (userId) connRow.user_id = userId;
      await supabase.from('connections').upsert(connRow);
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          connectionId: noCardConnId,
          institutionName: noCardInst,
          accounts: [],
          cardsSaved: 0,
          allAccountTypes: allTypes,
        }),
      };
    }

    // ── STEP 3: Fetch balances (sequential to avoid rate limits) ─────────────
    console.log('[enroll] step 3 — fetching balances for', creditAccounts.length, 'credit accounts...');
    const balances = [];
    for (const acc of creditAccounts) {
      try {
        const b = await tellerRequest(`/accounts/${acc.id}/balances`, accessToken);
        console.log('[enroll] balance for', acc.id, '— ledger:', b?.ledger, 'available:', b?.available);
        balances.push(b);
      } catch (e) {
        console.warn('[enroll] balance fetch failed for', acc.id, ':', e.message);
        balances.push(null);
      }
    }

    // ── STEP 4: Save connection record ────────────────────────────────────
    // Reuse existing connection ID on reconnect to prevent duplicates
    const connectionId = reconnectConnectionId || ('t' + Date.now());
    const resolvedName = institution?.name
      || creditAccounts[0]?.institution?.name
      || accounts[0]?.institution?.name
      || 'Unknown';

    console.log('[enroll] step 4 — saving connection', connectionId, 'for', resolvedName);

    const connData = {
      id: connectionId,
      type: 'teller',
      label: 'Teller — ' + resolvedName,
      institutionName: resolvedName,
      enrollmentId,
      lastSync: new Date().toISOString().slice(0, 10),
      syncStatus: 'ok',
      syncError: null,
      cardIds: [],
      consentExpiry: new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10),
    };

    const connUpsertRow = { id: connectionId, data: connData };
    if (userId) connUpsertRow.user_id = userId;

    const { error: connErr } = await supabase.from('connections').upsert(connUpsertRow);

    if (connErr) {
      console.error('[enroll] step 4 FAILED — connections upsert:',
        connErr.message, '| code:', connErr.code, '| hint:', connErr.hint);
      throw new Error('Failed to save connection: ' + connErr.message);
    }
    console.log('[enroll] step 4 done — connection', connectionId, 'saved');

    // ── STEP 5: Upsert cards ───────────────────────────────────────────────
    console.log('[enroll] step 5 — loading existing cards from Supabase...');
    let cardsQuery = supabase.from('cards').select('data');
    if (userId) cardsQuery = cardsQuery.eq('user_id', userId);
    const { data: existingRows, error: existingErr } = await cardsQuery;
    if (existingErr) {
      console.warn('[enroll] step 5 — could not load existing cards:', existingErr.message,
        '(will create all as new)');
    }
    const existing = (existingRows || []).map(r => r.data).filter(Boolean);
    console.log('[enroll] step 5 — found', existing.length, 'existing cards');

    const savedCards = [];
    for (let i = 0; i < creditAccounts.length; i++) {
      const acc = creditAccounts[i];
      const bal = balances[i];

      const ledger   = parseFloat(bal?.ledger   ?? acc.balance?.current ?? acc.balance ?? 0);
      const available= parseFloat(bal?.available ?? acc.balance?.available ?? 0);
      const limit    = parseFloat(acc.credit_limit ?? 0) || Math.round(ledger + available) || 0;
      const balance  = Math.round(ledger);

      const instNameRaw = (acc.institution?.name || resolvedName || '').toLowerCase();
      let issuerId = 'other';
      if (instNameRaw.includes('amex') || instNameRaw.includes('american express')) issuerId = 'amex';
      else if (instNameRaw.includes('chase'))         issuerId = 'chase';
      else if (instNameRaw.includes('citi'))          issuerId = 'citi';
      else if (instNameRaw.includes('capital one'))   issuerId = 'capone';
      else if (instNameRaw.includes('discover'))      issuerId = 'disc';
      else if (instNameRaw.includes('bank of america'))issuerId = 'boa';
      else if (instNameRaw.includes('wells fargo'))   issuerId = 'wells';
      else if (instNameRaw.includes('us bank'))       issuerId = 'usb';
      else if (instNameRaw.includes('barclays'))      issuerId = 'barc';

      const cardId = acc.id;

      const match = existing.find(c =>
        c.tellerAccountId === acc.id || c.id === cardId ||
        (acc.last_four && c.last4 === acc.last_four)
      );

      const cardToSave = match ? {
        ...match,
        balance,
        limit: limit || match.limit,
        issuerId,
        connectionId,
        syncMethod: 'teller',
        tellerAccountId: acc.id,
        lastSync: new Date().toISOString().slice(0, 10),
        syncStatus: 'ok',
        syncError: null,
      } : {
        id: cardId,
        issuerId,
        name: acc.name || resolvedName,
        last4: acc.last_four || '',
        limit,
        balance,
        statementClose: '', dueDate: '', minPayment: 0, apr: null,
        annualFee: 0, annualFeeMonth: null, autopay: false, status: 'active',
        syncMethod: 'teller', rewardsType: '', rewardsNotes: '', notes: '',
        connectionId,
        lastSync: new Date().toISOString().slice(0, 10),
        syncStatus: 'ok', syncError: null,
        tellerAccountId: acc.id,
      };

      console.log('[enroll]', match ? 'updating' : 'creating', 'card:', cardToSave.name,
        '••' + cardToSave.last4, '| id:', cardToSave.id,
        '| balance:', cardToSave.balance, '| limit:', cardToSave.limit);

      const cardUpsertRow = { id: cardToSave.id, data: cardToSave };
      if (userId) cardUpsertRow.user_id = userId;

      const { error: cardErr } = await supabase.from('cards').upsert(cardUpsertRow);

      if (cardErr) {
        console.error('[enroll] card upsert FAILED for', cardToSave.id, ':', cardErr.message,
          '| code:', cardErr.code);
      } else {
        savedCards.push(cardToSave);
      }
    }

    console.log('[enroll] step 5 done —', savedCards.length, '/', creditAccounts.length, 'cards saved:',
      savedCards.map(c => c.name + ' ••' + c.last4).join(', '));

    console.log('[enroll] ── SUCCESS — connectionId:', connectionId,
      '| institution:', resolvedName,
      '| accounts total:', accounts.length,
      '| credit:', creditAccounts.length,
      '| cards saved:', savedCards.length);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        connectionId,
        institutionName: resolvedName,
        accounts: creditAccounts,
        cards: savedCards,
        cardsSaved: savedCards.length,
      }),
    };

  } catch (err) {
    const disconnected = err.disconnected || false;
    console.error('[enroll] ── FATAL ERROR:', err.message,
      '| disconnected:', disconnected,
      '| stack:', err.stack?.split('\n')[1]?.trim());
    return {
      statusCode: disconnected ? 401 : 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message, disconnected }),
    };
  }
};
