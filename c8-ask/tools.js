// Fixed catalogue of read-only query shapes. Claude chooses a tool and its arguments; it never writes SQL.
// Every number in an answer must come from one of these results.
const { q } = require('./db');
const r2 = v => (v === null || v === undefined ? null : Math.round(Number(v) * 100) / 100);
const r0 = v => (v === null || v === undefined ? null : Math.round(Number(v)));
const pct = (a, b) => (a != null && b ? Math.round((a / b - 1) * 1000) / 10 : null);

async function latestWeek() { return (await q(`SELECT max(week_ending)::text d FROM weekly_sales`)).rows[0].d; }
async function resolveWeek(w) {
  if (!w || w === 'latest') return latestWeek();
  if (/^-?\d+$/.test(String(w)) && Number(w) <= 0) { // 0 = latest, -1 = week before ...
    const r = await q(`SELECT DISTINCT week_ending::text d FROM weekly_sales ORDER BY d DESC OFFSET $1 LIMIT 1`, [-Number(w)]);
    return r.rows[0]?.d || null;
  }
  return String(w).slice(0, 10);
}

const defs = [
  { name: 'find_store', description: 'Find stores by a spoken or typed name (e.g. "Hawthorn", "Toowoomba noodle box"). Returns candidate stores with ids. Always call this first when the user names a store and no store_id is given. If several brands match, ask the user which one.',
    input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'store_summary', description: 'Profile of one store (brand, state, address, trading company, BDM, opening date and how reliable it is) plus latest-week sales, orders, average transaction value (ATV when available), change vs previous week, 4-week average, 13-week average, and rank within its brand for the latest week.',
    input_schema: { type: 'object', properties: { store_id: { type: 'integer' } }, required: ['store_id'] } },
  { name: 'store_sales_history', description: 'Weekly sales (and orders/ATV where held) for one store, newest first.',
    input_schema: { type: 'object', properties: { store_id: { type: 'integer' }, weeks: { type: 'integer', description: 'how many weeks, default 13, max 13' } }, required: ['store_id'] } },
  { name: 'rank_stores', description: 'Top or bottom stores by sales for a week, optionally filtered by brand or state. week = "latest" or a week-ending date (YYYY-MM-DD, a Sunday), or 0, -1, -2 for latest, the week before, etc.',
    input_schema: { type: 'object', properties: { week: { type: 'string' }, brand: { type: 'string' }, state: { type: 'string' }, order: { type: 'string', enum: ['top', 'bottom'] }, limit: { type: 'integer' } } } },
  { name: 'group_totals', description: 'Total sales for a week grouped by brand, division or state, with change vs the previous week and store counts. Also returns the network total and the report\'s own stated total.',
    input_schema: { type: 'object', properties: { group_by: { type: 'string', enum: ['brand', 'division', 'state'] }, week: { type: 'string' } }, required: ['group_by'] } },
  { name: 'compare_stores', description: 'Side-by-side weekly sales for 2 to 6 stores over the last N weeks.',
    input_schema: { type: 'object', properties: { store_ids: { type: 'array', items: { type: 'integer' } }, weeks: { type: 'integer' } }, required: ['store_ids'] } },
  { name: 'network_events', description: 'Openings, transfers (change of operator), closures, pipeline, franchise-agreement and lease renewal dates from the Network Tracker (2025-26 only). Filter by store_id, brand, or event type keyword (e.g. "Transfer", "Closure", "opening", "expiry").',
    input_schema: { type: 'object', properties: { store_id: { type: 'integer' }, brand: { type: 'string' }, event_type: { type: 'string' }, limit: { type: 'integer' } } } },
  { name: 'data_status', description: 'What data is held: latest week, weeks available, store counts per brand, last load, and known limitations. Call for questions like "how current is this?" or "what can you tell me?".',
    input_schema: { type: 'object', properties: {} } },
];

