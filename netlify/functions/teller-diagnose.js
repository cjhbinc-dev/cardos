/**
 * GET /.netlify/functions/teller-diagnose?userId=<uuid>
 *
 * Diagnostic endpoint — walks every step of the Teller sync chain for a
 * given user and reports exactly where it breaks:
 *   1. Cert loaded?
 *   2. Supabase reachable?
 *   3. Enrollment rows exist?
 *   4. Can we hit Teller /accounts for each enrollment?
 *   5. Can we hit /balances for each credit account?
 *
 * Returns a JSON report with pass/fail for every step and the raw Teller
 * error (code + message + HTTP status) so we can tell Teller vs Netlify.
 */
const { createClient } = require('@supabase/supabase-js');
const { getCertOptions } = require('./lib/teller-client');
const https = require('https');
const fs = require('fs');
const path = require('path');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

function rawTellerRequest(urlPath, accessToken, certOpts) {
  return new Promise((resolve) => {
    const auth = Buffer.from(accessToken + ':').toString('base64');
    const options = {
      hostname: 'api.teller.io',
      path: urlPath,
      method: 'GET',
      headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' },
      ...certOpts,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(data); } catch (_) {}
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          errorCode: body?.error?.code || null,
          errorMessage: body?.error?.message || null,
          rawBody: data.slice(0, 400),
          body,
        });
      });
    });
    req.on('error', (e) => resolve({ ok: false, status: 0, errorCode: 'network_error', errorMessage: e.message, rawBody: '', body: null }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ ok: false, status: 0, errorCode: 'timeout', errorMessage: 'Request to api.teller.io timed out after 8s', rawBody: '', body: null }); });
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const userId = event.queryStringParameters?.userId || null;
  const report = { userId, steps: [], summary: '' };

  // ── Step 1: Certificate ────────────────────────────────────────────────────
  const certOpts = getCertOptions();
  const certOk = !!(certOpts.cert && certOpts.key);
  const certSource = process.env.TELLER_CERT_B64 ? 'TELLER_CERT_B64 (env base64)'
    : process.env.TELLER_CERT_PATH ? `TELLER_CERT_PATH (${process.env.TELLER_CERT_PATH})`
    : 'NONE — no cert env vars set';

  // Show the exact paths that were checked so we can debug file-not-found issues
  const checkedPaths = process.env.TELLER_CERT_PATH ? [
    path.resolve(process.cwd(), process.env.TELLER_CERT_PATH),
    path.resolve(__dirname, process.env.TELLER_CERT_PATH),
    path.resolve(__dirname, '..', '..', '..', process.env.TELLER_CERT_PATH),
    path.resolve('/var/task', process.env.TELLER_CERT_PATH),
  ].map(p => p + ' → ' + (fs.existsSync(p) ? 'EXISTS' : 'not found')) : [];

  report.steps.push({
    step: '1_cert',
    ok: certOk,
    cwd: process.cwd(),
    dirname: __dirname,
    checkedPaths,
    detail: certOk
      ? `mTLS cert loaded from ${certSource} — cert ${certOpts.cert?.length} bytes, key ${certOpts.key?.length} bytes`
      : `FAIL: cert not loaded — source: ${certSource}`,
  });

  if (!certOk) {
    report.summary = 'BLOCKED at step 1: Teller mTLS certificate is not loaded. Set TELLER_CERT_B64 and TELLER_KEY_B64 in Netlify environment variables.';
    return { statusCode: 200, headers: CORS, body: JSON.stringify(report, null, 2) };
  }

  // ── Step 2: Supabase ───────────────────────────────────────────────────────
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    report.steps.push({ step: '2_supabase', ok: false, detail: 'FAIL: SUPABASE_URL or SUPABASE_SERVICE_KEY env var missing' });
    report.summary = 'BLOCKED at step 2: Supabase env vars not set.';
    return { statusCode: 200, headers: CORS, body: JSON.stringify(report, null, 2) };
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  let testQuery;
  try {
    testQuery = await supabase.from('enrollments').select('count', { count: 'exact', head: true });
  } catch (e) {
    report.steps.push({ step: '2_supabase', ok: false, detail: 'FAIL: Supabase threw — ' + e.message });
    report.summary = 'BLOCKED at step 2: cannot reach Supabase.';
    return { statusCode: 200, headers: CORS, body: JSON.stringify(report, null, 2) };
  }
  if (testQuery.error) {
    report.steps.push({ step: '2_supabase', ok: false, detail: 'FAIL: ' + testQuery.error.message });
    report.summary = 'BLOCKED at step 2: Supabase query failed — ' + testQuery.error.message;
    return { statusCode: 200, headers: CORS, body: JSON.stringify(report, null, 2) };
  }
  report.steps.push({ step: '2_supabase', ok: true, detail: 'Supabase reachable — enrollments table exists' });

  // ── Step 3: Load enrollments ───────────────────────────────────────────────
  let enrollQuery = supabase.from('enrollments').select('id, enrollment_id, institution_name, user_id, created_at');
  if (userId) enrollQuery = enrollQuery.eq('user_id', userId);
  const { data: enrollments, error: enrollErr } = await enrollQuery;

  if (enrollErr) {
    report.steps.push({ step: '3_enrollments', ok: false, detail: 'FAIL: ' + enrollErr.message });
    report.summary = 'BLOCKED at step 3: could not load enrollments.';
    return { statusCode: 200, headers: CORS, body: JSON.stringify(report, null, 2) };
  }
  if (!enrollments?.length) {
    // Before giving up, check if the user has connections that point to orphaned enrollments
    // (enrollments saved without a user_id — happens when JWT is missing during enroll)
    let orphanDetail = 'No orphaned enrollments found either.';
    let orphanedEnrollmentIds = [];

    if (userId) {
      const { data: userConns } = await supabase.from('connections').select('id, data').eq('user_id', userId);
      const enrollmentIdsFromConns = (userConns || []).map(r => r.data?.enrollmentId).filter(Boolean);

      if (enrollmentIdsFromConns.length > 0) {
        const { data: orphaned } = await supabase.from('enrollments')
          .select('id, enrollment_id, institution_name, user_id, created_at')
          .in('enrollment_id', enrollmentIdsFromConns);

        const unlinked = (orphaned || []).filter(e => !e.user_id);
        orphanedEnrollmentIds = unlinked.map(e => e.enrollment_id);

        if (unlinked.length > 0) {
          orphanDetail = `FOUND ${unlinked.length} orphaned enrollment(s) linked to this user's connections but missing user_id: ` +
            unlinked.map(e => `${e.institution_name} (enrollment_id: ${e.enrollment_id})`).join(', ') +
            `. Run /.netlify/functions/teller-repair?userId=${userId} to fix.`;
        }
      } else {
        orphanDetail = 'User has no connections in the connections table either — bank was never enrolled.';
      }
    }

    report.steps.push({
      step: '3_enrollments',
      ok: false,
      orphanedEnrollmentIds,
      detail: (userId ? `No enrollments found for user_id=${userId}. ` : 'No enrollments in database at all. ') + orphanDetail,
    });
    report.summary = orphanedEnrollmentIds.length > 0
      ? `FIXABLE: enrollment exists but is missing user_id. Run teller-repair to link it.`
      : 'BLOCKED at step 3: no Teller enrollments found' + (userId ? ' for this user' : '') + '. The user needs to reconnect their bank.';
    return { statusCode: 200, headers: CORS, body: JSON.stringify(report, null, 2) };
  }
  report.steps.push({
    step: '3_enrollments',
    ok: true,
    detail: `Found ${enrollments.length} enrollment(s): ` + enrollments.map(e => `${e.institution_name || 'unknown'} (id: ${e.enrollment_id?.slice(0, 12)}…)`).join(', '),
  });

  // ── Step 4: Load access tokens ─────────────────────────────────────────────
  let tokenQuery = supabase.from('enrollments').select('enrollment_id, access_token, institution_name, user_id');
  if (userId) tokenQuery = tokenQuery.eq('user_id', userId);
  const { data: enrollmentsWithTokens } = await tokenQuery;

  const missingTokens = (enrollmentsWithTokens || []).filter(e => !e.access_token);
  report.steps.push({
    step: '4_access_tokens',
    ok: missingTokens.length === 0,
    detail: missingTokens.length === 0
      ? `All ${enrollmentsWithTokens.length} enrollment(s) have access tokens`
      : `FAIL: ${missingTokens.length} enrollment(s) missing access_token: ` + missingTokens.map(e => e.enrollment_id).join(', '),
  });
  if (missingTokens.length > 0) {
    report.summary = 'BLOCKED at step 4: enrollment exists but access_token is null — the user needs to reconnect.';
    return { statusCode: 200, headers: CORS, body: JSON.stringify(report, null, 2) };
  }

  // ── Step 5: Teller /accounts for each enrollment ───────────────────────────
  const tellerResults = [];
  for (const enrollment of (enrollmentsWithTokens || [])) {
    const accountsResult = await rawTellerRequest('/accounts', enrollment.access_token, certOpts);
    const creditAccounts = accountsResult.ok && Array.isArray(accountsResult.body)
      ? accountsResult.body.filter(a => a.type === 'credit')
      : [];

    const enrollmentReport = {
      institution: enrollment.institution_name || 'unknown',
      enrollmentId: enrollment.enrollment_id?.slice(0, 16) + '…',
      accounts: {
        ok: accountsResult.ok,
        httpStatus: accountsResult.status,
        errorCode: accountsResult.errorCode,
        errorMessage: accountsResult.errorMessage,
        creditAccountCount: creditAccounts.length,
        totalAccountCount: Array.isArray(accountsResult.body) ? accountsResult.body.length : 0,
      },
      balances: [],
    };

    // ── Step 6: /balances for each credit account ──────────────────────────
    if (accountsResult.ok && creditAccounts.length > 0) {
      for (const acc of creditAccounts) {
        const balResult = await rawTellerRequest(`/accounts/${acc.id}/balances`, enrollment.access_token, certOpts);
        enrollmentReport.balances.push({
          accountId: acc.id,
          last4: acc.last_four,
          name: acc.name,
          ok: balResult.ok,
          httpStatus: balResult.status,
          errorCode: balResult.errorCode,
          errorMessage: balResult.errorMessage,
          ledger: balResult.body?.ledger,
          available: balResult.body?.available,
        });
      }
    }

    tellerResults.push(enrollmentReport);
  }

  const allAccountsOk = tellerResults.every(r => r.accounts.ok);
  const allBalancesOk = tellerResults.every(r => r.balances.every(b => b.ok));

  report.steps.push({
    step: '5_teller_accounts',
    ok: allAccountsOk,
    detail: tellerResults.map(r =>
      `${r.institution}: ${r.accounts.ok
        ? `✓ HTTP ${r.accounts.httpStatus} — ${r.accounts.creditAccountCount} credit / ${r.accounts.totalAccountCount} total`
        : `✗ HTTP ${r.accounts.httpStatus} — ${r.accounts.errorCode || 'no code'}: ${r.accounts.errorMessage || r.accounts.rawBody || 'no message'}`}`
    ).join(' | '),
    tellerResults,
  });

  report.steps.push({
    step: '6_teller_balances',
    ok: allBalancesOk,
    detail: tellerResults.flatMap(r => r.balances).map(b =>
      `${b.name} ••${b.last4}: ${b.ok ? `✓ ledger=${b.ledger} avail=${b.available}` : `✗ HTTP ${b.httpStatus} — ${b.errorCode}: ${b.errorMessage}`}`
    ).join(' | ') || 'no credit accounts to check',
  });

  // ── Summary ────────────────────────────────────────────────────────────────
  if (!allAccountsOk) {
    const firstFail = tellerResults.find(r => !r.accounts.ok);
    const code = firstFail?.accounts.errorCode || '';
    if (code.includes('enrollment.disconnected')) {
      report.summary = `TELLER ISSUE: enrollment is disconnected (${code}). The user must click Reconnect to re-authenticate with their bank.`;
    } else if (code === 'too_many_requests') {
      report.summary = 'TELLER ISSUE: rate limited. Wait a few minutes and try again.';
    } else if (firstFail?.accounts.httpStatus === 0) {
      report.summary = 'NETLIFY/NETWORK ISSUE: could not reach api.teller.io — mTLS handshake may have failed or the Netlify function timed out.';
    } else {
      report.summary = `TELLER ISSUE: HTTP ${firstFail?.accounts.httpStatus} — ${code || firstFail?.accounts.errorMessage || 'unknown error'}. This is likely a Teller-side problem with this institution.`;
    }
  } else if (!allBalancesOk) {
    report.summary = 'Accounts OK but some balance fetches failed — partial data available.';
  } else {
    report.summary = `ALL OK — ${tellerResults.reduce((s, r) => s + r.accounts.creditAccountCount, 0)} credit accounts reachable with balances.`;
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify(report, null, 2) };
};
