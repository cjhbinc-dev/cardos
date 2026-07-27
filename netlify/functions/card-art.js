// Crowd-sourced card-art library — MODERATED.
// - Any signed-in user: GET approved art for a set of product keys; POST a
//   submission (filed as `pending`, never shown to others until approved).
// - Admin only (email === ADMIN_EMAIL): list pending, approve/reject.
// Images are resized client-side (~680x429 JPEG) and stored as a data URL on
// the row. Nothing a user submits is served to anyone else until an admin
// approves it — this is the privacy gate (a submission may contain a real card
// number; review before it goes public).
const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};
const STATUSES = ['pending', 'approved', 'rejected'];
const MAX_IMG = 600000; // ~600KB data URL cap

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Not configured' }) };
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // ── Auth: any valid session ─────────────────────────────────────────────
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Authorization required' }) };
  const { data: { user }, error: authErr } = await supabase.auth.getUser(jwt);
  if (authErr || !user) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid session' }) };
  const isAdmin = !!(process.env.ADMIN_EMAIL && user.email && user.email.toLowerCase() === process.env.ADMIN_EMAIL.toLowerCase());

  const missingTable = (e) => e && e.code === '42P01';

  // ── GET ─────────────────────────────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    // Admin: review queue
    if (q.pending === '1') {
      if (!isAdmin) return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Admin only' }) };
      const { data, error } = await supabase.from('card_art')
        .select('id, product_key, product_name, issuer, image, contributor_user_id, status, created_at')
        .eq('status', 'pending').order('created_at', { ascending: true }).limit(200);
      if (error) return missingTable(error)
        ? { statusCode: 200, headers: CORS, body: JSON.stringify({ pending: [], missing_table: true }) }
        : { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ pending: data || [] }) };
    }
    // Any user: approved art for the given product keys
    const keys = (q.keys || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 60);
    if (!keys.length) return { statusCode: 200, headers: CORS, body: JSON.stringify({ art: {} }) };
    const { data, error } = await supabase.from('card_art')
      .select('product_key, image, created_at')
      .eq('status', 'approved').in('product_key', keys).order('created_at', { ascending: false });
    if (error) return missingTable(error)
      ? { statusCode: 200, headers: CORS, body: JSON.stringify({ art: {}, missing_table: true }) }
      : { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    const art = {};
    for (const row of (data || [])) { if (!art[row.product_key]) art[row.product_key] = row.image; } // newest wins
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ art }) };
  }

  // ── POST ────────────────────────────────────────────────────────────────
  if (event.httpMethod === 'POST') {
    let body; try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

    // Admin moderation
    if (body.action === 'set_status') {
      if (!isAdmin) return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Admin only' }) };
      if (!body.id || !STATUSES.includes(body.status)) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'id + valid status required' }) };
      const patch = { status: body.status, reviewed_by: user.email, updated_at: new Date().toISOString() };
      if (typeof body.admin_note === 'string') patch.admin_note = body.admin_note.slice(0, 2000);
      const { data, error } = await supabase.from('card_art').update(patch).eq('id', body.id).select('id');
      if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
      if (!data || !data.length) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'not found' }) };
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    // User submission → pending
    const productKey = (body.productKey || '').toString().trim().slice(0, 120);
    const image = (body.image || '').toString();
    if (!productKey) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'productKey required' }) };
    if (!/^data:image\/(png|jpe?g|webp);base64,/.test(image)) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'image must be a base64 data URL' }) };
    if (image.length > MAX_IMG) return { statusCode: 413, headers: CORS, body: JSON.stringify({ error: 'image too large' }) };
    if (body.confirmed !== true) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'confirmation required' }) };

    const row = {
      product_key: productKey,
      issuer: (body.issuer || '').toString().slice(0, 40) || null,
      product_name: (body.productName || '').toString().slice(0, 160) || null,
      image,
      contributor_user_id: user.id,
      status: 'pending',
    };
    const { data, error } = await supabase.from('card_art').insert(row).select('id').single();
    if (error) {
      if (missingTable(error)) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, missing_table: true }) };
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not submit. Please try again.' }) };
    }
    // Best-effort admin notify
    if (process.env.SENDGRID_API_KEY && process.env.NOTIFICATION_EMAIL) {
      try {
        const sg = require('@sendgrid/mail'); sg.setApiKey(process.env.SENDGRID_API_KEY);
        await sg.send({ to: process.env.NOTIFICATION_EMAIL, from: process.env.NOTIFICATION_EMAIL,
          subject: 'CardOS: card-art submission to review',
          text: `From ${user.email}\nProduct: ${row.product_name || productKey}\nReview in Admin → Card Art.` });
      } catch (e) { /* non-fatal */ }
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, id: data.id }) };
  }

  return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
};
