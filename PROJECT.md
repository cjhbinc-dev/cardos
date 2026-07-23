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
  `institution_name text`, `created_at timestamptz`, `user_id uuid`
  *[fill: Phase 1 — add `item_id text`, `transaction_cursor text`]*
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
- Dashboard state (2026-07-23): Compliance Center "Action required" — App profile
  form filled (CardOS / https://cardos-manager.netlify.app / support email / 250-char
  reason) but **not yet submitted**. OAuth institution registration status not yet
  captured. *[fill: dashboard prerequisites + Phase 2 — redirect URI decision with doc
  citation]*
- *[fill: Phase 1 — functions built + doc URLs; Phase 4/5 — live Items list;
  Phase 6 — webhooks]*

## Env vars (names and purposes only — never values)

Netlify (`cardos-manager`), 723/4096 bytes after Teller removal (was 875), before
Plaid additions:
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY` — Supabase client/service
- `SUPABASE_ACCESS_TOKEN` — Supabase *management* API (migrations)
- `MIGRATION_SECRET` — gates `apply-migration` endpoint
- `ADMIN_EMAIL` — admin gate + always-allowed signup
- `NOTIFICATION_EMAIL` — alert/feedback destination
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` — web push
- `PLAID_ENV` — `production` (was a stale leftover; value is now the intended one)
- *[fill: Phase 0 — `PLAID_CLIENT_ID`, `PLAID_SECRET`; report new byte total]*

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
- Web push is likely broken independent of all this: VAPID env vars and
  `push-subscribe.js` exist but no service worker is registered anywhere (true in the
  pre-removal build too). Not blocking; flagged for later.
- Plaid dashboard account has 2FA off (flagged to CJ).
- `index (13).html` + `CardOS (1).html` backup files still in repo (blocked from
  serving); they contain the entire old Teller-era app. Candidates for deletion.
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
- *[fill as decided]*

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
