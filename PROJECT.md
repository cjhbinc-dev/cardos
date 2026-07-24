# CardOS — Project Knowledge

> **Rule:** any change to schema, env vars, integration state, or known issues updates
> this doc **in the same commit**. A stale knowledge doc is worse than none.

Last updated: 2026-07-23 (Part A — skeleton; sections marked *[fill: Phase N]* are pending)

## Stack and infrastructure

- **Frontend:** single-file vanilla JS app in `index.html` (~370 KB). No framework, no
  build step. Service worker registered for web push.
- **Backend:** Netlify Functions (Node, esbuild bundler) in `netlify/functions/`.
  Shared helpers in `netlify/functions/lib/`.
- **DB/Auth:** Supabase (project ref `urkeufuebcvlsrkigqij`). Supabase Auth JWTs;
  invite-only signup.
- **Hosting:** Netlify.
  - Production: `cardos-manager` (`e0ad41c8-9cab-4451-9102-64e89585c917`),
    https://cardos-manager.netlify.app — no custom domain.
  - Test: `stirring-tapioca-25776a` (`b6448247-b13f-4ce6-9656-59d1a76d5107`).
  - **The local Netlify CLI is linked to the TEST site** (relinked 2026-07-23 so a stray
    deploy can't hit prod). Production deploys require explicit
    `--site e0ad41c8-9cab-4451-9102-64e89585c917`. Confirm target before every deploy.
- **Scheduled functions** (netlify.toml): `notify-daily` 08:00 UTC,
  `backup-daily` 06:00 UTC. *[fill: Phase 1 — plaid-daily-sync schedule]*

## Data model (queried live 2026-07-23 via Supabase management API)

- `enrollments`: `id text PK`, `enrollment_id text`, `access_token text`,
  `institution_name text`, `created_at timestamptz`, `user_id uuid`,
  `item_id text`, `transaction_cursor text` (Plaid columns added 2026-07-23;
  for Plaid rows id = enrollment_id = item_id)
- `connections`: `id text PK`, `data jsonb`, `updated_at timestamptz`, `user_id uuid`.
  `data.type` routes integration: `'teller'` or `'plaid'`.
- `cards`: `id text PK`, `data jsonb`, `updated_at timestamptz`, `user_id uuid`
- Also: `transactions`, `offers`, `balance_history`, `allowed_emails`, `access_requests`.
  *[fill: Phase 8 — `feedback` table]*
- **RLS:** owner-only (`auth.uid() = user_id`) on all data tables. Backend functions use
  `SUPABASE_SERVICE_KEY`, which **bypasses RLS** — scoping must be enforced in query
  filters in every function.

## Integrations

### Teller (REMOVED 2026-07-23)
- Teller's API was winding down; CJ directed a complete removal (commit `7f31457`):
  all nine `teller-*` functions, `lib/teller-client.js`, frontend Connect flow, the
  `teller-daily-sync` cron, `certs/` (mTLS cert + key, never committed to git —
  verified no history for the path), and the four `TELLER_*` Netlify env vars.
- **Data loss record:** the financial tables (`connections`, `cards`, `transactions`,
  `enrollments`, `offers`, `balance_history`) were found **empty** on 2026-07-23 during
  the removal census. The cause is not determinable from an empty table and is recorded
  as **unknown**. Supabase PITR was disabled and the backups list was empty, so the
  Teller-era history is **irrecoverable**. `auth.users` (3) and `allowed_emails` (10)
  were unaffected. CJ confirmed the history is not needed.
- Remaining `teller` mentions live only in `index (13).html` (a blocked-from-deploy
  backup of the old app), `.gitignore`'s comment, and `.claude/settings.local.json`
  permission history — no live code path.

### Plaid
- Team **"Deez LLC"**, created 2026-04-25, **approved for Production**, Pay As You Go,
  no minimum. Client ID `69ec1089704b7e000dc6de60`. Both Sandbox and Production secrets
  exist; production secret was rotated (2026-07). Zero Items ever created before this
  build — the April 2026 integration was abandoned pre-first-use (tombstone functions,
  0 lifetime Items, 0 usage, 0 invoices).
- Rates: Balance **$0.10/call**, Transactions **$0.30/connected account/month**.
  Transactions bills per Item per month for as long as a valid access_token exists;
  `/item/remove` is the only off switch.
- Dashboard state (2026-07-23): Data Transparency use case **published** ("Track
  and manage your finances"). Allowed redirect URIs registered:
  `https://cardos-manager.netlify.app/` and
  `https://stirring-tapioca-25776a.netlify.app/` — update-mode link tokens must
  pass the same redirect_uri (they do, in plaid-create-link-token). App profile:
  saved with April-era reason text; multi-user reason text pending CJ's
  identity-verification + save. Products enabled: Balance + Transactions, each
  with 200 free trial credits ("0/200 free trial credits used").
- **Phase 1 backend built 2026-07-23** (doc URLs in each file header):
  `lib/plaid-client.js` (SDK wrapper, strict-auth helpers, request_id logging),
  `plaid-remove-item.js` (billing kill switch — /item/remove BEFORE local
  deletes; enrollment kept if it fails; admin can remove by item_id),
  `plaid-create-link-token.js` (days_requested=730 max, one-way door;
  update mode via ownership-verified server-side token lookup),
  `plaid-exchange-token.js` (persist token first; dedupe by institution+mask
  removes the duplicate Item; /accounts/get free; branding via
  /institutions/get_by_id), `plaid-sync.js` (/accounts/get only —
  ITEM_LOGIN_REQUIRED → {disconnected:true}), `plaid-fetch-transactions.js`
  (cursor advanced ONLY after page writes; empty next_cursor never persisted;
  time-boxed with hasMore continuation), `plaid-daily-sync.js` (cron 06:30 UTC,
  plaid-type connections only), `plaid-webhook.js` (ES256 signature verification;
  SYNC_UPDATES_AVAILABLE → sync, ITEM errors → disconnected). Frontend delConn
  routes type:'plaid' through plaid-remove-item with NO optimistic delete.
  (TEMP `plaid-diag.js` / `plaid-sandbox-test.js` were removed 2026-07-24.)
- Smoke test 2026-07-23: production /institutions/get ok,
  request_id 783ecd7c63fce20, total 10,029 US institutions.
- *[fill: Phase 4/5 — live Items list; Phase 6 — webhooks]*

## Env vars (names and purposes only — never values)

Netlify (`cardos-manager`), 723/4096 bytes after Teller removal (was 875), before
Plaid additions:
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY` — Supabase client/service
- `SUPABASE_ACCESS_TOKEN` — Supabase *management* API (migrations)
- `MIGRATION_SECRET` — gates `apply-migration`, `backup-daily`, `plaid-daily-sync` manual runs
- `ADMIN_EMAIL` — admin gate + always-allowed signup
- `NOTIFICATION_EMAIL` — alert/feedback destination
- `PLAID_ENV` — `production`; `PLAID_CLIENT_ID`; `PLAID_SECRET` (marked
  secret/write-only in Netlify — CLI cannot read it, functions can)
- **Removed 2026-07-24:** `VAPID_*` ×3 (push deleted), `GOOGLE_CLIENT_ID`/
  `GOOGLE_CLIENT_SECRET` were never set (Gmail deleted). Prod now **10 vars /
  573 bytes**.
- Test site (`stirring-tapioca-25776a`) carries: SUPABASE_URL, SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_KEY, ADMIN_EMAIL, MIGRATION_SECRET, PLAID_CLIENT_ID,
  PLAID_SECRET, PLAID_ENV, **PLAID_SECRET_SANDBOX**. All test-only; **remove at
  phase close**: SUPABASE_SERVICE_KEY, MIGRATION_SECRET, PLAID_SECRET,
  PLAID_SECRET_SANDBOX (the last now orphaned — the sandbox test fn was deleted;
  `plaid-webhook` keeps a harmless sandbox-key fallback that references it).

## Known issues

- **Stale-delete bug — diagnosed 2026-07-23, fixes in working tree pending live
  verification.** Server deletes worked (DB rows gone); the ghosts were client-side.
  Three mechanisms, all in `index.html`: (1) `INITIAL_SESSION` deliberately skipped
  `syncFromSupabase()`, so a refreshed tab rendered pure localStorage; (2)
  `loadTransactionsFromSupabase()` only overwrote local state when the server returned
  non-empty rows, so a server at 0 transactions could never clear local ghosts;
  (3) `delCard`/`delConn` were optimistic fire-and-forget — server failures only hit
  `console.warn`. All three fixed (sync on INITIAL_SESSION; accept empty results;
  check delete responses, toast + resync on failure). No service worker exists, so SW
  caching is ruled out. Verify live before trusting the Plaid delete path (Phase 4).
- Plaid dashboard account has 2FA off (flagged to CJ).
- **Feature audit 2026-07-24 — dead features removed** (see Decisions). Remaining
  data-thin-until-Plaid tabs (Calendar/Alerts/Reports) now show honest empty
  states; the Dashboard empty state is finalized in Part C per the locked spec.
- `web-push`, `googleapis`, `node-html-parser` remain in package.json but are now
  **unused** (push + Gmail deleted). Harmless (node_modules bloat only); prune on
  a future dependency pass.
- *[fill as found]*

## Backups and restore

- `backup-daily.js` (scheduled 06:00 UTC) exports `connections`, `cards`,
  `transactions`, `enrollments`, `offers`, `balance_history` to the **private**
  Supabase Storage bucket `backups` as `YYYY-MM-DD.json`, 30-day retention,
  same-day reruns overwrite. `access_token` fields are stripped wherever they appear —
  backups never hold credentials. Cost: storage only (KB–MB scale JSON; effectively $0
  at this data size).
- **Restore path:** download the wanted `backups/<date>.json` (Supabase Dashboard →
  Storage → backups, or `supabase.storage.from('backups').download()` with the service
  key), then for each table upsert its array back:
  `supabase.from(<table>).upsert(rows)` with the service key. Enrollment rows restore
  WITHOUT access tokens by design — Plaid connections must be re-linked via update
  mode/re-link after a restore; balances and history come back as data.
- PITR/daily backups: not active on this project (`pitr_enabled: false`, empty backup
  list at time of setup). If the plan is upgraded later, prefer PITR and keep this
  export as belt-and-suspenders.

## Decisions and why

- **Teller removed outright (2026-07-23, CJ's call)** — the API was winding down, the
  DB financial tables were already empty, and no user besides CJ had live connections;
  keeping dual-path routing bought nothing. Rollback point: git tag
  `pre-teller-removal` (= `0c00948`, last commit containing all Teller code).
- **Plaid functions use strict auth** (401 without valid JWT, ownership verified on
  every client-supplied id, no orphaned-row fallbacks). The old Teller functions'
  unscoped "orphaned row" fallbacks existed for pre-RLS legacy rows — that pattern is
  dead and must not return.
- **Daily JSON export before any Plaid write** — the empty-table discovery proved a
  bad delete is currently permanent. Recovery path ships before Plaid data exists.
- **`/accounts/get` over `/accounts/balance/get`** — cached balances are free;
  the Balance product meters $0.10/call. Daily sync across N cards would bill
  N × 30 × $0.10/mo for marginal freshness.
- **`plaid-remove-item.js` built first** — before any code path that can create an
  Item, there must be a working way to destroy one (subscription billing kill switch).
- **Reference material lives in `reference/plaid/`** — trimmed copies of Plaid's
  Quickstart + Postman example data; see its README for the demo-not-architecture
  warning.
- **`issuerId` derived on Plaid cards (2026-07-24).** Plaid never returns our
  `issuerId`, and `mapPlaidAccountToCard` originally omitted it — so every Plaid
  card failed the first term of every benefit-template match and any issuer-keyed
  logic. Now `guessIssuerId(institution_id, name)` in `lib/plaid-client.js`: an
  explicit `institution_id → issuerId` map (Chase ins_56, Amex ins_10, Citi ins_5,
  Capital One ins_128026, BofA ins_9, Wells ins_127991, USB ins_33, Discover
  ins_15, Barclays ins_128823) with a normalized-name fallback. Never overwrites a
  user's explicit issuer. All three Plaid paths pass institution info, so existing
  Plaid cards backfill on next sync.
- **Benefit catalog covers six premium cards only** and nothing else: Amex
  Platinum, Amex Gold, Chase Sapphire Reserve, Chase Sapphire Preferred, Citi
  Strata Premier, Capital One Venture X (hardcoded `BENEFIT_TEMPLATES` in
  index.html). Matching = `issuerId` + a confident product-name regex; if the
  bank's account label doesn't match, we **ask** (a "Which card is this?" picker)
  rather than guess — a Citi Double Cash must never inherit Strata benefits. The
  `card_benefits` Supabase table stores only per-card usage-tracking, not the
  catalog. `annualFee` comes from the template on match; `annualFeeMonth` is
  account-specific (no template can know it) and stays a manual field.
- **Gmail, push, Amex Offers, Setup & Deploy removed (2026-07-24 feature audit):**
  - *Gmail sync* (gmail-daily-check, gmail-parse-emails, gcal-sync,
    google-oauth-start/callback): GOOGLE_* creds were never set in prod, the
    single `google_oauth` token row was wiped, and the design was single-user
    (`id='google_oauth'`, not per-user). Plaid covers balances+transactions.
  - *Push* (push-subscribe.js, VAPID_* vars): no service worker ever existed, and
    `push-daily` (called by the old cron) never existed → 404 every run. Rebuild
    properly in Part C if the PWA lands, else not at all.
  - *Amex Offers* tab: no user-facing populate path (offers came from a local
    `scripts/sync-amex-offers.js` bookmarklet-scrape). Tab removed; `offers` table
    + script KEPT. `offers` is still read by backup-daily (dump), delete-card /
    admin-delete-user (cascade cleanup), migrate-data, apply-migration — none
    user-facing. `renderOffers`/`saveOffer` left dormant and guarded.
  - *Setup & Deploy* tab: stale, developer-facing, duplicated the Admin panel.
    Removed from sidebar + page. Nothing in it was still true worth keeping (the
    live config it displayed is now covered by get-config + this doc).
- **Plaid temp functions removed 2026-07-24 (not deferred to Phase 5):**
  `plaid-diag.js`, `plaid-sandbox-test.js`, and the admin `_failTest` hook in
  `plaid-fetch-transactions`. Production Plaid credentials are no longer reachable
  from any public URL. (Phase 3 update-mode + webhook were already verified via
  the sandbox harness before deletion.)
- **The July 23 wipe also took `budgets` and `card_benefits`** (both missed by the
  original census; both were empty and remain so). Full casualty list is now:
  cards, connections, transactions, enrollments, offers, balance_history, budgets,
  card_benefits. Survived: auth.users (3), allowed_emails (10).
- **Plaid Liabilities — investigated 2026-07-24, NOT enabled (report only).**
  `/liabilities/get` returns exactly what Calendar/Alerts/Reports lack for
  bank-connected cards: `next_payment_due_date`, `minimum_payment_amount`,
  `last_statement_balance`, `last_statement_issue_date`, `aprs[]`, `is_overdue`,
  `last_payment_amount/date`. Billing: docs show it in `billed_products` (per-Item
  subscription, like Transactions, not per-call). **Our contract shows no
  Liabilities rate** (Balance $0.10/call + Transactions $0.30/acct/mo are the only
  active products), so enabling requires adding it to the account (money decision —
  a hard stop). Adding to an existing Transactions-only Item is not clearly a
  direct-call product in the docs (Auth/Identity are named as direct-add;
  Liabilities is not) — safest is to include `liabilities` in the `products` array
  for NEW Items and use update mode for existing ones; confirm via sandbox before
  committing. Recommendation: worth it — it fixes the biggest bank-card gap — but
  gate on CJ's cost approval and a sandbox confirmation of the add-to-Item flow.

## Webhook domain-rename risk (READ before any domain change)

Webhooks are set **per-Item on the link token at creation** (`webhook:` in
`plaid-create-link-token`), so every Item is baked to the domain it was created
under (`cardos-manager.netlify.app`). If CardOS ever moves to a new domain,
**existing Items keep POSTing the old URL** and silently stop delivering
`SYNC_UPDATES_AVAILABLE` / `ITEM_LOGIN_REQUIRED` — connections made before the
move would quietly go stale. Remedy on any domain change: call
**`/item/webhook/update`** for every stored Item (iterate `enrollments`, update
each to the new URL), and update the `webhook:` value + the registered redirect
URIs for new Items.

## Gotchas (seeded from known failure modes — verify against live docs per phase)

1. **Empty `next_cursor` from `/transactions/sync`** means the historical pull is still
   running — sleep and re-poll (Quickstart pattern). **Never persist an empty cursor**;
   next run would reset to full history. Measure and report time-to-first-transaction.
2. **Credit balances are inverted vs checking:** `current` = amount owed,
   `available` ≈ limit − current (can be null), `limit` = credit limit. Map
   owed=current, limit=limit, available=available with limit−current fallback. Handle
   `iso_currency_code` null when `unofficial_currency_code` is set. Verify against the
   issuer's own app before trusting the UI.
3. **Pending → posted replaces the transaction:** pending tx is `removed`, posted added
   with a **different** `transaction_id`. Key UI on `transaction_id` or duplicates
   appear.
4. **RLS silent no-ops:** a Supabase write can "succeed" affecting zero rows (commit
   `646646d`). Every write through an RLS-enforced client uses `.select()` and checks
   returned rows.
5. **Deleted-connection ghost rendering** = Plaid billing leak. See Known issues.
6. **Duplicate Items:** linking the same card twice = two Items = two subscriptions.
   Dedupe at exchange time (institution + account mask), remove the new Item on match.
7. **Service worker caching:** if the SW caches API responses, fresh data won't render.
   Check the SW before debugging the backend.
8. **Check the vendor before debugging inward:** if institutions fail identically or
   something stops with no deploy between, check Plaid status page and read the error
   code literally first. (Teller wind-down cost days this way.)
9. **Sandbox-only test endpoints:** `/sandbox/item/reset_login` (forces
   ITEM_LOGIN_REQUIRED) and `/sandbox/item/fire_webhook`. Keep exactly one Sandbox Item
   for update-mode/webhook testing — free, no billable subscription. Everything else
   runs in Production.

## Plaid production-readiness checklist (dashboard-tracked)

| Dashboard item | Covered by | State |
|---|---|---|
| Set up front-end integration (OAuth, redirect URI) | Prereqs + Phase 2 | open |
| Call endpoints, set up webhooks | Phase 1, 6 | open |
| Build product-specific core workflows | Phase 1–2 | open |
| Build update mode | Phase 3 | open |
| User offboarding | Phase 1 (`plaid-remove-item`) | open |
| Port to production | Phase 5 | open |
| Duplicate Items | Phase 1 (dedupe at exchange) | open |
| Link conversion optimizations | Phase 2 (`onEvent` logging) | open |
| Logging | Phase 6 | open |

## Plaid Items ledger (every Item ever created, and its state)

| item_id | Environment | Institution | Purpose | State |
|---|---|---|---|---|
| *(none yet)* | | | | |
