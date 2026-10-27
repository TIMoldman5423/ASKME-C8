const express = require('express'); const path = require('path');
const rateLimit = require('express-rate-limit');
const { q, pool } = require('./db'); const SMS = require('./sms'); const MAIL = require('./mail'); const T = require('./tools'); const A = require('./auth'); const W = require('./lib-weekly'); const D = require('./lib-data'); const G = require('./lib-geo');

for (const k of ['DATABASE_URL', 'SESSION_SECRET']) if (!process.env[k]) { console.error('Missing env ' + k); process.exit(1); }
if (!A.smsMode() && !process.env.APP_PASSWORD) { console.error('Missing env APP_PASSWORD (or set up email sign-in, see README)'); process.exit(1); }
for (const k of []) if (!process.env[k]) { console.error('Missing env ' + k); process.exit(1); }
if (process.env.SESSION_SECRET.length < 24) { console.error('SESSION_SECRET must be at least 24 characters'); process.exit(1); }

const app = express(); app.set('trust proxy', 1);
app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' }); next(); });
const smallJson = express.json({ limit: '64kb' });
app.use((req, res, next) => req.path === '/api/admin/board/summaries' || req.path === '/api/admin/manuals' ? next() : smallJson(req, res, next));   // that one route takes a bigger file (set on the route)
const cookieOpts = () => `HttpOnly; SameSite=Strict; Path=/; Max-Age=${A.maxAgeSeconds()}` + (process.env.NODE_ENV === 'production' ? '; Secure' : '');

const lim = (max, windowMs = 15 * 60 * 1000) => rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false });
// How people are identified depends on how codes are delivered: by email address, or by mobile number.
const IDS = {
  email: { col: 'email', where: 'lower(email)', key: 'email', norm: MAIL.normaliseEmail, bad: 'Please enter a valid email address.', mask: MAIL.mask, send: (to, code, min) => MAIL.send(to, 'Your C8 Ask sign-in code', `Your C8 Ask code is ${code}\n\nIt works once, for ${min} minutes. If you did not just try to sign in, ignore this email and do not share the code.`) },
  sms: { col: 'mobile', where: 'mobile', key: 'mobile', norm: SMS.normaliseMobile, bad: 'Please enter an Australian mobile number, like 0412 345 678.', mask: SMS.mask, send: (to, code, min) => SMS.send(to, `Your C8 Ask code is ${code}. It works for ${min} minutes. Never share it.`) },
};
const ident = () => IDS[A.channel()];
// ---- sign-in record: every attempt (who it was typed as, the outcome, the address it came from) goes to the table and the deployment log ----
const clientIp = req => String(req.ip || req.socket?.remoteAddress || '').slice(0, 64);
const logSignin = (req, who, outcome) => {
  const ip = clientIp(req), ident = String(who == null ? '' : who).replace(/[\r\n]/g, ' ').slice(0, 254);
  console.log(`sign-in ${outcome}: ${ident || '(nothing)'} from ${ip}`);
  return q('INSERT INTO signin_log(channel, identifier, outcome, ip, user_agent) VALUES ($1,$2,$3,$4,$5)', [A.smsMode() ? A.channel() : 'password', ident, outcome, ip, String(req.get('user-agent') || '').slice(0, 200)]).catch(() => {});
};
q("DELETE FROM signin_log WHERE at < now() - interval '13 months'").catch(() => {});   // keep about a year
const limLogin = max => rateLimit({ windowMs: 15 * 60 * 1000, max, standardHeaders: true, legacyHeaders: false,   // too many tries from one address is recorded too
  handler: (req, res) => { logSignin(req, String(req.body?.email ?? req.body?.mobile ?? '').trim(), 'rate_limited'); res.status(429).json({ error: 'Too many tries. Wait a few minutes.' }); } });
