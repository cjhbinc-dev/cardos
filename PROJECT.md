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
- **Scheduled functions** (netlify.toml): `teller-daily-sync` 07:00 UTC,
  `notify-daily` 08:00 UTC. *[fill: Phase 1 — plaid-daily-sync schedule]*

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

### Teller (staying in place, deactivation deferred)
- Teller's API is winding down. Existing `type:'teller'` connections, rows, columns, and
  functions **stay** until users migrate and Teller confirms data handling in writing.
- mTLS certs in `certs/`, loaded via `TELLER_CERT_B64`/`TELLER_CERT_PATH`.
- Known IDOR-shaped legacy fallbacks in teller functions (unscoped "orphaned row"
  lookups) — tracked as a separate task, deliberately NOT copied into Plaid functions
  and NOT fixed during the Plaid build.

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

Netlify (`cardos-manager`), 875/4096 bytes before Plaid additions:
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY` — Supabase client/service
- `SUPABASE_ACCESS_TOKEN` — Supabase *management* API (migrations)
- `MIGRATION_SECRET` — gates `apply-migration` endpoint
- `TELLER_APPLICATION_ID`, `TELLER_ENVIRONMENT`, `TELLER_CERT_PATH`, `TELLER_KEY_PATH`
  — Teller (do not touch)
- `ADMIN_EMAIL` — admin gate + always-allowed signup
- `NOTIFICATION_EMAIL` — alert/feedback destination
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` — web push
- `PLAID_ENV` — `production` (was a stale leftover; value is now the intended one)
- *[fill: Phase 0 — `PLAID_CLIENT_ID`, `PLAID_SECRET`; report new byte total]*

## Known issues

- Deleted connections still render on Dashboard and Transactions (open bug). Cosmetic
  for Teller; **a billing leak for Plaid** if the delete path shares the defect — a card
  can look deleted while its Item keeps billing. Must be checked in Phase 1/2.
- Teller functions: legacy unscoped fallbacks (IDOR-shaped), tracked separately.
- Plaid dashboard account has 2FA off (flagged to CJ).
- *[fill as found]*

## Decisions and why

- **Teller deactivated, not deleted** — existing connections' rows/columns/code paths
  are user data and routing infrastructure; Teller API wind-down only stops outbound
  calls. Nothing deleted until migration is complete and Teller confirms stored-data
  handling in writing.
- **Plaid functions use strict auth** (401 without valid JWT, ownership verified on
  every client-supplied id, no orphaned-row fallbacks) even though Teller functions are
  looser — the loose paths exist for pre-RLS legacy rows that can't occur for Plaid.
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
