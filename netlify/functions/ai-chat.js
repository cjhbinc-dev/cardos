// CardOS AI assistant — open-ended credit-card Q&A backed by the Claude API.
// Auth: verify the caller's Supabase JWT (same pattern as the Plaid/feedback
// functions) so only signed-in users can spend tokens. The client sends the
// message, a short history, and a SANITIZED card summary (no full card numbers).
// If ANTHROPIC_API_KEY is unset the function returns not_configured and the
// client silently falls back to its built-in local engine.
//
// Uses a direct HTTPS call to the Messages API (global fetch on Netlify's Node
// 18+ runtime) to keep this function dependency-free — no SDK to bundle.
const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

const MODEL = process.env.AI_MODEL || 'claude-opus-4-8';

function money(n) {
  const v = Math.round(Number(n) || 0);
  return '$' + v.toLocaleString('en-US');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  // No key → tell the client to use its local engine (not an error).
  if (!process.env.ANTHROPIC_API_KEY) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ not_configured: true }) };
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Not configured' }) };
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Authorization required' }) };
  const { data: { user }, error: authErr } = await supabase.auth.getUser(jwt);
  if (authErr || !user) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid session' }) };

  // ── Input ───────────────────────────────────────────────────────────────────
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }
  const message = (body.message || '').toString().trim().slice(0, 2000);
  if (!message) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'A message is required' }) };

  // Sanitize the card context — only non-sensitive fields.
  const cards = Array.isArray(body.cards) ? body.cards.slice(0, 30) : [];
  let totBal = 0, totLim = 0;
  const cardLines = cards.map((c) => {
    const bal = Number(c.balance) || 0, lim = Number(c.limit) || 0;
    totBal += bal; totLim += lim;
    const util = lim ? (bal / lim * 100).toFixed(1) + '%' : 'n/a';
    const fee = Number(c.annualFee) > 0 ? (', annual fee ' + money(c.annualFee)) : ', no annual fee';
    const st = c.status && c.status !== 'active' ? (', ' + c.status) : '';
    const nm = (c.name || 'Card').toString().slice(0, 80);
    const l4 = (c.last4 || '').toString().slice(0, 4);
    return `- ${nm}${l4 ? ' ••' + l4 : ''}: balance ${money(bal)} of ${money(lim)} limit (${util} utilization)${fee}${st}`;
  }).join('\n');
  const overallUtil = totLim ? (totBal / totLim * 100).toFixed(1) + '%' : 'n/a';

  const cardCtx = cards.length
    ? `The user has ${cards.length} card(s). Totals: ${money(totBal)} owed of ${money(totLim)} limit (${overallUtil} overall utilization).\n${cardLines}`
    : `The user has no cards connected yet.`;

  const system =
`You are the CardOS Assistant, a sharp, friendly expert on consumer credit cards embedded in a personal credit-card manager app. Help the user understand and optimize their cards.

You can and should:
- Answer any credit-card question: APR/interest, how statements and grace periods work, credit utilization and credit score, sign-up bonuses, balance transfers, annual-fee math, rewards (cash back vs points vs miles), foreign transaction fees, cash advances, product comparisons, and general strategy.
- Do the math precisely when asked (interest accrual, payoff timelines, balance-transfer break-even, annual-fee break-even). Show the key numbers.
- Use the user's live card data below to personalize answers.

Guardrails:
- Be concise and practical. Use short paragraphs or bullet points. You may use **bold** for key numbers.
- Sign-up bonus and specific card offer amounts change constantly — describe typical ranges and tell the user to confirm on the issuer's page rather than stating a current exact offer as fact.
- You are not a licensed financial or investment advisor. For personalized investment advice, say so briefly and stick to factual credit-card education.
- Never ask for or repeat full card numbers, CVV, SSN, or passwords.

The user's current cards (live data):
${cardCtx}`;

  // Build the message list from prior turns + this message.
  const hist = Array.isArray(body.history) ? body.history.slice(-10) : [];
  const messages = [];
  for (const m of hist) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const content = (m.content || '').toString().slice(0, 2000);
    if (content) messages.push({ role: m.role, content });
  }
  if (!messages.length || messages[messages.length - 1].content !== message) {
    messages.push({ role: 'user', content: message });
  }
  if (messages[0].role !== 'user') messages.unshift({ role: 'user', content: message });

  // ── Call the Messages API ─────────────────────────────────────────────────
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 1024, system, messages }),
    });
    if (!r.ok) {
      const errText = await r.text();
      console.error('[ai-chat] Anthropic error', r.status, errText.slice(0, 300));
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'AI unavailable' }) };
    }
    const data = await r.json();
    if (data.stop_reason === 'refusal') {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ reply: "I can't help with that one — but ask me anything about your cards, interest, payoff math, or credit strategy." }) };
    }
    const reply = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()
      || "Hmm — I didn't catch that. Try rephrasing?";
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ reply }) };
  } catch (e) {
    console.error('[ai-chat] fetch failed', e.message);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'AI request failed' }) };
  }
};
