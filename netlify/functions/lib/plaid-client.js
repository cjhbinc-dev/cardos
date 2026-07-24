// Shared Plaid + Supabase helpers for all plaid-* functions.
//
// Auth contract (strict, multi-user): every caller-facing function MUST
//   1) verify the Supabase JWT (401 otherwise — no anonymous path),
//   2) scope every enrollments/connections/cards query to the verified user_id,
//   3) verify ownership of any client-supplied connectionId/itemId before use.
// There are deliberately NO orphaned-row fallbacks here. Access tokens never
// leave the server.
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

function getPlaidClient() {
  const env = (process.env.PLAID_ENV || 'production').toLowerCase();
  return new PlaidApi(new Configuration({
    basePath: PlaidEnvironments[env] || PlaidEnvironments.production,
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
        'PLAID-SECRET': process.env.PLAID_SECRET,
      },
    },
  }));
}

function getSupabaseAdmin() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// Verify the caller's JWT. Returns the Supabase user or null.
async function getUserFromJWT(supabase, event) {
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return null;
  const { data: { user }, error } = await supabase.auth.getUser(jwt);
  if (error || !user) return null;
  return user;
}

// Normalize a Plaid SDK error. Always logs endpoint + error_code + request_id —
// request_id is what Plaid support asks for.
function plaidErrorInfo(endpoint, err) {
  const data = err?.response?.data || {};
  const info = {
    endpoint,
    error_code: data.error_code || err.code || 'UNKNOWN',
    error_type: data.error_type || null,
    error_message: data.error_message || err.message,
    request_id: data.request_id || null,
    status: err?.response?.status || null,
  };
  console.error(`[plaid] ${endpoint} FAILED code=${info.error_code} request_id=${info.request_id} msg=${info.error_message}`);
  return info;
}

function logPlaidOk(endpoint, response) {
  const rid = response?.data?.request_id || null;
  console.log(`[plaid] ${endpoint} ok request_id=${rid}`);
}

// Derive CardOS issuerId (matching the frontend ISSUERS ids) from Plaid's
// institution_id (authoritative where known) with a normalized-name fallback.
// Plaid never returns our issuerId, so without this every Plaid card fails the
// first term of every benefit-template match and any issuer-keyed logic.
const PLAID_INSTITUTION_ISSUER = {
  ins_56: 'chase',       // Chase (verified from a real connection)
  ins_10: 'amex',        // American Express
  ins_5: 'citi',         // Citibank
  ins_9: 'boa',          // Bank of America
  ins_127991: 'wells',   // Wells Fargo
  ins_128026: 'capone',  // Capital One
  ins_33: 'usb',         // U.S. Bank
  ins_15: 'disc',        // Discover
  ins_128823: 'barc',    // Barclays
};
function guessIssuerId(institutionId, institutionName) {
  if (institutionId && PLAID_INSTITUTION_ISSUER[institutionId]) return PLAID_INSTITUTION_ISSUER[institutionId];
  const n = (institutionName || '').toLowerCase();
  if (n.includes('american express') || n.includes('amex')) return 'amex';
  if (n.includes('chase')) return 'chase';
  if (n.includes('citi')) return 'citi';
  if (n.includes('capital one')) return 'capone';
  if (n.includes('discover')) return 'disc';
  if (n.includes('bank of america')) return 'boa';
  if (n.includes('wells fargo')) return 'wells';
  if (n.includes('u.s. bank') || n.includes('us bank') || n.includes('usbank')) return 'usb';
  if (n.includes('barclay')) return 'barc';
  return 'other';
}

// Map a Plaid credit account to the CardOS card shape.
// Credit semantics (plaid.com/docs/api/accounts/): current = amount OWED,
// limit = credit limit, available = limit - current - pending outflows
// + pending inflows, and available CAN be null → fall back to limit - current.
// `inst` = { id, name } institution info, used to derive issuerId.
function mapPlaidAccountToCard(acc, connectionId, existing, inst) {
  const b = acc.balances || {};
  const owed = b.current != null ? Math.round(b.current) : 0;
  const limit = b.limit != null ? Math.round(b.limit) : 0;
  const currency = b.iso_currency_code || b.unofficial_currency_code || 'USD';

  const base = existing || {
    id: acc.account_id,
    statementClose: '', dueDate: '', minPayment: 0, apr: null,
    annualFee: 0, annualFeeMonth: null, autopay: false,
    rewardsType: '', rewardsNotes: '', notes: '',
  };

  // Derive issuerId, but never overwrite a user's explicit choice preserved on
  // an existing card (e.g. they corrected it or set it on a manual card).
  const issuerId = (existing && existing.issuerId && existing.issuerId !== 'other')
    ? existing.issuerId
    : guessIssuerId(inst?.id, inst?.name);

  return {
    ...base,
    id: base.id,
    issuerId,
    name: acc.official_name || acc.name || 'Credit Card',
    last4: acc.mask || base.last4 || '',
    balance: owed,
    limit: limit || base.limit || 0,
    currency,
    status: 'active',
    syncMethod: 'plaid',
    connectionId,
    plaidAccountId: acc.account_id,
    lastSync: new Date().toISOString().slice(0, 10),
    syncStatus: 'ok',
    syncError: null,
  };
}

module.exports = { CORS, getPlaidClient, getSupabaseAdmin, getUserFromJWT, plaidErrorInfo, logPlaidOk, mapPlaidAccountToCard, guessIssuerId };
