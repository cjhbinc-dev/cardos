/**
 * CardOS — Amex Offers Scraper
 *
 * Usage:
 *   node scripts/sync-amex-offers.js
 *
 * What it does:
 *   1. Opens real Chrome (headed — you see it)
 *   2. Navigates to americanexpress.com/en-us/benefits/offers/
 *   3. You log in normally (handles 2FA, MFA, whatever Amex throws)
 *   4. Script auto-scrolls + clicks "Load More" to pull in every offer
 *   5. Intercepts Amex's own API responses to capture offer data cleanly
 *   6. Saves all offers to your Supabase offers table
 *
 * Requires a .env.local file with:
 *   SUPABASE_URL=https://urkeufuebcvlsrkigqij.supabase.co
 *   SUPABASE_SERVICE_KEY=your_service_key
 *   CARDOS_USER_EMAIL=cj.hbinc@gmail.com   (your CardOS login email, to find your user_id)
 */

require('dotenv').config({ path: '.env.local' });
const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');
const readline = require('readline');

// ── Config ────────────────────────────────────────────────────────────────────
const SUPABASE_URL       = process.env.SUPABASE_URL;
const SUPABASE_KEY       = process.env.SUPABASE_SERVICE_KEY;
const CARDOS_USER_EMAIL  = process.env.CARDOS_USER_EMAIL;

const AMEX_OFFERS_URL = 'https://www.americanexpress.com/en-us/benefits/offers/';

// ── Helpers ───────────────────────────────────────────────────────────────────
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseDate(str) {
  if (!str) return null;
  const d = new Date(str);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);
  const m = str.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const year = m[3].length === 2 ? '20' + m[3] : m[3];
    return new Date(`${year}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`).toISOString().slice(0,10);
  }
  return null;
}

function extractAmount(str) {
  if (!str) return 0;
  const m = str.match(/\$\s*(\d+(?:\.\d{1,2})?)/);
  return m ? parseFloat(m[1]) : 0;
}

function parseAmexApiResponse(json, cardId) {
  const offers = [];

  const containers = [
    json?.offers,
    json?.data?.offers,
    json?.offersList,
    json?.data?.offersList,
    json?.response?.offers,
    json?.amexOffers,
  ].filter(Array.isArray);

  for (const list of containers) {
    for (const o of list) {
      const merchant =
        o.merchantName || o.merchant?.name || o.merchantDisplayName ||
        o.title || o.offerTitle || o.name || 'Unknown';

      const description =
        o.offerText || o.description || o.offerTitle || o.offerDescription ||
        o.headline || o.title || '';

      const savings =
        o.offerAmt || o.savingsAmount || o.discountAmount ||
        extractAmount(o.offerText || o.title || o.description || '');

      const expiresDate =
        parseDate(o.endDate || o.expiryDate || o.offerEndDate ||
                  o.validThrough || o.expireDate || o.expirationDate || '');

      const enrollStatus =
        (o.enrollmentStatus || o.status || '').toUpperCase();
      const status = enrollStatus.includes('ENROLLED') ? 'added' : 'available';

      const category =
        o.merchantCategory || o.category || o.offerCategory || '';

      if (merchant && merchant !== 'Unknown') {
        offers.push({
          id: 'amex_' + (o.offerKey || o.offerId || o.id || Date.now() + '_' + offers.length),
          cardId,
          merchant,
          description: description.slice(0, 200),
          savings: typeof savings === 'number' ? savings : parseFloat(savings) || 0,
          expiresDate,
          category: category || 'General',
          status,
          isHighValue: (savings >= 50),
          isEasyWin: (savings > 0 && savings <= 25),
          source: 'amex-api',
          syncedAt: new Date().toISOString(),
        });
      }
    }
  }
  return offers;
}