app.post('/api/login', limLogin(10), (req, res) => {   // shared-password sign-in: only while code sign-in is switched off
  if (A.smsMode()) return res.status(403).json({ error: 'Sign in with your ' + (A.channel() === 'email' ? 'email address' : 'mobile number') + ' and the code we send you.' });
  const role = A.login(String(req.body?.password || '')); if (!role) { logSignin(req, '(shared password)', 'password_wrong'); return res.status(401).json({ error: 'Wrong password' }); }
  logSignin(req, '(shared password)', 'password_ok');
  res.set('Set-Cookie', `c8s=${A.make(role)}; ${cookieOpts()}`); res.json({ ok: true, role });
});
// Code sign-in, step 1: ask for a code. The reply is always the same, so nobody can use it to find out who is registered.
const CODE_MINUTES = 5, MAX_SENDS = 3, MAX_TRIES = 5;
app.post('/api/login/request', limLogin(10), async (req, res) => {
  if (!A.smsMode()) return res.status(404).json({ error: 'Code sign-in is not switched on' });
  const I = ident(), reply = () => res.json({ ok: true, minutes: CODE_MINUTES });
  const who = I.norm(req.body?.[I.key]); if (!who) { logSignin(req, String(req.body?.[I.key] ?? '').trim(), 'bad_format'); return res.status(400).json({ error: I.bad }); }
  try {
    const u = (await q(`SELECT id, active FROM app_users WHERE ${I.where}=$1`, [who])).rows[0]; if (!u || !u.active) { await logSignin(req, who, u ? 'switched_off_user' : 'unknown_user'); return reply(); }
    const recent = Number((await q("SELECT count(*) n FROM login_codes WHERE user_id=$1 AND created_at > now() - interval '15 minutes'", [u.id])).rows[0].n); if (recent >= MAX_SENDS) { await logSignin(req, who, 'send_limit_reached'); return reply(); }
    const code = A.newCode(); await q("UPDATE login_codes SET used=TRUE WHERE user_id=$1 AND NOT used", [u.id]);
    await q(`INSERT INTO login_codes(user_id, code_hash, expires_at) VALUES ($1,$2, now() + interval '${CODE_MINUTES} minutes')`, [u.id, A.codeHash(u.id, code)]);
    await I.send(who, code, CODE_MINUTES); await logSignin(req, who, 'code_sent');
  } catch (e) { console.error('sign-in code failed:', e.message); await logSignin(req, who, 'send_failed'); }
  reply();
});
// step 2: check the code
app.post('/api/login/verify', limLogin(20), async (req, res) => {
  if (!A.smsMode()) return res.status(404).json({ error: 'Code sign-in is not switched on' });
  const I = ident(), bad = () => res.status(401).json({ error: 'That code is not right or has run out. Ask for a new one.' });
  const who = I.norm(req.body?.[I.key]), code = String(req.body?.code || '').replace(/\s/g, ''); if (!who || !/^\d{6}$/.test(code)) { logSignin(req, who || String(req.body?.[I.key] ?? '').trim(), 'code_bad_format'); return bad(); }
  try {
    const u = (await q(`SELECT id, role, active FROM app_users WHERE ${I.where}=$1`, [who])).rows[0]; if (!u || !u.active) { await logSignin(req, who, u ? 'switched_off_user' : 'unknown_user_code'); return bad(); }
    const c = (await q('SELECT id, code_hash, attempts FROM login_codes WHERE user_id=$1 AND NOT used AND expires_at > now() ORDER BY id DESC LIMIT 1', [u.id])).rows[0]; if (!c) { await logSignin(req, who, 'no_live_code'); return bad(); }
    if (c.attempts >= MAX_TRIES) { await logSignin(req, who, 'too_many_wrong_codes'); return bad(); }
    if (!A.eq(A.codeHash(u.id, code), c.code_hash)) { await q('UPDATE login_codes SET attempts=attempts+1, used=(attempts+1 >= $2) WHERE id=$1', [c.id, MAX_TRIES]); await logSignin(req, who, 'wrong_code'); return bad(); }
    await q('UPDATE login_codes SET used=TRUE WHERE id=$1', [c.id]); await q('UPDATE app_users SET last_login=now() WHERE id=$1', [u.id]); await logSignin(req, who, 'signed_in');
    res.set('Set-Cookie', `c8s=${A.make(u.role, u.id)}; ${cookieOpts()}`); res.json({ ok: true, role: u.role });
  } catch (e) { console.error('sign-in verify failed:', e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});
app.post('/api/logout', (req, res) => { res.set('Set-Cookie', 'c8s=; Max-Age=0; Path=/'); res.json({ ok: true }); });
app.get('/api/session', async (req, res) => {
  const s = A.read(req); let role = s?.r || null, ok = !!s, areas = A.AREAS;
  if (s && A.smsMode()) { const a = await A.access(s.u, q).catch(() => null); const live = a && !A.expired(s, a); role = live ? a.role : null; ok = !!live; areas = live ? a.areas : []; }
  res.json({ loggedIn: ok, role: ok ? role : null, areas: ok ? areas : [], sms: A.smsMode(), channel: A.channel() });
});

// stores for the pull-down, grouped by brand
app.get('/api/stores', A.need('user'), A.allow('sales'), async (req, res) => {
  const r = await q(`SELECT id, name, brand FROM stores WHERE active ORDER BY brand, name`);
  const by = {}; for (const s of r.rows) (by[s.brand] ||= []).push({ id: s.id, name: s.name });
  res.json({ brands: Object.entries(by).map(([brand, stores]) => ({ brand, stores })) });
});
// directory for the Brands / Stores windows: every active store with its details and the latest two weeks' sales
app.get('/api/directory', A.need('user'), A.allow('sales'), async (req, res) => {
  const r = await q(`WITH w AS (SELECT max(week_ending) l FROM weekly_sales)
    SELECT s.id, s.name, s.brand, s.state, s.address, s.phone, s.trading_company, s.bdm, s.opening_date::text opening_date, s.opening_date_source, s.opening_date_confidence,
           cur.sales::float cur_sales, cur.orders, cur.atv::float atv, prev.sales::float prev_sales, w.l::text week
    FROM stores s CROSS JOIN w
    LEFT JOIN weekly_sales cur ON cur.store_id = s.id AND cur.week_ending = w.l
    LEFT JOIN weekly_sales prev ON prev.store_id = s.id AND prev.week_ending = w.l - 7
    WHERE s.active ORDER BY s.brand, s.name`);
  const stores = r.rows.map(({ week, ...s }) => s); const by = new Map();
  for (const s of stores) { const b = by.get(s.brand) || { brand: s.brand, store_count: 0, trading: 0, cur_total: 0, like_cur: 0, like_prev: 0 }; b.store_count++;
    if (s.cur_sales != null) { b.trading++; b.cur_total += s.cur_sales; if (s.prev_sales != null) { b.like_cur += s.cur_sales; b.like_prev += s.prev_sales; } } by.set(s.brand, b); }
  res.json({ week: r.rows[0]?.week || null, brands: [...by.values()], stores });
});
// organisation chart for the Org chart window
app.get('/api/org', A.need('user'), A.allow('org'), async (req, res) => {
  const r = await q(`SELECT id, name, position, department, team, parent_id, kind, chart_group, status_flag, region, notes, reports_to_basis AS basis FROM people ORDER BY id`);
  res.json({ people: r.rows });
});
// ---- map ----
const VERSION = '1.6'; // shown beside the title so you can see which version is live
app.get('/api/config', A.need('user'), (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ mapsKey: process.env.GOOGLE_MAPS_API_KEY || null, version: VERSION }); });
app.get('/api/map-points', A.need('user'), A.allow('sales'), async (req, res) => {
  const ids = String(req.query.ids || '').split(',').map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 300); const brand = req.query.brand ? String(req.query.brand) : null;
  if (!ids.length && !brand) return res.status(400).json({ error: 'ids or brand required' });
  const r = await q(`SELECT id,name,brand,state,address,lat,lng,geo_source FROM stores WHERE active AND ($1::int[] IS NULL OR id = ANY($1)) AND ($2::text IS NULL OR brand=$2) ORDER BY name`, [ids.length ? ids : null, brand]);
  res.json({ points: r.rows.map(s => ({ ...s, search: G.queryFor(s).q })) });
});
// look up a store's map position from text the admin can edit; nothing is saved here (the admin checks the result, then saves it through the normal store edit)
app.post('/api/admin/stores/:id/geocode', A.need('admin'), async (req, res) => {
  try {
    if (!G.KEY() && !process.env.GEOCODE_MOCK) return res.status(400).json({ error: 'No Google key is set on the server' });
    const s = (await q('SELECT id,name,brand,state,address FROM stores WHERE id=$1', [Number(req.params.id)])).rows[0]; if (!s) return res.status(404).json({ error: 'No such store' });
    const text = String((req.body || {}).query || '').trim().slice(0, 300) || G.queryFor(s).q;
    const g = await G.lookup(text); if (g.error) return res.status(400).json({ error: 'Google could not find that: ' + g.error, query: text });
    res.json({ query: text, lat: g.lat, lng: g.lng, formatted: g.formatted || null, partial: !!g.partial, maps_url: `https://www.google.com/maps?q=${g.lat},${g.lng}` });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/admin/geocode', A.need('admin'), async (req, res) => { const c = await pool.connect(); try { res.json(await G.geocodeMissing(c, 200)); } catch (e) { res.status(400).json({ error: e.message }); } finally { c.release(); } });
app.get('/api/meta', A.need('user'), async (req, res) => { res.json({ latest_week_ending: await T.latestWeek() }); });

// ---- the question endpoint: Claude + fixed query tools ----
let client;
function anthropic() {
  if (process.env.ANTHROPIC_MOCK) return require('./test/mock-anthropic');
  if (!client) { const Anthropic = require('@anthropic-ai/sdk'); client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }); }
  return client;
}
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const AREA_WORDS = { sales: 'store sales and the network pipeline', org: 'the organisation chart', finance: 'the company financial statements', finance_commentary: 'the finance team commentary', exec_pay: 'executive and director pay', budget: 'the budget and forecast', board_papers: 'the board papers', manuals: 'the operating manuals', legal: 'the signed franchise agreement and other legal documents, scan text, graphs, like-for-like, Power BI LFL' };
const limitsNote = (areas) => { const no = Object.keys(AREA_WORDS).filter(a => !areas.includes(a)); return no.length ? `\n\nThis person's access does not include: ${no.map(a => AREA_WORDS[a]).join('; ')}. You have no tools for those. If asked about any of them, say plainly that it is outside their access, and do not guess, estimate or answer from memory.` : ''; };
const SYSTEM = (latest, areas = A.AREAS) => `You answer questions from a Concept Eight (C8) director about store sales and the C8 organisation chart, using ONLY the tools provided. C8 brands: Noodle Box, Pattysmiths, Huxtaburger, Acai Bros, South Seoul, Wok In A Box (OTR).
Rules:
- Every figure you state must come from a tool result in this conversation. Never estimate, extrapolate or recall figures. If the data does not hold the answer, say so plainly and say what is held (use data_status if unsure).
- If the user names a store without store_id, call find_store first. If it returns several brands (e.g. Hawthorn Noodle Box vs Hawthorn Huxtaburger), ask which one, unless the brand was given.
- The latest week held ends on Sunday ${latest}. "Last week" means that week. Weeks end on Sunday. Sales are in Australian dollars, ex-nothing stated, as reported in the Power BI Sales Report.
- Answers will be read aloud, so keep them SHORT. Default to one or two plain spoken sentences: the key number or fact first, then at most one line of context. Only go longer (up to about six sentences) when the question clearly needs it, for example comparing several stores or brands, asking why something moved, or asking for a list or a summary. Never pad, never repeat the question back, never add offers or follow-up suggestions. Plain English, round dollars (like "$23,900"), no markdown, no bullet lists, no tables.
- Opening dates: say how reliable they are when the tool marks them low (franchise agreement start, not the store opening).
- Be candid about limits: orders/ATV are for the latest week only; the weekly history depth varies, so check the data summary for the first and last week held; the 13-week average is only one of the measures.
- Questions about menu items (best sellers, how much of an item a store or the brand sold, item rankings) use item_sales. It is a multi-week block of dollar sales from the Item Sales report, held for the brands that data_status lists. It is NOT on the same basis as the weekly sales figures, so never add them or compare them; always say which period the item figures cover.
- Questions about people (who someone is, what they do, who reports to whom, who is in a team, which roles are vacant) use org_lookup. The chart shows names, positions and reporting lines only; it holds no addresses, emails, phone numbers or salaries. Where a result says a reporting line is inferred or not shown, say so. A vacant role has no name: say "the vacant ... role".
- Graphs: when the user asks for a graph, chart or bar graph, or a trend picture would help, get the numbers from the tools and draw it (weekly_trend draws its own chart; for best or worst stores by year-on-year growth use rank_stores_growth; otherwise call show_chart). Like-for-like (LFL) means the same stores compared with the same week a year earlier; use weekly_trend for it, and say plainly if less than a year of history is held.\n- When the user asks where a store is, or asks to see or locate stores on a map, call find_store if you need the id, then store_summary for its address, then show_on_map with the store ids. Reply in one or two sentences with where it is (address and state). Never invent a location.
- Questions about new stores being built or planned, how far along a site is (lease signed, design, fitout, training, opening), which openings are late and why, transfers, closures, and franchise-agreement or lease expiries and renewals use the pipeline tool (the Network Tracker). Say the tracker is refreshed about every two weeks and give its latest-entry date; entries after that date are plans, not facts, and a date that has passed may just not have been updated. Do not call a site's status live. Opening dates for trading stores still come from the store profile.
- Questions about the budget, plan, targets or forecast for FY27 (sales budget, royalties, costs, profit, cash flow, headcount, openings, Marketing Concepts, assumptions) use the budget tool. Call it "the FY27 budget". Budget network sales are not the same basis as weekly sales, so any budget versus actual comparison is approximate and must say so.
- Questions about C8's own finances (profit, revenue, expenses, balance sheet, bank debt, the CBA loan, cash, shareholder loans, dividends, free cash flow, cash flow) use the finance tool: the monthly Finance Board Report. Always say which month the figure is for and that it is from the finance report. Several months are held, not every month (the tool lists them); never fill a gap. The reports have NO cash flow statement, so any cash flow or free cash flow figure comes from action cash_flow, which is derived from the balance sheets, so call it an estimate. Free cash flow means operating cash flow less capital spending, before growth investment, loan repayments and the dividend. Net bank debt is the CBA loan less cash. If the tool shows the report's balance sheet does not balance, say so in one short line. Everyday words: income, turnover or revenue = Total Revenue; profit = give both operating profit and net income and say which is which (use EBITDA only if asked); costs = Total Expenses; "against budget" = the budget columns; "this year" or "year to date" = the YTD lines (the financial year runs July to June); "last month" or "the latest month" = the latest month the tool holds, and name it, because that may be well before today; "same month last year" = the last-year columns; cash = Total Cash & Equivalents; debt = the CBA loan facility (shareholder loans only if asked). Start with action month for a headline question, lines for a specific cost or income line. Finance figures are in Australian dollars and are not the same basis as store sales or the FY27 budget.
- Questions about how things are done in a restaurant (procedures, food safety, cleaning, equipment, HR policy, rostering) use the manuals tool (Operations, Food Safety, HR and Equipment manuals). Say which manual and page you are drawing on.
- Questions about franchise agreements, leases, royalty rates, landlords, rent or ABNs, and which agreements or leases are ending soon, use the store_agreements tool (only stores in the SharePoint Franchise Master have these). Quote the end date, and say plainly when it is already in the past.
- Questions about what a signed franchise agreement or other legal document says (clauses on termination, renewal, fees, transfer, restraint, insurance) use the legal_documents tool. Quote the wording, name the document and page, and say it is what the document says, not legal advice.
- Questions about what the board was told, discussed or decided, plans, risks, projects or the reasons behind a result use the board_papers tool (board packs, Finance Board Reports, minutes, agendas). Say which paper (title or month) and page you are drawing on, and that the summaries are machine-written so the original paper is the reference; if the tool gives a link or says where the file is kept, mention the file name. Only the months the tool lists are held; never fill a gap. Figures still come from the finance tool where it holds that month; if you quote a figure from a paper, say it is as printed in that paper.` + limitsNote(areas);

// which stores did the lookups touch, and which of them does the answer actually name (for the "show on map" button)
function collectIds(tool, out, set) {
  const walk = (o, depth) => { if (!o || typeof o !== 'object' || depth > 6) return; if (Array.isArray(o)) { o.forEach(x => walk(x, depth + 1)); return; }
    if (Number.isInteger(o.store_id)) set.add(o.store_id); if (tool === 'find_store' && Array.isArray(o.matches)) o.matches.forEach(m => Number.isInteger(m.id) && set.add(m.id));
    for (const k of Object.keys(o)) if (o[k] && typeof o[k] === 'object') walk(o[k], depth + 1); };
  walk(out, 0);
}
const bareName = n => String(n || '').replace(/\(.*?\)/g, '').replace(/^OTR[_ ]/i, '').replace(/\b(NBX|AB|PS|HUX|SS)\b/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
async function storesNamedIn(answer, seen) {
  const text = ' ' + answer.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ') + ' ';
  const rows = (await q('SELECT id,name FROM stores WHERE active')).rows;
  const named = rows.filter(r => { const b = bareName(r.name).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); return b.length >= 4 && text.includes(' ' + b + ' '); }).map(r => r.id);
  const both = named.filter(id => seen.has(id));
  return (both.length ? both : seen.size ? [] : named).slice(0, 60);
}
// US dollars per million tokens (Claude Sonnet 5.5, Anthropic pricing page, Oct 2026); override with PRICE_IN / PRICE_OUT / PRICE_CACHE_WRITE / PRICE_CACHE_READ if the model or prices change
const PRICE = { in: Number(process.env.PRICE_IN) || 2, out: Number(process.env.PRICE_OUT) || 10, cw: Number(process.env.PRICE_CACHE_WRITE) || 2.5, cr: Number(process.env.PRICE_CACHE_READ) || 0.1 };
const logAsk = (req, question, used, t0, outcome, answer, note, tok = {}) => q('INSERT INTO ask_log(question,tools,ms,outcome,answer,note,input_tokens,output_tokens,cost_usd) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [question, used.join(','), Date.now() - t0, outcome, String(answer || '').slice(0, 600), note || null, tok.i || null, tok.o || null, tok.i || tok.o ? ((tok.plain || 0) * PRICE.in + (tok.cw || 0) * PRICE.cw + (tok.cr || 0) * PRICE.cr + (tok.o || 0) * PRICE.out) / 1e6 : null]).catch(() => {});
const askLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
app.post('/api/ask', A.need('user'), askLimiter, async (req, res) => {
  const t0 = Date.now(); const used = []; const tok = { i: 0, o: 0, plain: 0, cw: 0, cr: 0 }; const seenIds = new Set(), mapIds = new Set(), charts = [];
  try {
    const question = String(req.body?.question || '').slice(0, 600).trim(); if (!question) return res.status(400).json({ error: 'No question' });
    const hint = req.body?.store && Number.isInteger(req.body.store.id) ? req.body.store : null;
    const hist = (Array.isArray(req.body?.history) ? req.body.history : []).slice(-6).filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').map(m => ({ role: m.role, content: m.content.slice(0, 1500) }));
    const latest = await T.latestWeek();
    const brandHint = !hint && typeof req.body?.brand === 'string' ? req.body.brand.slice(0, 60) : null;
    const userText = hint ? `[The user selected the store "${hint.name}" (store_id ${hint.id}, ${hint.brand}) from the Stores window.] ${question}` : brandHint ? `[The user selected the brand "${brandHint}" in the Brands window; questions without another brand named are about this brand.] ${question}` : question;
    const messages = [...hist, { role: 'user', content: userText }];
    for (let i = 0; i < 6; i++) {
      const resp = await anthropic().messages.create({ model: MODEL, max_tokens: 4000, system: SYSTEM(latest, req.areas), tools: T.defsFor(req.areas), messages });
      const us = resp.usage || {}; tok.plain += us.input_tokens || 0; tok.cw += us.cache_creation_input_tokens || 0; tok.cr += us.cache_read_input_tokens || 0; tok.i += (us.input_tokens || 0) + (us.cache_creation_input_tokens || 0) + (us.cache_read_input_tokens || 0); tok.o += us.output_tokens || 0;
      const toolUses = resp.content.filter(b => b.type === 'tool_use');
      if (resp.stop_reason !== 'tool_use' || !toolUses.length) {
        const answer = resp.content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
        logAsk(req, question, used, t0, answer ? 'answered' : 'no_answer', answer, 'stop_reason=' + resp.stop_reason, tok);
        const stores = answer ? await storesNamedIn(answer, seenIds) : [];
        return res.json({ answer: answer || 'Sorry, I could not work that out.', tools: used, stores, map_ids: [...mapIds], charts, ms: Date.now() - t0 });
      }
      messages.push({ role: 'assistant', content: resp.content });
      const results = [];
      for (const tu of toolUses) { used.push(tu.name); const out = await T.run(tu.name, tu.input, { areas: req.areas }); collectIds(tu.name, out, seenIds); if (out && out._chart) { if (charts.length < 4) charts.push(out._chart); delete out._chart; if (tu.name === 'weekly_trend') out.chart_shown = 'A bar chart of this is displayed to the user.'; } if (tu.name === 'show_on_map') for (const id of (tu.input?.store_ids || [])) if (Number.isInteger(id) && id > 0 && mapIds.size < 60) mapIds.add(id); results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out) }); }
      messages.push({ role: 'user', content: results });
    }
    logAsk(req, question, used, t0, 'too_many_steps', '', 'more than 6 rounds of lookups', tok);
    res.json({ answer: 'That question needed too many steps. Could you ask it more simply?', tools: used });
  } catch (e) { console.error('ask failed:', e.message); logAsk(req, String(req.body?.question || '').slice(0, 600), used, t0, 'error', '', e.message.slice(0, 300), tok); res.status(500).json({ error: 'Something went wrong answering that.' }); }
});

