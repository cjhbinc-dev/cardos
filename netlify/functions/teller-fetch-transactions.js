const { createClient } = require('@supabase/supabase-js');
const { tellerRequest, CORS } = require('./lib/teller-client');

function autoCategory(description) {
  const d = (description || '').toLowerCase();
  const rules = [
    ['dining',        ['restaurant','cafe ','coffee','starbucks','doordash','uber eat','grubhub','pizza','burger','sushi','chipotle','mcdonald','dunkin','panera','chick-fil','wing stop','bistro','grill ','kitchen ','eatery','diner','steakhouse','seafood','noodle','ramen','taco bell','kfc','popeye','applebee',"chili's",'olive garden','red lobster','ihop',"denny's",'waffle house','cheesecake factory','cracker barrel','culver','sonic drive','dairy queen','five guys','shake shack','whataburger','wingstop','zaxby']],
    ['groceries',     ['grocery','supermarket','whole foods','trader joe','safeway','kroger','publix','costco',"sam's club",'aldi','lidl','food lion','wegman','sprouts','h-e-b','giant food','stop & shop','market basket','fresh market','vons','ralphs','jewel','albertson','smart & final','winco','meijer','hy-vee','price chopper','food 4 less','save a lot','fresh thyme']],
    ['gas',           ['shell ','bp ','exxon','chevron','mobil','speedway','circle k','marathon oil','sunoco','arco','wawa','quiktrip','racetrac',"casey's",'gas station','fuel ','petroleum','kwik trip','holiday station','pilot flying','loves travel','ta travel']],
    ['travel',        ['delta air','united air','american air','southwest air','jetblue','alaska air','frontier air','spirit air','hotel ','marriott','hilton','hyatt','airbnb','vrbo','airport','airline ','lounge','hertz','avis','enterprise rent','national rent','budget rent','car rental','amtrak','expedia','priceline','booking.com','kayak','travelport','concur','egencia','navan','trip.com','trivago','hotwire','orbitz']],
    ['subscriptions', ['netflix','spotify','hulu','disney+','amazon prime','apple.com','google storage','microsoft 365','adobe','dropbox','zoom','github ','notion ','figma ','slack ','patreon','youtube premium','paramount+','peacock','max.com','chatgpt','openai','twitch','crunchyroll','funimation','shudder','mubi','starz','showtime','apple tv','google one','icloud','siriusxm','pandora','tidal ']],
    ['shopping',      ['amazon.com','amazon mktpl','ebay','etsy','best buy','home depot',"lowe's",'ikea','nordstrom','macy','gap ','zara','h&m','nike','adidas','apple store','wayfair','chewy','sephora','ulta','target.com','newegg','b&h photo','micro center','shopify','overstock','wish.com','shein','temu','dhgate','poshmark','mercari','depop','thredup']],
    ['healthcare',    ['pharmacy','cvs ','walgreen','rite aid','doctor','dental','vision','hospital','medical ','urgent care','clinic','quest diag','labcorp','prescription','optum','humana','psychiatry','therapy','chiropract','physical therapy','minute clinic','care now','concentra','teladoc','doctorondemand','amazon pharmacy','costco pharmacy']],
    ['utilities',     ['verizon ','t-mobile','at&t ','spectrum','xfinity','comcast','internet','utility ','con ed','pge','duke energy','dominion','national grid','water bill','cable bill','electric bill','fpl ','nv energy','puget sound','consumers energy','entergy','evergy']],
    ['entertainment', ['movie','theater','cinema','ticketmaster','stubhub','eventbrite','museum','concert','bowling','golf ','gym ','fitness','peloton','equinox','anytime fitness','planet fitness','spa ','massage','escape room','comedy club','dave & buster','top golf','main event','lucky strike','amc ','regal ','cinemark','imax']],
    ['transport',     ['uber ','lyft ','taxi ','transit ','metro card','parking ','toll ','e-z pass','sunpass','ipass','zipcar','bird ','lime ','scooter','cta ','mta ','bart ','septa ','wmata','mbta','trimet','nj transit','go transit']],
    ['education',     ['udemy','coursera','skillshare','masterclass','linkedin learn','duolingo','school ','university','tuition','textbook','chegg','khan academy','brilliant.org','pluralsight','codecademy','treehouse','launchschool','bootcamp']],
  ];
  for (const [cat, keywords] of rules) {
    if (keywords.some(kw => d.includes(kw))) return cat;
  }
  return 'other';
}