// ── Auto-scroll: scrolls the page in steps to trigger lazy-loaded offers ──────
async function autoScrollAndLoad(page) {
  console.log('  ↳ Auto-scrolling to load all offers…');

  let previousOfferCount = 0;
  let unchangedRounds = 0;
  const MAX_UNCHANGED = 3; // stop after 3 rounds with no new content

  while (unchangedRounds < MAX_UNCHANGED) {
    // Click any visible "Load more", "Show more", "See all offers" buttons
    const clicked = await page.evaluate(() => {
      const btnTexts = /load more|show more|see all|view more|more offers/i;
      const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      let found = false;
      for (const btn of buttons) {
        if (btnTexts.test(btn.innerText || btn.textContent || '')) {
          btn.click();
          found = true;
        }
      }
      return found;
    });

    if (clicked) {
      console.log('  ↳ Clicked "Load more" button…');
      await sleep(2000);
    }

    // Scroll down in steps
    await page.evaluate(async () => {
      await new Promise(resolve => {
        const distance = 400;
        const delay = 120;
        const timer = setInterval(() => {
          window.scrollBy(0, distance);
          if ((window.innerHeight + window.scrollY) >= document.body.scrollHeight - 100) {
            clearInterval(timer);
            resolve();
          }
        }, delay);
      });
    });

    await sleep(1500);

    // Count offer tiles to detect if new ones loaded
    const currentCount = await page.evaluate(() => {
      const selectors = [
        '[class*="offer-tile"]', '[class*="OfferTile"]',
        '[class*="offer-card"]', '[class*="OfferCard"]',
        '[data-module-name*="offer"]', '[class*="benefitCard"]',
        '[class*="offer_tile"]', '[class*="offerTile"]',
      ];
      for (const sel of selectors) {
        const found = document.querySelectorAll(sel);
        if (found.length) return found.length;
      }
      return 0;
    });

    console.log(`  ↳ Offer tiles visible: ${currentCount}`);

    if (currentCount === previousOfferCount) {
      unchangedRounds++;
    } else {
      unchangedRounds = 0;
      previousOfferCount = currentCount;
    }

    // Scroll back to top briefly to trigger any header-based lazy loading
    if (unchangedRounds === 1) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await sleep(800);
    }
  }

  console.log(`  ↳ Scroll complete — ${previousOfferCount} offer tiles found on page`);
}

// ── Switch between card tabs if multiple Amex cards ───────────────────────────
async function switchCardTabs(page) {
  const tabs = await page.evaluate(() => {
    const tabSelectors = [
      '[class*="card-tab"]', '[class*="CardTab"]',
      '[role="tab"]', '[class*="accountTab"]',
      '[class*="cardSelector"]', '[class*="card-selector"]',
    ];
    for (const sel of tabSelectors) {
      const found = Array.from(document.querySelectorAll(sel));
      if (found.length > 1) {
        return found.map((t, i) => ({ index: i, text: (t.innerText || '').trim().slice(0, 60) }));
      }
    }
    return [];
  });

  if (tabs.length <= 1) return; // only one card, already loaded

  console.log(`\n  ↳ Found ${tabs.length} card tabs — cycling through each to load all offers…`);

  for (let i = 0; i < tabs.length; i++) {
    if (i === 0) continue; // first tab is already active

    const clicked = await page.evaluate((idx) => {
      const tabSelectors = [
        '[class*="card-tab"]', '[class*="CardTab"]',
        '[role="tab"]', '[class*="accountTab"]',
        '[class*="cardSelector"]', '[class*="card-selector"]',
      ];
      for (const sel of tabSelectors) {
        const found = document.querySelectorAll(sel);
        if (found.length > idx) {
          found[idx].click();
          return true;
        }
      }
      return false;
    }, i);

    if (clicked) {
      console.log(`  ↳ Switched to card tab ${i + 1}: ${tabs[i]?.text || ''}`);
      await sleep(2500);
      await autoScrollAndLoad(page);
    }
  }

  // Go back to first tab
  await page.evaluate(() => {
    const tabSelectors = [
      '[class*="card-tab"]', '[class*="CardTab"]',
      '[role="tab"]', '[class*="accountTab"]',
      '[class*="cardSelector"]', '[class*="card-selector"]',
    ];
    for (const sel of tabSelectors) {
      const found = document.querySelectorAll(sel);
      if (found.length) { found[0].click(); return; }
    }
  });
  await sleep(1500);
}