// ---- review of questions asked (admin) ----
app.get('/api/admin/questions', A.need('admin'), async (req, res) => {
  const problems = req.query.problems === '1'; const n = Math.max(1, Math.min(200, Number(req.query.limit) || 60));
  const r = await q(`SELECT l.id, l.asked_at, l.question, l.tools, l.ms, l.outcome, l.answer, l.note, l.input_tokens, l.output_tokens, l.cost_usd FROM ask_log l
    WHERE ($1::boolean IS NOT TRUE OR l.outcome IN ('no_answer','too_many_steps','error')) ORDER BY l.id DESC LIMIT $2`, [problems, n]);
  const c = (await q(`SELECT count(*) total, count(*) FILTER (WHERE outcome='answered') ok, count(*) FILTER (WHERE outcome IN ('no_answer','too_many_steps','error')) bad, coalesce(sum(cost_usd),0) cost, coalesce(sum(cost_usd) FILTER (WHERE asked_at > now() - interval '30 days'),0) cost30 FROM ask_log`)).rows[0];
  res.json({ counts: { total: Number(c.total), answered: Number(c.ok), problems: Number(c.bad), cost_usd: Number(c.cost), cost_usd_30d: Number(c.cost30) }, rows: r.rows });
});
// ---- sign-in record (admin): who tried to get in, and from where ----
const SIGNIN_STRANGER = ['unknown_user', 'unknown_user_code', 'bad_format', 'code_bad_format'];
app.get('/api/admin/signins', A.need('admin'), async (req, res) => {
  const only = req.query.strangers === '1'; const n = Math.max(1, Math.min(500, Number(req.query.limit) || 200));
  const r = await q(`SELECT id, at, channel, identifier, outcome, ip FROM signin_log WHERE ($1::boolean IS NOT TRUE OR outcome = ANY($2)) ORDER BY id DESC LIMIT $3`, [only, SIGNIN_STRANGER, n]);
  const c = (await q(`SELECT count(*) total, count(*) FILTER (WHERE outcome = ANY($1)) strangers, count(*) FILTER (WHERE outcome='signed_in') ok, count(*) FILTER (WHERE outcome = ANY($1) AND at > now() - interval '7 days') strangers_7d, count(DISTINCT ip) FILTER (WHERE outcome = ANY($1)) stranger_ips FROM signin_log`, [SIGNIN_STRANGER])).rows[0];
  res.json({ counts: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Number(v)])), rows: r.rows });
});
app.get('/api/admin/signins.csv', A.need('admin'), async (req, res) => {
  const r = await q('SELECT id, at, channel, identifier, outcome, ip, user_agent FROM signin_log ORDER BY id');
  sendCsv(res, `c8-ask-signins-${stamp()}.csv`, ['id', 'at', 'channel', 'identifier', 'outcome', 'ip', 'user_agent'], r.rows);
});
// ---- download everything as CSV (admin) ----
const csvCell = v => { const t = v == null ? '' : (v instanceof Date ? v.toISOString() : String(v)); return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
const sendCsv = (res, name, cols, rows) => { res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` }); res.send('\uFEFF' + cols.join(',') + '\r\n' + rows.map(r => cols.map(c => csvCell(r[c])).join(',')).join('\r\n')); };
const stamp = () => new Date().toISOString().slice(0, 10);
app.get('/api/admin/questions.csv', A.need('admin'), async (req, res) => {
  const r = await q('SELECT id, asked_at, question, outcome, tools, ms, input_tokens, output_tokens, cost_usd, note, answer FROM ask_log ORDER BY id');
  sendCsv(res, `c8-ask-questions-${stamp()}.csv`, ['id', 'asked_at', 'question', 'outcome', 'tools', 'ms', 'input_tokens', 'output_tokens', 'cost_usd', 'note', 'answer'], r.rows);
});
app.get('/api/admin/loads.csv', A.need('admin'), async (req, res) => {
  const r = await q('SELECT id, loaded_at, kind, file_name, rows_inserted, rows_changed, note FROM load_log ORDER BY id');
  sendCsv(res, `c8-ask-load-history-${stamp()}.csv`, ['id', 'loaded_at', 'kind', 'file_name', 'rows_inserted', 'rows_changed', 'note'], r.rows);
});
// ---- weekly update (admin) ----
app.post('/api/admin/preview', A.need('admin'), express.text({ type: '*/*', limit: '2mb' }), async (req, res) => {
  const c = await pool.connect(); try { res.json(await W.analyse(c, W.parseWide(req.body))); } catch (e) { res.status(400).json({ error: e.message }); } finally { c.release(); }
});
app.post('/api/admin/commit', A.need('admin'), express.text({ type: '*/*', limit: '2mb' }), async (req, res) => {
  const c = await pool.connect(); try { await c.query('BEGIN'); const parsed = W.parseWide(req.body);
    const a = await W.analyse(c, parsed); if (a.unknown_stores.length) { await c.query('ROLLBACK'); return res.status(400).json({ error: 'Unknown stores (add them to the master first, or fix spelling): ' + a.unknown_stores.join(', ') }); }
    const out = await W.commit(c, parsed, String(req.query.name || 'upload').slice(0, 120)); await c.query('COMMIT'); res.json(out);
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); res.status(400).json({ error: e.message }); } finally { c.release(); }
});

// ---- generic data maintenance: any supported CSV, type auto-detected from its header ----
const csvBody = express.text({ type: '*/*', limit: '25mb' });
// monthly finance report PDFs: sent as raw bytes, read on the server
const FIN = require('./lib-finance'); const pdfBody = express.raw({ type: '*/*', limit: '12mb' });
app.post('/api/admin/finance/preview', A.need('admin'), pdfBody, async (req, res) => {
  const c = await pool.connect();
  try { if (!Buffer.isBuffer(req.body) || req.body.length < 100 || req.body.slice(0, 4).toString() !== '%PDF') return res.status(400).json({ error: 'That is not a PDF file.' });
    const parsed = FIN.parseReport(await FIN.extractLines(req.body)); res.json(await FIN.analyse(c, parsed, String(req.query.name || 'upload').slice(0, 120)));
  } catch (e) { res.status(400).json({ error: 'Could not read that PDF: ' + e.message }); } finally { c.release(); }
});
app.post('/api/admin/finance/commit', A.need('admin'), pdfBody, async (req, res) => {
  const c = await pool.connect();
  try { if (!Buffer.isBuffer(req.body) || req.body.slice(0, 4).toString() !== '%PDF') throw new Error('That is not a PDF file.');
    const parsed = FIN.parseReport(await FIN.extractLines(req.body)); await c.query('BEGIN'); const out = await FIN.commit(c, parsed, String(req.query.name || 'upload').slice(0, 120)); await c.query('COMMIT'); res.json({ type: 'finance', ...out });
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); res.status(400).json({ error: e.message }); } finally { c.release(); }
});

// ---- board papers (admin): PDFs read on the server; Claude writes a summary at load time ----
const BOARD = require('./lib-board'); const boardBody = express.raw({ type: '*/*', limit: '25mb' });
const isPdf = b => Buffer.isBuffer(b) && b.length > 100 && b.slice(0, 4).toString() === '%PDF';
app.post('/api/admin/board/preview', A.need('admin'), boardBody, async (req, res) => {
  const c = await pool.connect();
  try { if (!isPdf(req.body)) return res.status(400).json({ error: 'That is not a PDF file.' }); res.json(await BOARD.analyse(c, String(req.query.name || 'upload').slice(0, 160), await BOARD.extractPages(req.body))); }
  catch (e) { res.status(400).json({ error: 'Could not read that PDF: ' + e.message }); } finally { c.release(); }
});
app.post('/api/admin/board/commit', A.need('admin'), boardBody, async (req, res) => {
  const c = await pool.connect();
  try { if (!isPdf(req.body)) throw new Error('That is not a PDF file.'); const name = String(req.query.name || 'upload').slice(0, 160); const pages = await BOARD.extractPages(req.body);
    let summary = null, note = null; if (req.query.summarise !== '0') { try { summary = await BOARD.storedSummary(c, name) || await BOARD.summarise(anthropic(), name, pages); } catch (e) { note = String(e.message).slice(0, 200); } } else note = 'summary skipped';
    await c.query('BEGIN'); const out = await BOARD.commit(c, name, pages, summary, note); await c.query('COMMIT'); res.json({ type: 'board', ...out });
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); res.status(400).json({ error: e.message }); } finally { c.release(); }
});
const MANUALS = require('./lib-manuals');
app.post('/api/admin/manuals', A.need('admin'), express.json({ limit: '25mb' }), async (req, res) => {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const out = await MANUALS.loadFile(c, req.body); await c.query("INSERT INTO load_log(kind,file_name,rows_inserted) VALUES ('manuals','manuals.json',$1)", [out.pages]); await c.query('COMMIT'); res.json(out); }
  catch (e) { await c.query('ROLLBACK').catch(() => {}); res.status(400).json({ error: e.message }); } finally { c.release(); }
});
app.post('/api/admin/legal', A.need('admin'), boardBody, async (req, res) => {
  const name = String(req.query.name || 'document').replace(/\.(pdf|txt)$/i, '').slice(0, 200).trim() || 'document'; const c = await pool.connect();
  try { if (!Buffer.isBuffer(req.body) || !req.body.length) throw new Error('No file received'); const isText = /\.txt$/i.test(String(req.query.name || '')) || /^text\//.test(req.headers['content-type'] || '');   // a text file made from a scan: one page after another, separated by form-feed characters
    const pages = isText ? req.body.toString('utf8').split('\f') : await BOARD.extractPages(req.body);
    await c.query('BEGIN'); const out = await MANUALS.loadLegal(c, name, pages); await c.query("INSERT INTO load_log(kind,file_name,rows_inserted) VALUES ('legal',$1,$2)", [name, out.pages]); await c.query('COMMIT'); res.json(out); }
  catch (e) { await c.query('ROLLBACK').catch(() => {}); res.status(400).json({ error: e.message }); } finally { c.release(); }
});
app.get('/api/admin/legal', A.need('admin'), async (req, res) => { const c = await pool.connect(); try { res.json(await MANUALS.adminList(c, 'legal')); } finally { c.release(); } });
app.delete('/api/admin/legal/:id', A.need('admin'), async (req, res) => { const r = await q("DELETE FROM manual_docs WHERE id=$1 AND kind='legal'", [Number(req.params.id) || 0]); res.json({ ok: r.rowCount === 1 }); });
app.get('/api/admin/manuals', A.need('admin'), async (req, res) => { const c = await pool.connect(); try { res.json(await MANUALS.adminList(c)); } finally { c.release(); } });
app.post('/api/admin/board/summaries', A.need('admin'), express.json({ limit: '8mb' }), async (req, res) => {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const out = await BOARD.loadSummaries(c, req.body); await c.query('COMMIT'); res.json(out); }
  catch (e) { await c.query('ROLLBACK').catch(() => {}); res.status(400).json({ error: e.message }); } finally { c.release(); }
});
app.get('/api/admin/board', A.need('admin'), async (req, res) => { const c = await pool.connect(); try { res.json(await BOARD.adminList(c)); } finally { c.release(); } });
app.post('/api/admin/board/:id/summarise', A.need('admin'), async (req, res) => { const c = await pool.connect(); try { const id = Number(req.params.id); if (!Number.isInteger(id)) throw new Error('No such paper'); res.json(await BOARD.resummarise(c, anthropic(), id)); } catch (e) { res.status(400).json({ error: e.message }); } finally { c.release(); } });
app.patch('/api/admin/board/:id', A.need('admin'), async (req, res) => {
  const link = String(req.body?.link || '').trim().slice(0, 500); if (link && !/^https?:\/\//i.test(link)) return res.status(400).json({ error: 'A link must start with http:// or https://' });
  const id = Number(req.params.id); if (!Number.isInteger(id)) return res.status(400).json({ error: 'No such paper' });
  const r = await q('UPDATE board_docs SET link=$2 WHERE id=$1', [id, link || null]); res.json({ ok: r.rowCount === 1 });
});
app.delete('/api/admin/board/:id', A.need('admin'), async (req, res) => { const id = Number(req.params.id); if (!Number.isInteger(id)) return res.status(400).json({ error: 'No such paper' }); const r = await q('DELETE FROM board_docs WHERE id=$1', [id]); res.json({ ok: r.rowCount === 1 }); });
app.post('/api/admin/data/preview', A.need('admin'), csvBody, async (req, res) => {
  const c = await pool.connect();
  try { const type = req.query.type || D.detect(req.body); if (!type) return res.status(400).json({ error: 'Could not tell what kind of file this is from its header row. Supported: ' + Object.values(D.TYPES).map(t => t.label).join(' | ') }); res.json({ ...(await D.analyse(c, type, req.body)), label: D.TYPES[type]?.label }); }
  catch (e) { res.status(400).json({ error: e.message }); } finally { c.release(); }
});
app.post('/api/admin/data/commit', A.need('admin'), csvBody, async (req, res) => {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const type = req.query.type || D.detect(req.body); if (!type) throw new Error('Unknown file type');
    if (type === 'weekly_sales') { const a = await W.analyse(c, W.parseWide(req.body)); if (a.unknown_stores.length) throw new Error('Unknown stores (add them first via a New stores file or the Stores tab): ' + a.unknown_stores.join(', ')); }
    const out = await D.commit(c, type, req.body, String(req.query.name || 'upload').slice(0, 120)); await c.query('COMMIT'); res.json({ type, ...out });
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); res.status(400).json({ error: e.message }); } finally { c.release(); }
});

// ---- store maintenance (edit one store, add a store, manage spoken-name aliases) ----
const EDITABLE = ['name', 'brand', 'division', 'state', 'address', 'phone', 'trading_company', 'bdm', 'opening_date', 'opening_date_source', 'opening_date_confidence', 'active', 'lat', 'lng'];
const logEdit = (c, note) => c.query("INSERT INTO load_log(kind,file_name,note) VALUES ('edit','admin',$1)", [note]);
app.get('/api/admin/stores', A.need('admin'), async (req, res) => {
  const r = await q(`SELECT s.id,s.name,s.brand,s.division,s.state,s.address,s.phone,s.trading_company,s.bdm,s.opening_date::text opening_date,s.opening_date_source,s.opening_date_confidence,s.active,s.lat,s.lng,s.geo_source,
      COALESCE((SELECT json_agg(a.alias ORDER BY a.alias) FROM store_aliases a WHERE a.store_id=s.id AND a.source='manual'),'[]') aliases
    FROM stores s ORDER BY s.brand, s.name`); res.json(r.rows);
});
app.patch('/api/admin/stores/:id', A.need('admin'), async (req, res) => {
  const id = Number(req.params.id); const c = await pool.connect();
  try { await c.query('BEGIN'); const sets = [], vals = [id]; const b = req.body || {};
    for (const k of EDITABLE) if (k in b) { let v = b[k]; if (k === 'brand') v = D.BRAND_CANON(v); if (k === 'state') v = String(v || '').toUpperCase().trim(); if (k === 'opening_date' && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error('Opening date must be YYYY-MM-DD'); if (k === 'active') v = !!v; if (k === 'lat' || k === 'lng') { v = v === '' || v === null ? null : Number(v); if (v !== null && !isFinite(v)) throw new Error(k + ' must be a number'); } if (v === '') v = null; if ((k === 'name' || k === 'brand') && !v) throw new Error(k + ' cannot be empty'); vals.push(v); sets.push(`${k}=$${vals.length}`); }
    if (('lat' in b) || ('lng' in b)) sets.push(`geo_source='manual'`);
    else if ('address' in b) sets.push(`lat=CASE WHEN geo_source='manual' THEN lat ELSE NULL END`, `lng=CASE WHEN geo_source='manual' THEN lng ELSE NULL END`, `geo_source=CASE WHEN geo_source='manual' THEN geo_source ELSE NULL END`);   // a new address: find the pin again (unless the pin was placed by hand)
    if ('opening_date' in b && !('opening_date_source' in b)) { sets.push(`opening_date_source='Manual edit'`, `opening_date_confidence='high'`); }
    if (!sets.length) throw new Error('Nothing to change');
    const r = await c.query(`UPDATE stores SET ${sets.join(',')} WHERE id=$1 RETURNING name`, vals); if (!r.rowCount) throw new Error('No such store');
    if ('name' in b || 'brand' in b) await D.rebuildAliases(c, id);
    await logEdit(c, `edit store ${r.rows[0].name}: ${Object.keys(b).filter(k => EDITABLE.includes(k)).join(', ')}`); await c.query('COMMIT'); res.json({ ok: true });
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); res.status(400).json({ error: /unique/.test(e.message) ? 'A store with that name already exists' : e.message }); } finally { c.release(); }
});
app.post('/api/admin/stores', A.need('admin'), async (req, res) => {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const b = req.body || {}; if (!b.name || !b.brand) throw new Error('Name and brand are required');
    const r = await c.query(`INSERT INTO stores(name,brand,division,state,address,phone,trading_company,bdm) VALUES ($1,$2,NULLIF($3,''),NULLIF($4,''),NULLIF($5,''),NULLIF($6,''),NULLIF($7,''),NULLIF($8,'')) RETURNING id`,
      [String(b.name).trim(), D.BRAND_CANON(b.brand), b.division || '', String(b.state || '').toUpperCase(), b.address || '', b.phone || '', b.trading_company || '', b.bdm || '']);
    await D.rebuildAliases(c, r.rows[0].id); await logEdit(c, 'add store ' + b.name); await c.query('COMMIT'); res.json({ id: r.rows[0].id });
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); res.status(400).json({ error: /unique/.test(e.message) ? 'A store with that name already exists' : e.message }); } finally { c.release(); }
});
app.post('/api/admin/stores/:id/aliases', A.need('admin'), async (req, res) => {
  const a = D.norm(req.body?.alias); if (!a) return res.status(400).json({ error: 'Empty alias' });
  await q("INSERT INTO store_aliases(alias,store_id,source) VALUES ($1,$2,'manual') ON CONFLICT (alias,store_id) DO UPDATE SET source='manual'", [a, Number(req.params.id)]); res.json({ ok: true, alias: a });
});
app.delete('/api/admin/stores/:id/aliases/:alias', A.need('admin'), async (req, res) => { await q("DELETE FROM store_aliases WHERE store_id=$1 AND alias=$2 AND source='manual'", [Number(req.params.id), req.params.alias]); res.json({ ok: true }); });

// people who may sign in (code sign-in)
const classOk = async c => (await q('SELECT code FROM access_classes WHERE code=$1', [String(c || '')])).rows[0]?.code || null;
const cleanUser = b => { const o = {}; if ('name' in b) o.name = String(b.name || '').trim(); if ('email' in b) o.email = String(b.email || '').trim() ? MAIL.normaliseEmail(b.email) : null; if ('mobile' in b) o.mobile = String(b.mobile || '').trim() ? SMS.normaliseMobile(b.mobile) : null; return o; };
const userErr = (e, c) => (/unique/.test(e.message) ? (/email/.test(e.message) ? 'That email address is already registered' : 'That mobile number is already registered') : e.message);
app.get('/api/admin/users', A.need('admin'), async (req, res) => res.json({ sms: A.smsMode(), channel: A.channel(), users: (await q('SELECT id, name, email, mobile, role, access_class, session_hours, active, last_login FROM app_users ORDER BY active DESC, lower(name)')).rows, default_hours: A.sessionHours(), max_hours: A.MAX_HOURS, classes: (await q('SELECT code, label, areas FROM access_classes ORDER BY sort')).rows, me: req.uid }));
app.post('/api/admin/users', A.need('admin'), async (req, res) => {
  const b = req.body || {}, u = cleanUser({ name: b.name, email: b.email, mobile: b.mobile }), role = b.role === 'admin' ? 'admin' : 'user';
  if (!u.name) return res.status(400).json({ error: 'Name is required' });
  if (String(b.email || '').trim() && !u.email) return res.status(400).json({ error: IDS.email.bad }); if (String(b.mobile || '').trim() && !u.mobile) return res.status(400).json({ error: IDS.sms.bad });
  const ch = A.channel(); if (ch === 'sms' ? !u.mobile : ch === 'email' ? !u.email : !(u.email || u.mobile)) return res.status(400).json({ error: ch === 'sms' ? 'A mobile number is required' : 'An email address is required' });
  const cls = await classOk(b.access_class || 'operations'); if (!cls) return res.status(400).json({ error: 'Unknown access class' });
  try { const r = await q('INSERT INTO app_users(name, email, mobile, role, access_class) VALUES ($1,$2,$3,$4,$5) RETURNING id', [u.name, u.email, u.mobile, role, cls]); await q("INSERT INTO load_log(kind,file_name,note) VALUES ('edit','admin',$1)", [`add user ${u.name} (${role}, ${cls})`]); res.json({ id: r.rows[0].id }); }
  catch (e) { res.status(400).json({ error: userErr(e) }); }
});
app.patch('/api/admin/users/:id', A.need('admin'), async (req, res) => {
  const id = Number(req.params.id), b = req.body || {}, sets = [], vals = [id], u = cleanUser(b);
  if ('name' in b) { if (!u.name) return res.status(400).json({ error: 'Name is required' }); vals.push(u.name); sets.push(`name=$${vals.length}`); }
  if ('email' in b) { if (String(b.email || '').trim() && !u.email) return res.status(400).json({ error: IDS.email.bad }); vals.push(u.email); sets.push(`email=$${vals.length}`); }
  if ('mobile' in b) { if (String(b.mobile || '').trim() && !u.mobile) return res.status(400).json({ error: IDS.sms.bad }); vals.push(u.mobile); sets.push(`mobile=$${vals.length}`); }
  if ('role' in b) { vals.push(b.role === 'admin' ? 'admin' : 'user'); sets.push(`role=$${vals.length}`); }
  if ('access_class' in b) { const cls = await classOk(b.access_class); if (!cls) return res.status(400).json({ error: 'Unknown access class' }); vals.push(cls); sets.push(`access_class=$${vals.length}`); }
  if ('session_hours' in b) { const h = b.session_hours === null || b.session_hours === '' ? null : Number(b.session_hours); if (h !== null && !(Number.isInteger(h) && h >= 1 && h <= A.MAX_HOURS)) return res.status(400).json({ error: 'Session length must be between 1 and ' + A.MAX_HOURS + ' hours' }); vals.push(h); sets.push(`session_hours=$${vals.length}`); }
  if ('active' in b) { vals.push(!!b.active); sets.push(`active=$${vals.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to change' });
  try {
    if ((('active' in b && !b.active) || ('role' in b && b.role !== 'admin'))) {   // never lock everyone out
      if (id === req.uid) return res.status(400).json({ error: 'You cannot switch off or demote yourself' });
      const others = Number((await q("SELECT count(*) n FROM app_users WHERE role='admin' AND active AND id<>$1", [id])).rows[0].n); const target = (await q('SELECT role FROM app_users WHERE id=$1', [id])).rows[0];
      if (target?.role === 'admin' && !others) return res.status(400).json({ error: 'There must be at least one active admin' });
    }
    const r = await q(`UPDATE app_users SET ${sets.join(',')} WHERE id=$1 RETURNING name`, vals); if (!r.rowCount) return res.status(404).json({ error: 'No such user' });
    A.forget(id); await q("INSERT INTO load_log(kind,file_name,note) VALUES ('edit','admin',$1)", [`edit user ${r.rows[0].name}: ${Object.keys(b).join(', ')}`]); res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: userErr(e) }); }
});
// what each class may use (the Board class is fixed at everything so it can never be locked out)
app.get('/api/admin/access-classes', A.need('admin'), async (req, res) => res.json({ areas: A.AREAS, classes: (await q('SELECT code, label, areas FROM access_classes ORDER BY sort')).rows }));
app.put('/api/admin/access-classes/:code', A.need('admin'), async (req, res) => {
  const code = String(req.params.code); if (code === 'board') return res.status(400).json({ error: 'The Board class always has every area.' });
  const areas = (Array.isArray(req.body?.areas) ? req.body.areas : []).filter(a => A.AREAS.includes(a));
  if (areas.includes('finance_commentary') && !areas.includes('finance')) areas.push('finance');   // commentary and executive pay sit inside the finance data
  if (areas.includes('exec_pay') && !areas.includes('finance')) areas.push('finance');
  const r = await q('UPDATE access_classes SET areas=$2 WHERE code=$1 RETURNING label', [code, [...new Set(areas)]]); if (!r.rowCount) return res.status(404).json({ error: 'No such class' });
  A.forgetAll(); await q("INSERT INTO load_log(kind,file_name,note) VALUES ('edit','admin',$1)", [`access class ${code}: ${[...new Set(areas)].join(', ') || 'nothing'}`]); res.json({ ok: true, areas: [...new Set(areas)] });
});
app.delete('/api/admin/users/:id', A.need('admin'), async (req, res) => {
  const id = Number(req.params.id); if (id === req.uid) return res.status(400).json({ error: 'You cannot delete yourself' });
  const t = (await q('SELECT name, role, active FROM app_users WHERE id=$1', [id])).rows[0]; if (!t) return res.status(404).json({ error: 'No such user' });
  if (t.role === 'admin' && t.active && !Number((await q("SELECT count(*) n FROM app_users WHERE role='admin' AND active AND id<>$1", [id])).rows[0].n)) return res.status(400).json({ error: 'There must be at least one active admin' });
  await q('DELETE FROM app_users WHERE id=$1', [id]); A.forget(id); await q("INSERT INTO load_log(kind,file_name,note) VALUES ('edit','admin',$1)", [`delete user ${t.name}`]); res.json({ ok: true });
});

