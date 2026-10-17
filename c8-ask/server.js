const express = require('express'); const path = require('path');
const rateLimit = require('express-rate-limit');
const { q, pool } = require('./db'); const T = require('./tools'); const A = require('./auth'); const W = require('./lib-weekly'); const D = require('./lib-data'); const G = require('./lib-geo');

for (const k of ['DATABASE_URL', 'SESSION_SECRET', 'APP_PASSWORD']) if (!process.env[k]) { console.error('Missing env ' + k); process.exit(1); }
if (process.env.SESSION_SECRET.length < 24) { console.error('SESSION_SECRET must be at least 24 characters'); process.exit(1); }

const app = express(); app.set('trust proxy', 1);
app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' }); next(); });
app.use(express.json({ limit: '64kb' }));
const cookieOpts = () => `HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 86400}` + (process.env.NODE_ENV === 'production' ? '; Secure' : '');

app.post('/api/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false }), (req, res) => {
  const role = A.login(String(req.body?.password || '')); if (!role) return res.status(401).json({ error: 'Wrong password' });
  res.set('Set-Cookie', `c8s=${A.make(role)}; ${cookieOpts()}`); res.json({ ok: true, role });
});
app.post('/api/logout', (req, res) => { res.set('Set-Cookie', 'c8s=; Max-Age=0; Path=/'); res.json({ ok: true }); });
app.get('/api/session', (req, res) => { const s = A.read(req); res.json({ loggedIn: !!s, role: s?.r || null }); });

