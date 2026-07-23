# Plaid reference material

Local copies of Plaid's official examples, trimmed to what CardOS actually needs.
Kept for offline pattern reference while building the `plaid-*.js` Netlify functions.

> **Warning — this is a demo, not architecture.** The Quickstart server has no
> authentication, no persistence, and stores a single global `ACCESS_TOKEN` in memory
> for exactly one user. Copy API call *patterns* from it (request shapes, pagination,
> error fields), never its structure. CardOS functions must verify the Supabase JWT and
> scope every query to `user_id` — see `netlify/functions/teller-sync.js` for the strict
> version of that pattern.

## What's here and what it's good for

### `quickstart/node-index.js` (from plaid/quickstart, node server)
- **`linkTokenCreate`** (~line 130–150): the request shape for `/link/token/create` —
  `user.client_user_id`, `products`, `transactions.days_requested` (demo uses 60),
  `redirect_uri` handling.
- **`transactionsSync` pagination loop** (~line 355–390): the canonical cursor loop.
  Two details that matter to us:
  1. `while (has_more)` — keep paging until Plaid says stop.
  2. **Empty `next_cursor` means "historical pull still running"** — the demo sleeps 2s
     and re-polls. Never persist an empty cursor; that resets the Item to full history
     on the next run (Known Failure Mode #1 in PROJECT.md).
- **`accountsGet` / `accountsBalanceGet`**: shows both call shapes. Note for billing:
  CardOS uses `/accounts/get` (free, cached balances), *not* `/accounts/balance/get`
  (metered Balance product, $0.10/call on our contract).
- **`itemRemove`** pattern for offboarding.

### `quickstart/frontend/` (React + vite demo client)
- `src/Components/` shows `Plaid.create({ token, onSuccess, onExit, onEvent })` usage
  and the token round-trip. CardOS is vanilla JS, so this is for the callback contract
  and event names only — do not port the React structure.

### `postman/`
- **There is no collection JSON in the archive.** Plaid hosts the collection on
  postman.com; `README-postman.md` has the fork link and setup steps. Kept here as the
  pointer plus workflow docs (env vars per environment, sandbox → production switch).
- **`example_data/*.json`** — real response shapes for Balance, Transactions, Auth,
  Identity, Assets. Useful for seeing exact field names/nesting (`balances.current`,
  `balances.available`, `balances.limit`, `iso_currency_code` vs
  `unofficial_currency_code`) without burning API calls. Remember: for **credit**
  accounts `current` = amount owed and `available` ≈ limit − current (Known Failure
  Mode #2).
- **`link.html`** — a minimal standalone Link page (public_token via CDN script, no
  backend). Handy for isolating "is Link itself working" from "is our backend working."

## What was deliberately dropped
- Quickstart `go/`, `java/`, `python/`, `ruby/` servers — we're Node only.
- Postman `images/` (2.6 MB of screenshots).