app.get('/api/admin/loads', A.need('admin'), async (req, res) => res.json((await q('SELECT id, loaded_at, kind, file_name, rows_inserted, rows_changed, note FROM load_log ORDER BY id DESC LIMIT 25')).rows));

app.get('/readme', (req, res, next) => A.read(req) ? next() : res.redirect('/'), A.need('user'), (req, res) => res.sendFile(path.join(__dirname, 'docs', 'readme.html')));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], etag: true, setHeaders: (res, file) => { if (/\.(html|js)$/.test(file)) res.set('Cache-Control', 'no-cache'); } }));   // Safari must re-check pages every time
const port = process.env.PORT || 3000;
async function startup() {
  try { await pool.query(require('fs').readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')); } catch (e) { console.error('schema check failed:', e.message); }   // idempotent: adds any tables or columns a newer version needs
  try {   // first start with an empty chart: load the one shipped in data/
    const f = path.join(__dirname, 'data', 'org_chart.csv');
    if (!process.env.NO_SEED && require('fs').existsSync(f) && Number((await q('SELECT count(*) n FROM people')).rows[0].n) === 0) {
      const c = await pool.connect(); try { await c.query('BEGIN'); const r = await D.commit(c, 'org_chart', require('fs').readFileSync(f, 'utf8'), 'org_chart.csv (loaded automatically on first start)'); await c.query('COMMIT'); console.log('org chart loaded:', r.applied, 'boxes'); } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    }
  } catch (e) { console.error('org chart seed skipped:', e.message); }
  try {   // code sign-in: make sure there is a first admin (ADMIN_EMAIL or ADMIN_MOBILE) so you cannot lock yourself out
    const em = process.env.ADMIN_EMAIL && MAIL.normaliseEmail(process.env.ADMIN_EMAIL), mo = process.env.ADMIN_MOBILE && SMS.normaliseMobile(process.env.ADMIN_MOBILE);
    if ((process.env.ADMIN_EMAIL && !em) || (process.env.ADMIN_MOBILE && !mo)) console.error('ADMIN_EMAIL / ADMIN_MOBILE is not valid');
    if (em || mo) {   // the address in ADMIN_EMAIL / ADMIN_MOBILE is always an active admin: the owner's way back in
      const ex = (await q('SELECT id, role, active FROM app_users WHERE (email IS NOT NULL AND lower(email)=$1) OR mobile=$2 LIMIT 1', [em, mo])).rows[0];
      if (ex && ex.role === 'admin' && ex.active) console.log('admin from ADMIN_EMAIL/ADMIN_MOBILE already present');
      else if (ex) { await q("UPDATE app_users SET role='admin', active=TRUE, email=COALESCE($2,email), mobile=COALESCE($3,mobile) WHERE id=$1", [ex.id, em, mo]); console.log('admin from ADMIN_EMAIL/ADMIN_MOBILE re-enabled'); }
      else { await q("INSERT INTO app_users(name, email, mobile, role) VALUES ($1,$2,$3,'admin')", [process.env.ADMIN_NAME || 'Admin', em, mo]); console.log('admin from ADMIN_EMAIL/ADMIN_MOBILE created'); }
    }
  } catch (e) { console.error('admin seed skipped:', e.message); }
  try { const n = (await q("SELECT count(*) FILTER (WHERE active) a, count(*) FILTER (WHERE active AND role='admin') ad FROM app_users")).rows[0];
    console.log('sign-in mode: ' + (A.smsMode() ? 'code by ' + A.channel() : 'password only') + '; active users ' + n.a + ', admins ' + n.ad + '; ADMIN_EMAIL ' + (process.env.ADMIN_EMAIL ? 'set' : 'NOT set') + '; SMTP_USER ' + (process.env.SMTP_USER ? 'set' : 'NOT set') + '; SMTP_PASS ' + (process.env.SMTP_PASS ? 'set' : 'NOT set')); } catch (e) { console.error('status line failed:', e.message); }
  app.listen(port, () => console.log('C8 Ask on :' + port));
}
if (require.main === module) startup();
module.exports = app;
