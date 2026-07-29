# CardOS — audit context

Read this first, then `../index.html`, `../netlify/functions/*.js`, and `../PROJECT.md`.
This file exists to give an auditor full structural context. **No real user data
is in this repo** — sample shapes are in `sample-data.json` and are synthetic.

## What it is
A personal credit-card manager: track cards, balances, utilization, due dates,
benefits/credits, transactions, budgets, a payoff calculator, and Amex offers.
Single-user-per-account; bank data via Plaid; auth + storage via Supabase.

## Stack & files
- **Frontend:** one file, `index.html` (~7k lines, vanilla JS, no framework/build).
  All UI, state, and rendering live here. Styling is inline `<style>` (a dark
  "neon" theme is the enforced default).
- **Backend:** `netlify/functions/*.js` (Node, esbuild-bundled by Netlify).
- **DB/Auth:** Supabase (Postgres + Auth + RLS). Functions use the
  **service-role key** (bypasses RLS) so scoping must be enforced *in the query
  filters*, not relied on from RLS.
- **Bank data:** Plaid (production). Every linked Item costs money; `/item/remove`
  must fire on delete.
- **Deploy:** manual Netlify CLI (`netlify deploy`). No CI/auto-deploy from git.

## Screens / features to review (every one)
Sign-in gate · Dashboard (summary line, utilization ring, alerts, recommended
actions, card tiles w/ 3D flip, count-up, sparklines) · My Cards (grid, filters,
per-card photo upload + generated skin toggle) · Transactions (KPIs, category
donut, month-over-month, list) · Alerts · Calendar (due/close dates) · Budgets ·
Calculators · **Reports → payoff calculator + avalanche/snowball strategy** ·
Ledger · Connections + Add-connection (Plaid Link) modal · Card Benefits (ROI /
realized-value) · Knowledge · Admin (feedback queue + card-art review) · Card
detail/flip modal · AI assistant (floating) · crowd-sourced card-art
upload/share/approve flow · mobile bottom tab bar · cursor-tracking eyes.

## Data model (Supabase)
Most domain objects are stored as JSON blobs keyed by user:
- **cards**: `(id uuid pk, user_id uuid, data jsonb)` — `data` is the full card
  object; see `sample-data.json`. Written via `upsert({id, user_id, data})`.
- **transactions**, **offers**: same `(id, user_id, data jsonb)` shape.
- **feedback**: `(id, user_id, category, message, metadata jsonb, status,
  admin_note, created_at, updated_at)`; RLS owner-only; status enum default `new`.
- **card_art** (crowd-sourced images): `(id, product_key, issuer, product_name,
  image text, contributor_user_id, status ∈ pending|approved|rejected, admin_note,
  reviewed_by, created_at, updated_at)`; RLS: read where `status='approved'`;
  writes only via the service-key function. Only *approved* rows are ever served.
- **access requests / allowlist**: gate signup (email + status).

## Backend functions (auth model)
Each function verifies the caller's Supabase JWT via `supabase.auth.getUser(jwt)`
and scopes to `user.id`. Admin-only endpoints additionally check
`user.email === process.env.ADMIN_EMAIL` **server-side**.
- Plaid: link/token/create, item/public_token/exchange, accounts/get,
  transactions/sync, **item/remove** (billing kill-switch), webhook verify.
- `submit-feedback`, `list-feedback` (admin), `card-art` (submit + approved-read +
  admin approve/reject), `ai-chat` (Claude API, JWT-gated), access/approval,
  daily sync/backup crons.

## Env vars (names only — never in the repo)
`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `PLAID_CLIENT_ID`, `PLAID_SECRET`,
`PLAID_ENV`, `ADMIN_EMAIL`, `NOTIFICATION_EMAIL`, `ANTHROPIC_API_KEY`,
`AI_MODEL` (optional), `SENDGRID_API_KEY` (optional). Frontend ships only the
public Supabase URL + anon key (safe by design).

## Known focus areas for the audit
1. **XSS:** the frontend builds a lot of DOM via `innerHTML` / template literals
   with card names, notes, and user-uploaded card-art image data — check for
   unescaped sinks (there's an `esc()` helper; verify it's used everywhere).
2. **Authz:** confirm every function scopes to `user_id` and admin gates are
   server-side, not just UI-hidden.
3. **Plaid billing:** confirm `/item/remove` on every delete path; note the
   manual (non-Plaid) delete is optimistic (deletes locally then server).
4. **Stale cache:** localStorage-first paint; see the cache-layer map in
   `../PROJECT.md`.
5. **UI/UX:** responsive (desktop 1200px container vs mobile bottom-nav),
   touch targets, contrast/WCAG, empty/error/loading states, consistency.

## Viewing the running UI
The app requires login, so code-only tools can't see rendered pixels. Judge
visual design from screenshots (captured at 1920 + 390) — do **not** ask for
Netlify credentials or any env var value.