// ── DOM fallback — scrape visible offer tiles if API interception missed them
async function scrapeOffersDom(page, cardId) {
  return await page.evaluate((cid) => {
    const results = [];
    const selectors = [
      '[class*="offer-tile"]', '[class*="OfferTile"]',
      '[class*="offer-card"]', '[class*="OfferCard"]',
      '[data-module-name*="offer"]', '[class*="benefitCard"]',
      '[class*="offer_tile"]', '[class*="offerTile"]',
    ];
    let tiles = [];
    for (const sel of selectors) {
      const found = Array.from(document.querySelectorAll(sel));
      if (found.length) { tiles = found; break; }
    }

    for (const tile of tiles) {
      const text = tile.innerText || tile.textContent || '';

      const hEl = tile.querySelector('h2,h3,h4,[class*="title"],[class*="merchant"],[class*="name"]');
      const merchant = hEl?.innerText?.trim() || text.split('\n')[0]?.trim() || '';

      const savingsM = text.match(/\$\s*(\d+(?:\.\d{1,2})?)/);
      const savings = savingsM ? parseFloat(savingsM[1]) : 0;

      const pEl = tile.querySelector('p,[class*="desc"],[class*="terms"],[class*="detail"]');
      const description = pEl?.innerText?.trim() || '';

      const expM = text.match(/(?:Exp(?:ires?)?\.?|Valid through|Through|by)\s+(\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Za-z]+ \d{1,2},?\s*\d{4})/i);
      let expiresDate = null;
      if (expM) { const d = new Date(expM[1]); if (!isNaN(d)) expiresDate = d.toISOString().slice(0,10); }

      const addedText = text.toLowerCase();
      const status = (addedText.includes('added to card') || addedText.includes('enrolled')) ? 'added' : 'available';

      if (merchant) {
        results.push({
          id: 'amex_dom_' + Math.random().toString(36).slice(2),
          cardId: cid,
          merchant,
          description: description.slice(0, 200),
          savings,
          expiresDate,
          category: 'General',
          status,
          isHighValue: savings >= 50,
          isEasyWin: savings > 0 && savings <= 25,
          source: 'amex-dom',
          syncedAt: new Date().toISOString(),
        });
      }
    }
    return results;
  }, cardId);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   CardOS — Amex Offers Sync              ║');
  console.log('╚══════════════════════════════════════════╝\n');

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('✗  Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env.local');
    console.error('   Create a .env.local file with those values and run again.\n');
    process.exit(1);
  }

  // ── Connect to Supabase ────────────────────────────────────────────────────
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  let userId = null;
  if (CARDOS_USER_EMAIL) {
    const { data: usersData } = await supabase.auth.admin.listUsers({ perPage: 500 });
    const match = (usersData?.users || []).find(u => u.email?.toLowerCase() === CARDOS_USER_EMAIL.toLowerCase());
    if (match) {
      userId = match.id;
      console.log(`✓  Linked to CardOS user: ${CARDOS_USER_EMAIL} (${userId.slice(0,8)}…)\n`);
    } else {
      console.warn(`⚠  No CardOS user found for ${CARDOS_USER_EMAIL} — offers will be saved without user_id\n`);
    }
  }

  // ── Get Amex cards from Supabase ───────────────────────────────────────────
  let cardsQuery = supabase.from('cards').select('id,data');
  if (userId) cardsQuery = cardsQuery.eq('user_id', userId);
  const { data: cardRows } = await cardsQuery;
  const amexCards = (cardRows || [])
    .map(r => r.data)
    .filter(c => c && c.issuerId === 'amex');

  let defaultCardId = amexCards[0]?.id || null;

  if (amexCards.length === 0) {
    console.warn('⚠  No Amex cards found in your CardOS account.');
    console.warn('   Add your Amex card(s) in CardOS first, then re-run this script.\n');
  } else if (amexCards.length === 1) {
    console.log(`✓  Amex card: ${amexCards[0].name} ••${amexCards[0].last4}\n`);
  } else {
    console.log('Your Amex cards:');
    amexCards.forEach((c, i) => console.log(`  [${i+1}] ${c.name} ••${c.last4}`));
    const pick = await ask('\nWhich card are you scraping offers for? (enter number, or 0 for all): ');
    const idx = parseInt(pick) - 1;
    if (idx >= 0 && amexCards[idx]) defaultCardId = amexCards[idx].id;
  }

  // ── Launch Chrome ──────────────────────────────────────────────────────────
  console.log('▶  Opening Chrome…');
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: ['--start-maximized', '--no-sandbox'],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const page = await browser.newPage();

  // ── Intercept API responses ────────────────────────────────────────────────
  const capturedOffers = [];
  const seenOfferIds = new Set();

  page.on('response', async (response) => {
    const url = response.url();
    const ct  = (response.headers()['content-type'] || '').toLowerCase();
    if (!url.includes('americanexpress.com')) return;
    if (!ct.includes('json')) return;
    if (!/offer|benefit|amexoffer/i.test(url)) return;

    try {
      const json = await response.json();
      const parsed = parseAmexApiResponse(json, defaultCardId);
      for (const o of parsed) {
        if (!seenOfferIds.has(o.id)) {
          seenOfferIds.add(o.id);
          capturedOffers.push(o);
        }
      }
      if (parsed.length) {
        console.log(`  ↳ API captured ${parsed.length} offer(s) from ${url.split('?')[0].split('/').pop()}`);
      }
    } catch (_) {}
  });

  // ── Navigate to Amex offers ────────────────────────────────────────────────
  console.log('▶  Navigating to Amex offers page…\n');
  await page.goto(AMEX_OFFERS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

  console.log('═══════════════════════════════════════════════════════');
  console.log('  Chrome is open. Please:');
  console.log('  1. Log in to your Amex account (handle 2FA if prompted)');
  console.log('  2. Navigate to the Amex Offers page');
  console.log('  3. Press Enter here once you can see your offers');
  console.log('  (The script will auto-scroll and load everything for you)');
  console.log('═══════════════════════════════════════════════════════\n');

  await ask('Press Enter once you are logged in and on the offers page… ');

  // ── Auto-load all offers ───────────────────────────────────────────────────
  console.log('\n▶  Auto-loading all offers…');
  await sleep(1000);

  // First pass on the current tab
  await autoScrollAndLoad(page);

  // Switch between card tabs if multiple cards
  await switchCardTabs(page);

  // Final scroll on whatever tab is active
  await autoScrollAndLoad(page);

  // ── DOM fallback if API capture missed things ──────────────────────────────
  console.log('\n▶  Scraping visible offers from page as backup…');
  const domOffers = await scrapeOffersDom(page, defaultCardId);
  for (const o of domOffers) {
    if (!seenOfferIds.has(o.id)) {
      seenOfferIds.add(o.id);
      capturedOffers.push(o);
    }
  }

  await browser.close();

  console.log(`\n✓  Total offers captured: ${capturedOffers.length}`);

  if (capturedOffers.length === 0) {
    console.log('\n⚠  No offers were captured.');
    console.log('   This can happen if Amex changed their page structure.');
    console.log('   Open browser DevTools → Network tab → filter "offers"');
    console.log('   to see what API calls Amex is making, and report the URL pattern.\n');
    process.exit(0);
  }

  // ── Preview ────────────────────────────────────────────────────────────────
  console.log('\nPreview (first 5):');
  capturedOffers.slice(0, 5).forEach(o => {
    console.log(`  • ${o.merchant.padEnd(30)} $${String(o.savings).padStart(6)}  ${o.status}  expires ${o.expiresDate || '?'}`);
  });
  if (capturedOffers.length > 5) console.log(`  … and ${capturedOffers.length - 5} more`);

  const confirm = await ask(`\nSave all ${capturedOffers.length} offers to CardOS? (y/n): `);
  if (confirm.toLowerCase() !== 'y') {
    console.log('\nAborted — nothing saved.\n');
    process.exit(0);
  }

  // ── Save to Supabase ───────────────────────────────────────────────────────
  console.log('\n▶  Saving to Supabase…');
  let saved = 0, skipped = 0;

  for (const offer of capturedOffers) {
    const row = { id: offer.id, data: offer };
    if (userId) row.user_id = userId;

    const { error } = await supabase.from('offers').upsert(row, { onConflict: 'id' });
    if (error) {
      console.error(`  ✗  ${offer.merchant}: ${error.message}`);
      skipped++;
    } else {
      saved++;
    }
  }

  console.log(`\n✓  Done! Saved: ${saved}  Skipped/errors: ${skipped}`);
  console.log('   Open CardOS → Amex Offers to see your offers.\n');
}

main().catch(err => {
  console.error('\n✗  Fatal error:', err.message);
  process.exit(1);
});
