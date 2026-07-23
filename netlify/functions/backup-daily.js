// Scheduled daily export of financial tables to Supabase Storage (private bucket).
// Exists because the DB was found empty on 2026-07-23 with PITR disabled and no
// backups — this is the minimum recovery path before Plaid writes real history.
// access_token values are ALWAYS stripped: backups must never hold live credentials.
// Restore path: see PROJECT.md § "Backups and restore".
const { createClient } = require('@supabase/supabase-js');

const TABLES = ['connections', 'cards', 'transactions', 'enrollments', 'offers', 'balance_history'];
const BUCKET = 'backups';
const RETENTION_DAYS = 30;

exports.handler = async () => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('[backup] Supabase env not configured');
    return { statusCode: 500, body: 'not configured' };
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const stamp = new Date().toISOString().slice(0, 10);
  const dump = { exported_at: new Date().toISOString(), tables: {} };
  const counts = {};

  for (const table of TABLES) {
    // Page through everything — .limit default would silently truncate
    const rows = [];
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase.from(table).select('*').range(from, from + PAGE - 1);
      if (error) {
        console.error(`[backup] ${table} read failed:`, error.message);
        return { statusCode: 500, body: `read failed: ${table}` };
      }
      rows.push(...(data || []));
      if (!data || data.length < PAGE) break;
    }
    // Strip credentials wherever they might appear, present or future
    for (const row of rows) {
      if ('access_token' in row) delete row.access_token;
      if (row.data && typeof row.data === 'object' && 'access_token' in row.data) delete row.data.access_token;
    }
    dump.tables[table] = rows;
    counts[table] = rows.length;
  }

  const body = Buffer.from(JSON.stringify(dump));
  const path = `${stamp}.json`;
  const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, body, {
    contentType: 'application/json',
    upsert: true, // same-day rerun overwrites, no duplicates
  });
  if (upErr) {
    console.error('[backup] upload failed:', upErr.message);
    return { statusCode: 500, body: 'upload failed' };
  }

  // Retention: drop files older than RETENTION_DAYS
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString().slice(0, 10);
  const { data: files } = await supabase.storage.from(BUCKET).list('', { limit: 1000 });
  const stale = (files || []).map(f => f.name).filter(n => /^\d{4}-\d{2}-\d{2}\.json$/.test(n) && n.slice(0, 10) < cutoff);
  if (stale.length) {
    const { error: rmErr } = await supabase.storage.from(BUCKET).remove(stale);
    if (rmErr) console.warn('[backup] retention cleanup failed:', rmErr.message);
  }

  console.log('[backup] done:', path, JSON.stringify(counts), '| pruned:', stale.length);
  return { statusCode: 200, body: JSON.stringify({ ok: true, path, counts, pruned: stale.length }) };
};
