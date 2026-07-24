// TEMP Phase 3 test harness (removed with plaid-diag in Phase 5 cleanup).
// Sandbox-only, MIGRATION_SECRET-gated. Sandbox Items are free and create no
// billable subscription. Proves, end to end:
//   1. sandbox Item creation + exchange
//   2. update-mode /link/token/create with a stored access_token + redirect_uri
//   3. /sandbox/item/reset_login → /accounts/get returns ITEM_LOGIN_REQUIRED
//      (the exact signal plaid-sync maps to { disconnected: true })
//   4. /sandbox/item/fire_webhook → our receiver verifies the signature
//      (observable in function logs; receiver returns 401 on bad signatures)
//   5. /item/remove cleans the sandbox Item up
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');

exports.handler = async (event) => {
  const secret = event.queryStringParameters?.secret || '';
  if (!process.env.MIGRATION_SECRET || secret !== process.env.MIGRATION_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }
  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET_SANDBOX) {
    return { statusCode: 500, body: JSON.stringify({ error: 'PLAID_SECRET_SANDBOX not configured' }) };
  }

  const plaid = new PlaidApi(new Configuration({
    basePath: PlaidEnvironments.sandbox,
    baseOptions: { headers: { 'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID, 'PLAID-SECRET': process.env.PLAID_SECRET_SANDBOX } },
  }));

  const results = {};
  const fail = (step, err) => {
    const d = err?.response?.data || {};
    results[step] = { ok: false, error_code: d.error_code || err.message, request_id: d.request_id || null };
    console.error('[sandbox-test]', step, 'FAILED:', d.error_code || err.message);
  };

  let accessToken = null;
  try {
    // 1. Create + exchange a sandbox item (First Platypus Bank)
    const pub = await plaid.sandboxPublicTokenCreate({
      institution_id: 'ins_109508',
      initial_products: ['transactions'],
      options: { webhook: (process.env.URL || 'https://stirring-tapioca-25776a.netlify.app').replace(/\/$/, '') + '/.netlify/functions/plaid-webhook' },
    });
    const exch = await plaid.itemPublicTokenExchange({ public_token: pub.data.public_token });
    accessToken = exch.data.access_token;
    results.create_and_exchange = { ok: true, item_id: exch.data.item_id, request_id: exch.data.request_id };

    // 2. Update-mode link token with the stored access token + redirect_uri
    try {
      const redirectUri = (process.env.URL || 'https://cardos-manager.netlify.app').replace(/\/$/, '') + '/';
      const lt = await plaid.linkTokenCreate({
        client_name: 'CardOS',
        user: { client_user_id: 'sandbox-test' },
        language: 'en',
        country_codes: ['US'],
        access_token: accessToken,
        redirect_uri: redirectUri,
      });
      results.update_mode_link_token = { ok: true, token_prefix: lt.data.link_token.slice(0, 15) + '…', request_id: lt.data.request_id };
    } catch (err) { fail('update_mode_link_token', err); }

    // 3. Fire SYNC_UPDATES_AVAILABLE at our receiver BEFORE breaking the item
    //    (signature verification proof lands in plaid-webhook logs; unknown
    //    item → verified + ignored)
    try {
      const fw = await plaid.sandboxItemFireWebhook({ access_token: accessToken, webhook_code: 'SYNC_UPDATES_AVAILABLE' });
      results.fire_webhook = { ok: !!fw.data.webhook_fired, request_id: fw.data.request_id };
    } catch (err) { fail('fire_webhook', err); }

    // 4. Force ITEM_LOGIN_REQUIRED, confirm /accounts/get returns it
    try {
      await plaid.sandboxItemResetLogin({ access_token: accessToken });
      try {
        await plaid.accountsGet({ access_token: accessToken });
        results.reset_login_detection = { ok: false, note: '/accounts/get unexpectedly succeeded after reset_login' };
      } catch (err) {
        const code = err?.response?.data?.error_code;
        results.reset_login_detection = { ok: code === 'ITEM_LOGIN_REQUIRED', error_code: code, request_id: err?.response?.data?.request_id };
      }
    } catch (err) { fail('reset_login_detection', err); }
  } catch (err) {
    fail('create_and_exchange', err);
  } finally {
    // 5. Always remove the sandbox item
    if (accessToken) {
      try {
        const rm = await plaid.itemRemove({ access_token: accessToken });
        results.item_removed = { ok: true, request_id: rm.data.request_id };
      } catch (err) { fail('item_removed', err); }
    }
  }

  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(results, null, 2) };
};