// stores for the pull-down, grouped by brand
app.get('/api/stores', A.need('user'), async (req, res) => {
  const r = await q(`SELECT id, name, brand FROM stores WHERE active ORDER BY brand, name`);
  const by = {}; for (const s of r.rows) (by[s.brand] ||= []).push({ id: s.id, name: s.name });
  res.json({ brands: Object.entries(by).map(([brand, stores]) => ({ brand, stores })) });
});
// directory for the Brands / Stores windows: every active store with its details and the latest two weeks' sales
app.get('/api/directory', A.need('user'), async (req, res) => {
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
app.get('/api/org', A.need('user'), async (req, res) => {
  const r = await q(`SELECT id, name, position, department, team, parent_id, kind, chart_group, status_flag, region, notes, reports_to_basis AS basis FROM people ORDER BY id`);
  res.json({ people: r.rows });
});
// ---- map ----
app.get('/api/config', A.need('user'), (req, res) => res.json({ mapsKey: process.env.GOOGLE_MAPS_API_KEY || null }));
app.get('/api/map-points', A.need('user'), async (req, res) => {
  const ids = String(req.query.ids || '').split(',').map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 300); const brand = req.query.brand ? String(req.query.brand) : null;
  if (!ids.length && !brand) return res.status(400).json({ error: 'ids or brand required' });
  const r = await q(`SELECT id,name,brand,state,address,lat,lng,geo_source FROM stores WHERE active AND ($1::int[] IS NULL OR id = ANY($1)) AND ($2::text IS NULL OR brand=$2) ORDER BY name`, [ids.length ? ids : null, brand]);
  res.json({ points: r.rows.map(s => ({ ...s, search: G.queryFor(s).q })) });
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
const SYSTEM = (latest) => `You answer questions from a Concept Eight (C8) director about store sales and the C8 organisation chart, using ONLY the tools provided. C8 brands: Noodle Box, Pattysmiths, Huxtaburger, Acai Bros, South Seoul, Wok In A Box (OTR).
Rules:
- Every figure you state must come from a tool result in this conversation. Never estimate, extrapolate or recall figures. If the data does not hold the answer, say so plainly and say what is held (use data_status if unsure).
- If the user names a store without store_id, call find_store first. If it returns several brands (e.g. Hawthorn Noodle Box vs Hawthorn Huxtaburger), ask which one, unless the brand was given.
- The latest week held ends on Sunday ${latest}. "Last week" means that week. Weeks end on Sunday. Sales are in Australian dollars, ex-nothing stated, as reported in the Power BI Sales Report.
- Answers will be read aloud, so keep them SHORT. Default to one or two plain spoken sentences: the key number or fact first, then at most one line of context. Only go longer (up to about six sentences) when the question clearly needs it, for example comparing several stores or brands, asking why something moved, or asking for a list or a summary. Never pad, never repeat the question back, never add offers or follow-up suggestions. Plain English, round dollars (like "$23,900"), no markdown, no bullet lists, no tables.
- Opening dates: say how reliable they are when the tool marks them low (franchise agreement start, not the store opening).
- Be candid about limits: orders/ATV are for the latest week only; history is 13 weeks.
- Questions about people (who someone is, what they do, who reports to whom, who is in a team, which roles are vacant) use org_lookup. The chart shows names, positions and reporting lines only; it holds no addresses, emails, phone numbers or salaries. Where a result says a reporting line is inferred or not shown, say so. A vacant role has no name: say "the vacant ... role".`;

const askLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
app.post('/api/ask', A.need('user'), askLimiter, async (req, res) => {
  const t0 = Date.now(); const used = [];
  try {
    const question = String(req.body?.question || '').slice(0, 600).trim(); if (!question) return res.status(400).json({ error: 'No question' });
    const hint = req.body?.store && Number.isInteger(req.body.store.id) ? req.body.store : null;
    const hist = (Array.isArray(req.body?.history) ? req.body.history : []).slice(-6).filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').map(m => ({ role: m.role, content: m.content.slice(0, 1500) }));
    const latest = await T.latestWeek();
    const brandHint = !hint && typeof req.body?.brand === 'string' ? req.body.brand.slice(0, 60) : null;
    const userText = hint ? `[The user selected the store "${hint.name}" (store_id ${hint.id}, ${hint.brand}) from the Stores window.] ${question}` : brandHint ? `[The user selected the brand "${brandHint}" in the Brands window; questions without another brand named are about this brand.] ${question}` : question;
    const messages = [...hist, { role: 'user', content: userText }];
    for (let i = 0; i < 6; i++) {
      const resp = await anthropic().messages.create({ model: MODEL, max_tokens: 700, system: SYSTEM(latest), tools: T.defs, messages });
      const toolUses = resp.content.filter(b => b.type === 'tool_use');
      if (resp.stop_reason !== 'tool_use' || !toolUses.length) {
        const answer = resp.content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
        q('INSERT INTO ask_log(question,tools,ms) VALUES ($1,$2,$3)', [question, used.join(','), Date.now() - t0]).catch(() => {});
        return res.json({ answer: answer || 'Sorry, I could not work that out.', tools: used });
      }
      messages.push({ role: 'assistant', content: resp.content });
      const results = [];
      for (const tu of toolUses) { used.push(tu.name); results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(await T.run(tu.name, tu.input)) }); }
      messages.push({ role: 'user', content: results });
    }
    res.json({ answer: 'That question needed too many steps. Could you ask it more simply?', tools: used });
  } catch (e) { console.error('ask failed:', e.message); res.status(500).json({ error: 'Something went wrong answering that.' }); }
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
const csvBody = express.text({ type: '*/*', limit: '3mb' });
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

app.get('/api/admin/loads', A.need('admin'), async (req, res) => res.json((await q('SELECT id, loaded_at, kind, file_name, rows_inserted, rows_changed, note FROM load_log ORDER BY id DESC LIMIT 25')).rows));

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
const port = process.env.PORT || 3000;
async function startup() {
  try { await pool.query(require('fs').readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')); } catch (e) { console.error('schema check failed:', e.message); }   // idempotent: adds any tables or columns a newer version needs
  try {   // first start with an empty chart: load the one shipped in data/
    const f = path.join(__dirname, 'data', 'org_chart.csv');
    if (!process.env.NO_SEED && require('fs').existsSync(f) && Number((await q('SELECT count(*) n FROM people')).rows[0].n) === 0) {
      const c = await pool.connect(); try { await c.query('BEGIN'); const r = await D.commit(c, 'org_chart', require('fs').readFileSync(f, 'utf8'), 'org_chart.csv (loaded automatically on first start)'); await c.query('COMMIT'); console.log('org chart loaded:', r.applied, 'boxes'); } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    }
  } catch (e) { console.error('org chart seed skipped:', e.message); }
  app.listen(port, () => console.log('C8 Ask on :' + port));
}
if (require.main === module) startup();
module.exports = app;