async function getUserFromJWT(supabase, event) {
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return null;
  const { data: { user }, error } = await supabase.auth.getUser(jwt);
  if (error || !user) return null;
  return user;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const { connectionId } = JSON.parse(event.body || '{}');

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase not configured' }) };
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const user = await getUserFromJWT(supabase, event);
  const userId = user?.id || null;
  console.log('[tx] userId:', userId || '(no JWT)');

  try {
    // Get enrollments — look up by connection's enrollmentId first (handles orphaned rows)
    let enrollments = [];
    if (connectionId) {
      // Find connection without user_id filter to support orphaned connections
      const { data: connRow } = await supabase.from('connections').select('data').eq('id', connectionId).single();
      const enrollmentId = connRow?.data?.enrollmentId;
      if (enrollmentId) {
        // Look up enrollment by enrollmentId only — no user_id filter (handles orphaned enrollments)
        const { data: found, error: enrollErr } = await supabase
          .from('enrollments').select('*').eq('enrollment_id', enrollmentId);
        if (enrollErr) throw new Error('enrollments: ' + enrollErr.message);
        enrollments = found || [];
        if (!enrollments.length && userId) {
          console.warn('[tx] enrollment not found for enrollmentId:', enrollmentId);
        }
      }
    } else {
      // No connectionId — load all enrollments for this user
      let q = supabase.from('enrollments').select('*');
      if (userId) q = q.eq('user_id', userId);
      const { data: found, error: enrollErr } = await q;
      if (enrollErr) throw new Error('enrollments: ' + enrollErr.message);
      enrollments = found || [];
      // If user-scoped query returned nothing, it could be orphaned — nothing safe to fall back to here
    }
    if (!enrollments?.length) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ transactions: [], count: 0 }) };
    }

    // Load existing transactions to preserve user overrides
    let existingQuery = supabase.from('transactions').select('id, data');
    if (userId) existingQuery = existingQuery.eq('user_id', userId);
    const { data: existingRows } = await existingQuery;
    const existingMap = {};
    for (const row of existingRows || []) {
      if (row.id && row.data) existingMap[row.id] = row.data;
    }

    // Build enrollment_id → connection_id map
    const { data: connRows } = await supabase.from('connections').select('id, user_id, data');
    const connMap = {};
    for (const cr of connRows || []) {
      if (cr.data?.enrollmentId) connMap[cr.data.enrollmentId] = cr.id;
    }

    const allTxs = [];

    for (const enrollment of enrollments) {
      let accounts;
      try {
        accounts = await tellerRequest('/accounts', enrollment.access_token);
      } catch (e) {
        if (e.disconnected) { console.warn('[tx] enrollment disconnected:', enrollment.id); continue; }
        console.warn('[tx] /accounts failed for enrollment', enrollment.id, ':', e.message);
        continue;
      }

      const creditAccounts = Array.isArray(accounts) ? accounts.filter(a => a.type === 'credit') : [];
      const connId = connMap[enrollment.enrollment_id] || '';
      const enrollUserId = enrollment.user_id || userId;

      for (const account of creditAccounts) {
        let txs;
        try {
          txs = await tellerRequest(`/accounts/${account.id}/transactions?count=200`, enrollment.access_token);
        } catch (e) {
          if (e.disconnected) break;
          console.warn('[tx] /transactions failed for account', account.id, ':', e.message);
          continue;
        }
        if (!Array.isArray(txs)) continue;

        const cardId = 'teller_' + account.id.slice(-8);

        for (const tx of txs) {
          const prev = existingMap[tx.id];
          allTxs.push({
            id: tx.id,
            card_id: cardId,
            connection_id: connId,
            account_id: account.id,
            user_id: enrollUserId,
            amount: parseFloat(tx.amount) || 0,
            description: tx.description || '',
            category: autoCategory(tx.description || ''),
            user_category: prev?.user_category || null,
            tx_date: tx.date,
            status: tx.status || 'posted',
            notes: prev?.notes || '',
            tags: prev?.tags || [],
            split_data: prev?.split_data || null,
          });
        }
      }
    }

    // Upsert in batches of 100
    for (let i = 0; i < allTxs.length; i += 100) {
      const chunk = allTxs.slice(i, i + 100);
      const rows = chunk.map(tx => ({
        id: tx.id,
        card_id: tx.card_id,
        tx_date: tx.tx_date,
        user_id: tx.user_id || null,
        data: tx,
        updated_at: new Date().toISOString(),
      }));
      const { error } = await supabase.from('transactions').upsert(rows);
      if (error) console.warn('[tx] upsert error:', error.message);
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ transactions: allTxs, count: allTxs.length }) };
  } catch (err) {
    console.error('[tx] error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