const impl = {
  async find_store({ text }) {
    const t = String(text || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t) return { matches: [] };
    let r = await q(`SELECT DISTINCT s.id, s.name, s.brand, s.state FROM store_aliases a JOIN stores s ON s.id=a.store_id WHERE a.alias=$1 ORDER BY s.brand, s.name`, [t]);
    if (!r.rowCount) r = await q(`SELECT DISTINCT s.id, s.name, s.brand, s.state FROM store_aliases a JOIN stores s ON s.id=a.store_id WHERE a.alias LIKE $1 OR $2 LIKE '%' || a.alias || '%' ORDER BY s.brand, s.name LIMIT 12`, ['%' + t + '%', t]);
    // prefer alias-exact hits with the longest alias when matching by containment
    return { matches: r.rows, note: r.rowCount > 1 ? 'Several stores match; confirm which one if the user did not say the brand.' : undefined };
  },

  async store_summary({ store_id }) {
    const s = (await q(`SELECT *, opening_date::text AS od FROM stores WHERE id=$1`, [store_id])).rows[0]; if (!s) return { error: 'unknown store_id' };
    const h = (await q(`SELECT week_ending::text d, sales, orders, atv FROM weekly_sales WHERE store_id=$1 AND sales IS NOT NULL ORDER BY week_ending DESC LIMIT 13`, [store_id])).rows;
    const lw = await latestWeek(); const cur = h[0]; const prev = h[1];
    const avg = n => { const x = h.slice(0, n); return x.length ? r0(x.reduce((a, b) => a + Number(b.sales), 0) / x.length) : null; };
    let rank = null;
    if (cur && cur.d === lw) {
      const rr = (await q(`SELECT s2.id FROM weekly_sales w JOIN stores s2 ON s2.id=w.store_id WHERE w.week_ending=$1 AND s2.brand=$2 AND w.sales IS NOT NULL ORDER BY w.sales DESC`, [lw, s.brand])).rows.map(x => x.id);
      rank = { position: rr.indexOf(store_id) + 1, of: rr.length, brand: s.brand };
    }
    const od = s.od || null;
    return {
      store: s.name, brand: s.brand, division: s.division, state: s.state, address: s.address, phone: s.phone, trading_company: s.trading_company, bdm: s.bdm,
      opening: od ? { date: od, source: s.opening_date_source, reliability: s.opening_date_confidence } : { date: null, note: 'No opening date on record' },
      latest_week_ending: lw, store_has_latest_week: !!(cur && cur.d === lw),
      latest: cur ? { week_ending: cur.d, sales: r0(cur.sales), orders: cur.orders, atv: r2(cur.atv) } : null,
      previous_week: prev ? { week_ending: prev.d, sales: r0(prev.sales) } : null,
      change_vs_previous_week_pct: cur && prev ? pct(Number(cur.sales), Number(prev.sales)) : null,
      avg_last_4_weeks: avg(4), avg_last_13_weeks: avg(13), weeks_held: h.length, rank_in_brand_latest_week: rank,
    };
  },

  async store_sales_history({ store_id, weeks = 13 }) {
    const n = Math.max(1, Math.min(13, weeks));
    const s = (await q(`SELECT name,brand FROM stores WHERE id=$1`, [store_id])).rows[0]; if (!s) return { error: 'unknown store_id' };
    const r = await q(`SELECT week_ending::text week_ending, sales, orders, atv FROM weekly_sales WHERE store_id=$1 ORDER BY week_ending DESC LIMIT $2`, [store_id, n]);
    return { store: s.name, brand: s.brand, weeks: r.rows.map(x => ({ week_ending: x.week_ending, sales: r0(x.sales), orders: x.orders, atv: r2(x.atv) })), note: 'Orders and ATV are held for the latest week only.' };
  },

  async rank_stores({ week, brand, state, order = 'top', limit = 10 }) {
    const d = await resolveWeek(week); const n = Math.max(1, Math.min(25, limit));
    const r = await q(`SELECT s.id, s.name, s.brand, s.state, w.sales, w.orders, w.atv FROM weekly_sales w JOIN stores s ON s.id=w.store_id
      WHERE w.week_ending=$1 AND w.sales IS NOT NULL AND ($2::text IS NULL OR s.brand ILIKE '%'||$2||'%') AND ($3::text IS NULL OR s.state=upper($3))
      ORDER BY w.sales ${order === 'bottom' ? 'ASC' : 'DESC'} LIMIT $4`, [d, brand || null, state || null, n]);
    return { week_ending: d, order, results: r.rows.map((x, i) => ({ rank: i + 1, store_id: x.id, store: x.name, brand: x.brand, state: x.state, sales: r0(x.sales), orders: x.orders, atv: r2(x.atv) })),
      note: state ? 'State is only recorded for stores matched to the SharePoint list, so a state filter may miss stores.' : undefined };
  },

  async group_totals({ group_by, week }) {
    const col = { brand: 's.brand', division: 's.division', state: "COALESCE(s.state,'(state not recorded)')" }[group_by]; if (!col) return { error: 'bad group_by' };
    const d = await resolveWeek(week);
    const prevD = (await q(`SELECT max(week_ending)::text d FROM weekly_sales WHERE week_ending < $1`, [d])).rows[0].d;
    const r = await q(`SELECT ${col} g, sum(CASE WHEN w.week_ending=$1 THEN w.sales END) cur, sum(CASE WHEN w.week_ending=$2 THEN w.sales END) prev,
        count(DISTINCT CASE WHEN w.week_ending=$1 AND w.sales IS NOT NULL THEN s.id END) stores
      FROM weekly_sales w JOIN stores s ON s.id=w.store_id WHERE w.week_ending IN ($1,$2) GROUP BY 1 ORDER BY cur DESC NULLS LAST`, [d, prevD]);
    const rep = (await q(`SELECT report_total FROM weekly_totals WHERE week_ending=$1`, [d])).rows[0];
    const sum = r.rows.reduce((a, b) => a + Number(b.cur || 0), 0);
    return { week_ending: d, previous_week_ending: prevD, groups: r.rows.map(x => ({ group: x.g, sales: r0(x.cur), previous_week_sales: r0(x.prev), change_pct: pct(Number(x.cur), Number(x.prev)), stores_trading: Number(x.stores) })),
      sum_of_stores: r0(sum), report_stated_total: rep ? r0(rep.report_total) : null };
  },

  async compare_stores({ store_ids, weeks = 8 }) {
    const ids = (store_ids || []).slice(0, 6); const n = Math.max(1, Math.min(13, weeks));
    const out = [];
    for (const id of ids) { const s = (await q(`SELECT name,brand FROM stores WHERE id=$1`, [id])).rows[0]; if (!s) continue;
      const h = (await q(`SELECT week_ending::text d, sales FROM weekly_sales WHERE store_id=$1 ORDER BY week_ending DESC LIMIT $2`, [id, n])).rows;
      out.push({ store_id: id, store: s.name, brand: s.brand, weeks: h.map(x => ({ week_ending: x.d, sales: r0(x.sales) })) }); }
    return { stores: out };
  },

  async network_events({ store_id, brand, event_type, limit = 30 }) {
    const r = await q(`SELECT source, brand, restaurant, state, event_type, event_date, date_meaning, note FROM network_events
      WHERE ($1::int IS NULL OR store_id=$1) AND ($2::text IS NULL OR brand ILIKE '%'||$2||'%') AND ($3::text IS NULL OR event_type ILIKE '%'||$3||'%')
      ORDER BY event_date NULLS LAST LIMIT $4`, [store_id || null, brand || null, event_type || null, Math.min(60, limit)]);
    return { events: r.rows, note: 'Source is the Network Tracker workbook (2025 and early 2026 only). Some forecast dates were never updated.' };
  },

  async data_status() {
    const lw = await latestWeek();
    const wk = (await q(`SELECT count(DISTINCT week_ending) n, min(week_ending)::text mn FROM weekly_sales`)).rows[0];
    const br = (await q(`SELECT brand, count(*) n FROM stores GROUP BY 1 ORDER BY 2 DESC`)).rows;
    const ll = (await q(`SELECT loaded_at::text, kind, file_name FROM load_log ORDER BY id DESC LIMIT 1`)).rows[0];
    return { latest_week_ending: lw, weeks_held: Number(wk.n), earliest_week_ending: wk.mn, stores_by_brand: br,
      last_load: ll, limitations: [
        'Sales history is 13 weeks (from the Power BI Detailed Sales Records). Longer history only builds up as weeks are added.',
        'Orders and ATV are held for the latest week only.',
        'Weeks end on a Sunday.',
        'Opening dates: 51 stores have a reliable date; many older stores only have a franchise-agreement start date (marked low reliability); some have none.',
        'Address, trading company and BDM exist only for stores found in the SharePoint franchisee list (Huxtaburger, Acai Bros and most newer stores are not in it).',
      ] };
  },
};

async function run(name, input) {
  if (!impl[name]) return { error: 'unknown tool ' + name };
  try { return await impl[name](input || {}); } catch (e) { return { error: 'query failed: ' + e.message }; }
}
module.exports = { defs, run, latestWeek };
