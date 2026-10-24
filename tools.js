// Fixed catalogue of read-only query shapes. Claude chooses a tool and its arguments; it never writes SQL.
// Every number in an answer must come from one of these results.
const { q } = require('./db');
const FIN = require('./lib-finance');
const BOARD = require('./lib-board');
const MANUALS = require('./lib-manuals');
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
  { name: 'show_on_map', description: 'Put stores on the map window for the user. Call it, with the store_ids you already have from find_store or another lookup, whenever the user asks where a store is, or to show, locate or map one or more stores. After calling it, say in a sentence where the store is, using the address from store_summary when there is one; do not describe the map.',
    input_schema: { type: 'object', properties: { store_ids: { type: 'array', items: { type: 'integer' } } }, required: ['store_ids'] } },
  { name: 'find_store', description: 'Find stores by a spoken or typed name (e.g. "Hawthorn", "Toowoomba noodle box"). Returns candidate stores with ids. Always call this first when the user names a store and no store_id is given. If several brands match, ask the user which one.',
    input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'store_summary', description: 'Profile of one store (brand, state, address, trading company, BDM, opening date and how reliable it is) plus latest-week sales, orders, average transaction value (ATV when available), change vs previous week, 4-week average, 13-week average, and rank within its brand for the latest week.',
    input_schema: { type: 'object', properties: { store_id: { type: 'integer' } }, required: ['store_id'] } },
  { name: 'store_sales_history', description: 'Weekly sales (and orders/ATV where held) for one store, newest first.',
    input_schema: { type: 'object', properties: { store_id: { type: 'integer' }, weeks: { type: 'integer', description: 'how many weeks, default 13, max 13' } }, required: ['store_id'] } },
  { name: 'rank_stores', description: 'Top or bottom stores by sales for a week, optionally filtered by brand or state. week = "latest" or a week-ending date (YYYY-MM-DD, a Sunday), or 0, -1, -2 for latest, the week before, etc. limit is up to 100 stores (default 10); offset skips that many ranked stores, so a longer list can be read in pages. The result always says total_matching (how many stores fit the filter) and returned, so never say you cannot name stores that are still in the list: ask again with a bigger limit or an offset.',
    input_schema: { type: 'object', properties: { week: { type: 'string' }, brand: { type: 'string' }, state: { type: 'string' }, order: { type: 'string', enum: ['top', 'bottom'] }, limit: { type: 'integer' }, offset: { type: 'integer' } } } },
  { name: 'group_totals', description: 'Total sales for a week grouped by brand, division or state, with change vs the previous week and store counts. Also returns the network total and the report\'s own stated total.',
    input_schema: { type: 'object', properties: { group_by: { type: 'string', enum: ['brand', 'division', 'state'] }, week: { type: 'string' } }, required: ['group_by'] } },
  { name: 'compare_stores', description: 'Side-by-side weekly sales for 2 to 6 stores over the last N weeks.',
    input_schema: { type: 'object', properties: { store_ids: { type: 'array', items: { type: 'integer' } }, weeks: { type: 'integer' } }, required: ['store_ids'] } },
  { name: 'network_events', description: 'Older, coarser list (prefer the pipeline tool for pipeline status, delays, renewals and expiries). Openings, transfers (change of operator), closures, pipeline, franchise-agreement and lease renewal dates from the Network Tracker (2025-26 only). Filter by store_id, brand, or event type keyword (e.g. "Transfer", "Closure", "opening", "expiry").',
    input_schema: { type: 'object', properties: { store_id: { type: 'integer' }, brand: { type: 'string' }, event_type: { type: 'string' }, limit: { type: 'integer' } } } },
  { name: 'pipeline', description: 'The Network Tracker development pipeline (refreshed about every two weeks): new stores being built (greenfield and land-bank "COUS" sites), recently opened stores, transfers (change of operator), closures, franchise-agreement and lease renewals, the activity log, and the C8 lease list. Each site has a status, target and actual dates, days delayed, delay reason and a step-by-step checklist (FP application, location approved, lease signed, franchise docs, fee, design, permits, fitout, training, launch). action: "overview" (counts, as-at date); "list" (filter by kind greenfield/cous/opened/transfer/closure/fa_renewal/lease_renewal, brand, state, status, upcoming_only, limit); "site" (one site by store_id or text, with every step and its activity history); "delayed" (new stores running late, worst first); "expiries" (franchise agreement, lease and C8 lease expiries in the next N months, default 12, plus any already past); "activity" (log of openings, transfers and closures, filter by type, brand, state); "step" (counts and lists sites by one checklist step, e.g. text "Fran Docs Signed" or "Lease Signed" or "Out of Disclosure", with kind/brand/state filters; shows how many sites have each value, where a date counts as "dated"). Questions like "how many sites have X" use step. The tracker records a status word (Completed, Approved, Returned, In Progress, N/A) or sometimes a date for each step; say which it is, and never describe a status word as a date. Always say the latest entry date when the answer is about status, and that the tracker is refreshed about every two weeks; entries after that date are plans.',
    input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['overview', 'list', 'site', 'delayed', 'expiries', 'activity', 'step'] }, kind: { type: 'string' }, brand: { type: 'string' }, state: { type: 'string' }, status: { type: 'string' }, text: { type: 'string' }, store_id: { type: 'integer' }, months: { type: 'integer' }, upcoming_only: { type: 'boolean' }, limit: { type: 'integer' } }, required: ['action'] } },
  { name: 'budget', description: 'The FY27 budget (July 2026 to June 2027), compared with FY26 actual. Sections: network_sales, estate_sales_by_brand, store_count, openings (monthly), greenfield, revenue, expense, profit (investment projects, EBITDA, EBIT, NPAT, dividends), marketing_pl (Marketing Concepts, a separate entity), cashflow (monthly), headcount. action: "overview" (what is held and the headline figures), "section" (all lines of a section, optional brand), "find" (search line names, e.g. "royalties", "IT costs", "NPAT"), "notes" (assumptions and commentary; text filters by topic or words, e.g. "greenfield", "acai", "cash"), "vs_actual" (budget run-rate against actual weekly sales by brand since 1 July 2026; approximate). Budget network sales are not on the same basis as weekly Sales Report figures, so say any comparison is approximate.',
    input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['overview', 'section', 'find', 'notes', 'vs_actual'] }, section: { type: 'string' }, brand: { type: 'string' }, text: { type: 'string' } }, required: ['action'] } },
  { name: 'org_lookup', description: 'The C8 organisation chart (October FY27): names, positions, departments and who reports to whom. action: "person" (who is X / what is their role / who do they report to), "direct_reports" (who reports to X), "chain_of_command" (X up to the CEO), "department" (everyone in a department or team, e.g. Supply, Legal, Marketing, Ops & Training, Network Development), "role" (who holds a role, e.g. "Head of Finance", "Supply Manager"), "vacancies" (unfilled or recruiting roles). text = the name, role or department. Holds no contact details, addresses or salaries.',
    input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['person', 'direct_reports', 'chain_of_command', 'department', 'role', 'vacancies'] }, text: { type: 'string' } }, required: ['action'] } },
  { name: 'item_sales', description: 'Menu-item sales (dollars) by store for a multi-week period, from the Power BI Item Sales report (Noodle Box loaded so far). action: "top_items" (best-selling items; scope with store_id and/or brand, limit default 10), "item_total" (one item: total and top stores selling it; item = the item name, e.g. "Combination", "Pad Thai"), "item_in_store" (one item at one store, with its rank among that store\'s items; needs store_id and item), "store_items" (a store\'s best-selling items, needs store_id). The period is a week or a block of weeks and the result says which; by default it is the latest held, and period_end (YYYY-MM-DD, the last day of a held period) picks another. Optional state (e.g. VIC) limits to stores in that state. Some periods hold only the top 30 items nationally (the result says partial): then totals and shares are of those items only, never the whole menu. NOT the same basis as the weekly Sales Report, so never compare or add the two. Excludes POS Discount, POS Surcharge, rounding and other adjustment lines unless include_adjustments is true.',
    input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['top_items', 'item_total', 'item_in_store', 'store_items'] }, item: { type: 'string' }, store_id: { type: 'integer' }, brand: { type: 'string' }, limit: { type: 'integer' }, include_adjustments: { type: 'boolean' }, state: { type: 'string' }, period_end: { type: 'string' } }, required: ['action'] } },
  { name: 'finance', description: 'C8 consolidated financial statements from the monthly Finance Board Report PDFs (profit and loss for the month and year to date against budget and last year, balance sheet, bank debt, cash, commentary), for the months listed by data_status or action "overview". Cash flow is DERIVED (the reports have no cash flow statement): action "cash_flow" gives operating cash flow, capital spending, free cash flow before dividend, growth investment, financing and the dividend for one month. action: "overview" (months held, with revenue, operating profit, net income, cash, CBA loan), "month" (headline P&L against budget, YTD, cash, debt, net bank debt for one month), "cash_flow" (month), "lines" (search P&L or balance sheet line names for one month; statement "pl" or "bs"; text e.g. "royalties", "wages", "CBA", "growth facility"), "trend" (one line across all months held; text = line name), "commentary" (the finance team\'s written commentary for a month; text filters). month = "YYYY-MM", default the latest held. All figures AUD as reported; monthly reports can restate the prior month.',
    input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['overview', 'month', 'cash_flow', 'lines', 'trend', 'commentary'] }, month: { type: 'string' }, text: { type: 'string' }, statement: { type: 'string', enum: ['pl', 'bs'] } }, required: ['action'] } },
  { name: 'board_papers', description: 'The monthly board papers (board packs, Finance Board Reports, minutes, agendas) as PDFs: a machine-written summary of each (key points and decisions, with page numbers) and the text of every page for search. Use it for what the board was told, discussed or decided, plans, risks, projects and explanations; NOT for figures (finance tool) or store sales. action: "list" (papers held, optionally one month "YYYY-MM" and/or type), "summary" (one paper by id: summary, key points, decisions, topics), "search" (query = topic words or a phrase; returns matching papers and pages with quoted snippets, optionally for one month or type). type = board_pack | finance_board_report | minutes | agenda. Every result names the file and where the original is kept; say which paper and page you are quoting.', input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'summary', 'search'] }, query: { type: 'string' }, month: { type: 'string', description: 'YYYY-MM' }, type: { type: 'string', enum: ['board_pack', 'finance_board_report', 'minutes', 'agenda'] }, doc_id: { type: 'integer' }, limit: { type: 'integer' } }, required: [] } },
  { name: 'manuals', description: 'The C8 operating manuals (Operations Manual, Food Safety Manual, Human Resources Manual, Equipment Manual): the text of every page for search. Use it for how things are done in a restaurant: procedures, food safety, cleaning, equipment, rostering, HR policy. action: "list" (manuals held), "search" (query = key words; returns matching pages with quoted snippets), "page" (doc_id + page: the whole page text). Always name the manual and page you are drawing on.', input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'search', 'page'] }, query: { type: 'string' }, doc_id: { type: 'integer' }, page: { type: 'integer' }, limit: { type: 'integer' } }, required: [] } },
  { name: 'data_status', description: 'What data is held: latest week, weeks available, store counts per brand, last load, and known limitations. Call for questions like "how current is this?" or "what can you tell me?".',
    input_schema: { type: 'object', properties: {} } },
];

// ---- who may use what: every tool belongs to an area; a person's class lists the areas they may use (see auth.js and Admin → Users) ----
const ALL_AREAS = ['sales', 'org', 'finance', 'finance_commentary', 'exec_pay', 'budget', 'board_papers', 'manuals'];
const AREA_OF = { show_on_map: 'sales', find_store: 'sales', store_summary: 'sales', store_sales_history: 'sales', rank_stores: 'sales', group_totals: 'sales', compare_stores: 'sales', network_events: 'sales', pipeline: 'sales', item_sales: 'sales',
  org_lookup: 'org', finance: 'finance', budget: 'budget', board_papers: 'board_papers', manuals: 'manuals' };   // data_status is open to everyone but only describes what the person may use
const EXEC_PAY = /exec|director|\bLTI\b|\bSTI\b|incentive|\bCEO\b|\bCFO\b/i;   // finance lines that show executive or director pay
function defsFor(areas) {
  const a = areas || ALL_AREAS;
  return defs.filter(d => d.name === 'data_status' || a.includes(AREA_OF[d.name])).map(d => {
    if (d.name !== 'finance' || a.includes('finance_commentary')) return d;
    const sch = JSON.parse(JSON.stringify(d.input_schema)); sch.properties.action.enum = sch.properties.action.enum.filter(x => x !== 'commentary');
    return { ...d, input_schema: sch, description: d.description.replace(', commentary)', ')').replace(', "commentary" (the finance team\'s written commentary for a month; text filters)', '') };
  });
}

const impl = {
  async show_on_map({ store_ids }) { const n = (Array.isArray(store_ids) ? store_ids : []).filter(Number.isInteger).length; return { ok: true, stores_shown: n, note: 'The map is now showing these stores to the user.' }; },
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

  async rank_stores({ week, brand, state, order = 'top', limit = 10, offset = 0 }) {
    const d = await resolveWeek(week); const n = Math.max(1, Math.min(100, Number(limit) || 10)); const off = Math.max(0, Number(offset) || 0);
    const r = await q(`SELECT s.id, s.name, s.brand, s.state, w.sales, w.orders, w.atv FROM weekly_sales w JOIN stores s ON s.id=w.store_id
      WHERE w.week_ending=$1 AND w.sales IS NOT NULL AND ($2::text IS NULL OR s.brand ILIKE '%'||$2||'%') AND ($3::text IS NULL OR s.state=upper($3))
      ORDER BY w.sales ${order === 'bottom' ? 'ASC' : 'DESC'}, s.name LIMIT $4 OFFSET $5`, [d, brand || null, state || null, n, off]);
    const tot = Number((await q(`SELECT count(*) n FROM weekly_sales w JOIN stores s ON s.id=w.store_id WHERE w.week_ending=$1 AND w.sales IS NOT NULL AND ($2::text IS NULL OR s.brand ILIKE '%'||$2||'%') AND ($3::text IS NULL OR s.state=upper($3))`, [d, brand || null, state || null])).rows[0].n);
    return { week_ending: d, order, total_matching: tot, returned: r.rows.length, offset: off, more_available: off + r.rows.length < tot ? `${tot - off - r.rows.length} more stores: call again with offset ${off + r.rows.length}` : undefined, results: r.rows.map((x, i) => ({ rank: off + i + 1, store_id: x.id, store: x.name, brand: x.brand, state: x.state, sales: r0(x.sales), orders: x.orders, atv: r2(x.atv) })),
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

  async item_sales({ action = 'top_items', item, store_id, brand, limit = 10, include_adjustments = false, state, period_end }) {
    const per = (await q(`SELECT brand, period_start::text ps, period_end::text pe, count(DISTINCT store_name) stores, count(DISTINCT item_name) items FROM item_sales GROUP BY 1,2,3 ORDER BY max(period_end) DESC, (max(period_end) - min(period_start)) ASC`)).rows;
    if (!per.length) return { error: 'No item sales have been loaded yet.' };
    let b = brand ? (per.find(p => p.brand.toLowerCase().includes(String(brand).toLowerCase())) || {}).brand : null; let sName = null;
    if (store_id) { const s = (await q(`SELECT name, brand FROM stores WHERE id=$1`, [store_id])).rows[0]; if (!s) return { error: 'unknown store_id' }; sName = s.name; b = b || s.brand; }
    if (brand && !b) return { error: 'No item sales are held for that brand. Held: ' + [...new Set(per.map(p => p.brand))].join(', ') };
    let cands = per.filter(p => !b || p.brand === b); if (period_end) { cands = cands.filter(p => p.pe === String(period_end).slice(0, 10)); if (!cands.length) return { error: 'No item sales period ends on ' + period_end + '. Held: ' + per.filter(p => !b || p.brand === b).slice(0, 10).map(p => p.ps + ' to ' + p.pe).join('; ') }; }
    const pr = cands[0]; if (!pr) return { error: 'No item sales held for ' + b };
    let stIds = null; if (state) { stIds = (await q(`SELECT id FROM stores WHERE upper(state)=upper($1) AND active`, [String(state).trim()])).rows.map(r => r.id); if (!stIds.length) return { error: 'No stores are held for state ' + state }; }
    const n = Math.max(1, Math.min(25, Number(limit) || 10));
    const ADJ = `lower(item_name) NOT IN ('pos discount','pos surcharge','sale rounding','dynamic plu instruction')`;
    const base = `FROM item_sales WHERE brand=$1 AND period_start=$2 AND period_end=$3 AND ($4::int IS NULL OR store_id=$4) ${stIds ? 'AND store_id IN (' + stIds.map(Number).join(',') + ')' : ''} ${include_adjustments ? '' : 'AND ' + ADJ}`;
    const args = [pr.brand, pr.ps, pr.pe, store_id || null];
    const meta = { brand: pr.brand, period: pr.ps + ' to ' + pr.pe, stores_in_report: Number(pr.stores), scope: sName || (state ? String(state).toUpperCase() + ' ' : 'all ') + pr.brand + ' stores in the report', items_in_period: Number(pr.items), available_periods: per.filter(p => p.brand === pr.brand).slice(0, 8).map(p => p.ps + ' to ' + p.pe + (Number(p.items) <= 35 ? ' (top ' + p.items + ' items only)' : '')), ...(Number(pr.items) <= 35 ? { partial: true, caution: 'This period holds only the top ' + pr.items + ' items nationally, so totals and shares are of those items, not the whole menu.' } : {}), basis: 'Item Sales report, dollars. Not on the same basis as the weekly Sales Report; do not compare them.' };
    const r2n = v => Math.round(Number(v) * 100) / 100;
    if (action === 'top_items' || action === 'store_items') {
      if (action === 'store_items' && !store_id) return { error: 'store_items needs store_id' };
      const rows = (await q(`SELECT item_name, sum(sales) s ${base} GROUP BY item_name HAVING sum(sales) > 0 ORDER BY s DESC LIMIT ${n}`, args)).rows;
      const tot = (await q(`SELECT sum(sales) s ${base}`, args)).rows[0].s;
      return { ...meta, total_item_sales: r2n(tot), items: rows.map(x => ({ item: x.item_name, sales: r2n(x.s), share_pct: Math.round(x.s / tot * 1000) / 10 })) };
    }
    if (!item) return { error: 'item is required' };
    let names = (await q(`SELECT DISTINCT item_name ${base} AND lower(item_name)=lower($5)`, [...args, item.trim()])).rows.map(x => x.item_name);
    if (!names.length) names = (await q(`SELECT item_name, sum(sales) s ${base} AND item_name ILIKE '%'||$5||'%' GROUP BY 1 ORDER BY s DESC LIMIT 6`, [...args, item.trim()])).rows.map(x => x.item_name);
    if (!names.length) return { ...meta, error: 'No item matching "' + item + '" in this report.' };
    if (names.length > 1) return { ...meta, ambiguous_items: names, note: 'Several items match; ask which one, or use the exact name.' };
    const it = names[0]; const a2 = [...args, it];
    if (action === 'item_total') {
      const tot = (await q(`SELECT sum(sales) s, count(DISTINCT store_name) FILTER (WHERE sales > 0) n ${base} AND item_name=$5`, a2)).rows[0];
      const top = (await q(`SELECT store_name, sum(sales) s ${base} AND item_name=$5 GROUP BY 1 ORDER BY s DESC LIMIT ${n}`, a2)).rows;
      return { ...meta, item: it, total_sales: r2n(tot.s), stores_selling: Number(tot.n), top_stores: top.map(x => ({ store: x.store_name, sales: r2n(x.s) })) };
    }
    if (action === 'item_in_store') {
      if (!store_id) return { error: 'item_in_store needs store_id' };
      const mine = (await q(`SELECT sum(sales) s ${base} AND item_name=$5`, a2)).rows[0].s;
      const rk = (await q(`SELECT item_name, sum(sales) s ${base} GROUP BY 1 HAVING sum(sales) > 0 ORDER BY s DESC`, args)).rows;
      const pos = rk.findIndex(x => x.item_name === it);
      const tot = rk.reduce((a, x) => a + Number(x.s), 0);
      return { ...meta, item: it, store: sName, sales: r2n(mine || 0), rank_in_store: pos >= 0 ? pos + 1 : null, of_items: rk.length, share_of_store_item_sales_pct: tot ? Math.round(Number(mine || 0) / tot * 1000) / 10 : null };
    }
    return { error: 'unknown action' };
  },

  async org_lookup({ action = 'person', text = '' }) {
    const all = (await q(`SELECT id,name,position,department,team,parent_id,kind,chart_group,status_flag,region,notes,reports_to_basis basis FROM people ORDER BY id`)).rows;
    if (!all.length) return { error: 'No organisation chart has been loaded yet.' };
    const by = new Map(all.map(p => [p.id, p])); const kids = new Map(); for (const p of all) if (p.parent_id) kids.set(p.parent_id, [...(kids.get(p.parent_id) || []), p]);
    const nm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); const t = nm(text);
    const label = p => p.kind === 'vacant' ? `Vacant: ${p.position}` : p.name;
    const brief = p => ({ name: p.kind === 'vacant' ? null : p.name, position: p.position, department: p.department, team: p.team, vacant: p.kind === 'vacant' ? true : undefined, flag: p.status_flag || undefined });
    const full = p => { const boss = by.get(p.parent_id); const dr = kids.get(p.id) || []; return { ...brief(p), region: p.region || undefined, reports_to: boss ? { name: label(boss), position: boss.position } : null, how_reporting_line_is_known: p.basis || undefined, direct_reports: dr.map(d => `${label(d)} (${d.position})`), note: p.notes || undefined }; };
    const nameHits = () => all.filter(p => p.kind !== 'vacant' && t && (nm(p.name) === t || nm(p.name).includes(t) || t.split(' ').filter(w => w.length > 2).every(w => nm(p.name).includes(w)) && t.split(' ').filter(w => w.length > 2).length));
    const src = 'Source: C8 org chart slides, October FY27. Names, positions and reporting lines only.';
    if (action === 'vacancies') return { vacancies: all.filter(p => p.kind === 'vacant').map(p => ({ role: p.position, department: p.department, reports_to: label(by.get(p.parent_id) || {}), flag: p.status_flag })), note: src };
    if (action === 'department') { const l = all.filter(p => p.kind !== 'group' && t && (nm(p.department).includes(t) || nm(p.team).includes(t))); return { matches: l.map(p => ({ ...brief(p), reports_to: label(by.get(p.parent_id) || {}) })), note: src }; }
    if (action === 'role') { const l = all.filter(p => t && nm(p.position).includes(t)); return { matches: l.map(p => ({ ...brief(p), reports_to: label(by.get(p.parent_id) || {}) })), note: src }; }
    let hits = nameHits(); if (!hits.length && t) hits = all.filter(p => nm(p.position).includes(t) && p.kind !== 'group');
    if (!hits.length) return { matches: [], note: 'Nobody on the chart matches that. ' + src };
    if (action === 'chain_of_command') { const p = hits[0]; const chain = []; let q = by.get(p.parent_id), n = 0; while (q && n++ < 20) { chain.push({ name: label(q), position: q.position }); q = by.get(q.parent_id); } return { person: brief(p), chain_up_to_top: chain, note: src }; }
    if (action === 'direct_reports') return { people: hits.slice(0, 4).map(p => ({ ...brief(p), direct_reports: (kids.get(p.id) || []).map(d => ({ ...brief(d) })) })), note: src };
    return { matches: hits.slice(0, 6).map(full), note: hits.length > 6 ? 'More than six matches; ask the user to be more specific. ' + src : src };
  },

  async budget({ action = 'overview', section, brand, text }) {
    const v = (await q(`SELECT fy, version, max(id) m FROM budget_lines GROUP BY 1,2 ORDER BY m DESC LIMIT 1`)).rows[0];
    if (!v) return { error: 'No budget has been loaded yet.' };
    const meta = { budget: v.fy, version: v.version, note: 'FY27 budget (July 2026 to June 2027); AUD.' };
    const lines = async (where, args) => (await q(`SELECT section, brand, line, period, value::float8 v, unit FROM budget_lines WHERE fy=$1 AND version=$2 ${where} ORDER BY id`, [v.fy, v.version, ...args])).rows;
    const shape = rows => { const m = new Map(); for (const r of rows) { const k = r.section + '|' + r.brand + '|' + r.line; if (!m.has(k)) m.set(k, { section: r.section, brand: r.brand || undefined, line: r.line, unit: r.unit, values: {} }); m.get(k).values[r.period] = r.unit === 'AUD' ? r0(r.v) : r2(r.v); }
      return [...m.values()].map(x => { const a = x.values.FY26A, b = x.values.FY27B; if (a != null && b != null && a) x.change_pct = pct(b, a); return x; }); };
    if (action === 'overview') {
      const secs = (await q(`SELECT section, count(*) n FROM budget_lines WHERE fy=$1 AND version=$2 GROUP BY 1`, [v.fy, v.version])).rows;
      const head = shape(await lines(`AND ((section='network_sales' AND line IN ('Total network sales')) OR (section='revenue' AND line='Total revenue') OR (section='profit' AND line IN ('Operating profit before investment projects','EBITDA before shareholder costs','Net profit after tax','Dividends')) OR (section='expense' AND line IN ('Employment costs','Total expenses')) OR (section='store_count' AND brand='Total network') OR (section='headcount' AND brand='' AND line LIKE 'Closing headcount (C8)'))`, []));
      return { ...meta, sections: secs.map(s => s.section), headline: head };
    }
    if (action === 'section') { if (!section) return { error: 'section needed' }; const rows = await lines(`AND section=$3 AND ($4::text IS NULL OR brand ILIKE '%'||$4||'%')`, [section, brand || null]); if (!rows.length) return { error: 'No such section (or brand). Sections: network_sales, estate_sales_by_brand, store_count, openings, greenfield, revenue, expense, profit, marketing_pl, cashflow, headcount' }; return { ...meta, lines: shape(rows) }; }
    if (action === 'find') { if (!text) return { error: 'text needed' }; const rows = await lines(`AND (line ILIKE '%'||$3||'%' OR brand ILIKE '%'||$3||'%') AND ($4::text IS NULL OR section=$4)`, [text, section || null]); return { ...meta, lines: shape(rows).slice(0, 40) }; }
    if (action === 'notes') { const r = (await q(`SELECT topic, note FROM budget_notes WHERE fy=$1 AND version=$2 AND ($3::text IS NULL OR topic ILIKE '%'||$3||'%' OR note ILIKE '%'||$3||'%') ORDER BY id`, [v.fy, v.version, text || null])).rows; return { ...meta, notes: r }; }
    if (action === 'vs_actual') {
      const wk = (await q(`SELECT count(DISTINCT week_ending) n, min(week_ending)::text mn, max(week_ending)::text mx FROM weekly_sales WHERE week_ending > '2026-07-05'`)).rows[0];
      const act = (await q(`SELECT s.brand, sum(w.sales)::float8 s FROM weekly_sales w JOIN stores s ON s.id=w.store_id WHERE w.week_ending > '2026-07-05' GROUP BY 1`)).rows;
      const bud = await lines(`AND section='estate_sales_by_brand' AND period='FY27B'`, []); const n = Number(wk.n);
      const alias = { 'Acai Bros': 'Acai Brothers', 'Wok In A Box - OTR': 'Wok in a Box OTR' };
      return { ...meta, weeks_of_actuals_held: n, from_week_ending: wk.mn, to_week_ending: wk.mx,
        by_brand: act.map(a => { const b = bud.find(x => x.brand.toLowerCase() === (alias[a.brand] || a.brand).toLowerCase()); const runrate = b ? b.v / 52 * n : null; return { brand: a.brand, actual_sales: r0(a.s), budget_existing_estate_run_rate: r0(runrate), difference_pct: runrate ? pct(a.s, runrate) : null }; }),
        caution: 'Approximate only: the budget run-rate is the existing-estate annual figure divided by 52 and multiplied by the weeks held (no seasonality, no greenfield timing), while actuals include every store reporting, including new openings. Weekly Sales Report and budget are not the same basis.' };
    }
    return { error: 'unknown action' };
  },


  async pipeline({ action = 'overview', kind, brand, state, status, text, store_id, months = 12, upcoming_only, limit = 25 }) {
    const meta = (await q(`SELECT max(as_of)::text a, count(*) n FROM pipeline_projects`).catch(() => ({ rows: [{ n: 0 }] }))).rows[0];
    if (!Number(meta.n)) return { error: 'The Network Tracker pipeline has not been loaded yet.' };
    const lim = Math.max(1, Math.min(60, Number(limit) || 25));
    const KINDS = { greenfield: 'greenfield', new: 'greenfield', cous: 'cous', landbank: 'cous', opened: 'opened', transfer: 'transfer', transfers: 'transfer', closure: 'closure', closures: 'closure', fa_renewal: 'fa_renewal', fa: 'fa_renewal', lease_renewal: 'lease_renewal', lease: 'lease_renewal' };
    const kd = kind ? KINDS[String(kind).toLowerCase().replace(/[^a-z_]/g, '')] : null;
    const note = `The latest dated entry in the tracker is ${meta.a}. It is refreshed about every two weeks, so more recent changes may not show. Entries after that date are plans, not facts.`;
    const DONE = /^(completed|approved|received|yes|returned|paid|issued|signed|\d{4}-\d{2}-\d{2})/i;
    const progress = steps => { const live = steps.filter(s => !/^(n\/a|no|tbc|-)$/i.test(s.value) && !/^\$?[\d,.]+$/.test(s.value)); const done = live.filter(s => DONE.test(s.value)); const open = live.filter(s => !DONE.test(s.value));
      return { steps_done: done.length, steps_counted: live.length, next_open: open.slice(0, 3).map(s => `${s.step}: ${s.value}`), delayed_steps: live.filter(s => /^delayed/i.test(s.value)).map(s => `${s.step}: ${s.value}`) }; };
    const attach = async rows => { if (!rows.length) return rows; const st = (await q(`SELECT project_id, phase, step, value FROM pipeline_steps WHERE project_id = ANY($1) ORDER BY project_id, seq`, [rows.map(r => r.id)])).rows;
      const by = {}; for (const s of st) (by[s.project_id] = by[s.project_id] || []).push(s); return rows.map(r => ({ ...r, progress: progress(by[r.id] || []), _steps: by[r.id] || [] })); };
    const cols = `id, kind, restaurant, brand, state, gsm, partner, status, at_risk, target_date::text, actual_date::text, delayed_days, delay_reason, budgeted_date::text, est_weekly_sales::float8, lost_revenue::float8, fa_expiry::text, lease_expiry::text, store_id, (COALESCE(actual_date, target_date) - CURRENT_DATE) AS days_until`;
    const filt = (args) => { const w = []; if (kd) { args.push(kd); w.push(`kind=$${args.length}`); } if (brand) { args.push('%' + brand + '%'); w.push(`brand ILIKE $${args.length}`); } if (state) { args.push(String(state).toUpperCase()); w.push(`upper(state)=$${args.length}`); } if (status) { args.push('%' + status + '%'); w.push(`status ILIKE $${args.length}`); } if (store_id) { args.push(store_id); w.push(`store_id=$${args.length}`); } if (text) { args.push('%' + text + '%'); w.push(`restaurant ILIKE $${args.length}`); } return w.length ? 'WHERE ' + w.join(' AND ') : ''; };
    const lite = r => { const { _steps, id, ...x } = r; return x; };
    if (action === 'overview') {
      const k = (await q(`SELECT kind, count(*) n FROM pipeline_projects GROUP BY 1 ORDER BY 2 DESC`)).rows;
      const g = (await q(`SELECT brand, state, status, count(*) n FROM pipeline_projects WHERE kind IN ('greenfield','cous') GROUP BY 1,2,3 ORDER BY 1,2`)).rows;
      const act = (await q(`SELECT type, count(*) n FROM pipeline_activity GROUP BY 1 ORDER BY 2 DESC`)).rows;
      return { latest_entry: meta.a, sites_by_tab: k, new_store_pipeline: g, activity_by_type: act, note };
    }
    if (action === 'list') {
      const args = []; let w = filt(args); if (upcoming_only) w += (w ? ' AND ' : 'WHERE ') + `COALESCE(actual_date, target_date) >= CURRENT_DATE - 7`;
      const r = await attach((await q(`SELECT ${cols} FROM pipeline_projects ${w} ORDER BY COALESCE(actual_date, target_date, fa_expiry, lease_expiry) NULLS LAST, restaurant LIMIT ${lim}`, args)).rows);
      return { latest_entry: meta.a, count: r.length, sites: r.map(lite), note };
    }
    if (action === 'site') {
      if (!store_id && !text) return { error: 'give a store_id or the site name in text' };
      const args = []; const w = filt(args);
      const r = await attach((await q(`SELECT ${cols} FROM pipeline_projects ${w} ORDER BY kind, COALESCE(actual_date, target_date) NULLS LAST LIMIT 12`, args)).rows);
      const act = (await q(`SELECT type, action_date::text d, franchise_partner, incentive, description FROM pipeline_activity WHERE ${store_id ? 'store_id=$1' : 'restaurant ILIKE $1'} ORDER BY action_date NULLS LAST LIMIT 12`, [store_id || '%' + text + '%'])).rows;
      const ls = (await q(`SELECT site, term_years::float8 term_years, commencement::text, expiry::text, bank_guarantee::float8, landlord, tenant, further_term FROM lease_liability WHERE ${store_id ? 'store_id=$1' : 'site ILIKE $1'}`, [store_id || '%' + text + '%'])).rows;
      return { latest_entry: meta.a, tracker_entries: r.map(x => ({ ...lite(x), steps: x._steps.map(s => `${s.step}: ${s.value}`) })), activity: act, c8_lease: ls, note };
    }
    if (action === 'delayed') {
      const args = []; let w = filt(args); w += (w ? ' AND ' : 'WHERE ') + `kind IN ('greenfield','cous','opened') AND delayed_days > 0`;
      const r = await attach((await q(`SELECT ${cols} FROM pipeline_projects ${w} ORDER BY delayed_days DESC LIMIT ${lim}`, args)).rows);
      return { latest_entry: meta.a, count: r.length, sites: r.map(lite), note };
    }
    if (action === 'expiries') {
      const m = Math.max(1, Math.min(60, Number(months) || 12)); const args = [m]; let extra = '';
      if (brand) { args.push('%' + brand + '%'); extra += ` AND brand ILIKE $${args.length}`; } if (state) { args.push(String(state).toUpperCase()); extra += ` AND upper(state)=$${args.length}`; }
      const fa = (await q(`SELECT DISTINCT ON (restaurant, brand) restaurant, brand, state, gsm, at_risk, fa_expiry::text, lease_expiry::text, (fa_expiry - CURRENT_DATE) days_to_fa_expiry, (lease_expiry - CURRENT_DATE) days_to_lease_expiry, store_id, kind
        FROM pipeline_projects WHERE kind IN ('fa_renewal','lease_renewal') AND ((fa_expiry <= CURRENT_DATE + ($1 || ' months')::interval) OR (lease_expiry <= CURRENT_DATE + ($1 || ' months')::interval)) ${extra}
        ORDER BY restaurant, brand, kind LIMIT 80`, args)).rows;
      const ll = (await q(`SELECT site, expiry::text, (expiry - CURRENT_DATE) days_to_expiry, landlord, bank_guarantee::float8, further_term, store_id FROM lease_liability WHERE expiry <= CURRENT_DATE + ($1 || ' months')::interval ORDER BY expiry LIMIT 40`, [m])).rows;
      const up = r => (r.days_to_fa_expiry ?? 1) >= 0 && (r.days_to_lease_expiry ?? 1) >= 0; const upl = ll.filter(x => x.days_to_expiry >= 0);
      return { latest_entry: meta.a, window_months: m, coming_up: fa.filter(up).slice(0, 40), c8_held_leases_coming_up: upl, already_past_dates: { renewals_tracker: fa.filter(r => !up(r)).slice(0, 15), c8_held_leases: ll.filter(x => x.days_to_expiry < 0), caution: 'These dates are already behind us; the tracker may simply not have been updated, or the renewal may be done. Do not call them expired without saying so.' }, note };
    }
    if (action === 'activity') {
      const w = []; const args = []; if (kind) { args.push('%' + kind + '%'); w.push(`type ILIKE $${args.length}`); } if (brand) { args.push('%' + brand + '%'); w.push(`brand ILIKE $${args.length}`); } if (state) { args.push(String(state).toUpperCase()); w.push(`upper(state)=$${args.length}`); } if (text) { args.push('%' + text + '%'); w.push(`restaurant ILIKE $${args.length}`); }
      const r = (await q(`SELECT brand, restaurant, state, type, action_date::text d, franchise_partner, incentive, description FROM pipeline_activity ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY action_date NULLS LAST LIMIT ${lim}`, args)).rows;
      const c = (await q(`SELECT type, count(*) n FROM pipeline_activity GROUP BY 1 ORDER BY 2 DESC`)).rows;
      return { latest_entry: meta.a, totals_by_type: c, rows: r, note };
    }
    if (action === 'step') {
      if (!text) return { error: 'give the step name in text, e.g. "Lease Signed"' };
      const args = ['%' + text + '%']; let w = 'WHERE s.step ILIKE $1';
      if (kd) { args.push(kd); w += ` AND p.kind=$${args.length}`; } if (brand) { args.push('%' + brand + '%'); w += ` AND p.brand ILIKE $${args.length}`; } if (state) { args.push(String(state).toUpperCase()); w += ` AND upper(p.state)=$${args.length}`; }
      const rows = (await q(`SELECT p.kind, p.restaurant, p.brand, p.state, s.step, s.value FROM pipeline_steps s JOIN pipeline_projects p ON p.id=s.project_id ${w} ORDER BY p.kind, p.restaurant LIMIT 400`, args)).rows;
      if (!rows.length) return { latest_entry: meta.a, matched_steps: [], note: 'No checklist step has a name like that. Steps include: FP Application, Location Approved, Lease Signed, LOT Issued, Prepare Fran. Docs, Fran Docs Issued, Out of Disclosure, Fran Docs Signed, Fee Collected, Design Approval, Signage Approval, Tender Shopfit, Permit Application, Fitout Status, FP Induction, Training Planner, Opening Checklist, Grand Opening Date.' };
      const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v); const groups = {};
      for (const r of rows) { const g = `${r.kind} / ${r.step}`; const o = (groups[g] = groups[g] || { sites: 0, by_value: {}, dated: 0 }); o.sites++; const k = isDate(r.value) ? 'a date' : r.value; o.by_value[k] = (o.by_value[k] || 0) + 1; if (isDate(r.value)) o.dated++; }
      return { latest_entry: meta.a, by_tab_and_step: groups, sites: rows.slice(0, lim).map(r => ({ tab: r.kind, restaurant: r.restaurant, brand: r.brand, state: r.state, step: r.step, value: r.value })), note: note + ' Values are status words or dates exactly as the tracker holds them.' };
    }
    return { error: 'unknown action' };
  },
  async finance({ action = 'overview', month, text, statement = 'pl' }, ctx) {
    const ar = (ctx && ctx.areas) || ALL_AREAS; const hide = ar.includes('exec_pay') ? (x => x) : (rows => rows.filter(r => !EXEC_PAY.test(r.line || '')));
    const months = (await q(`SELECT to_char(period,'YYYY-MM') m FROM fin_reports ORDER BY period DESC`).catch(() => ({ rows: [] }))).rows.map(r => r.m);
    if (!months.length) return { error: 'No finance reports have been loaded yet.' };
    const m = month && /^\d{4}-\d{2}$/.test(month) ? month : months[0];
    const held = { months_held: months, note: 'Monthly Finance Board Report; AUD. Months not listed are not loaded.' };
    const one = async (sql, args) => (await q(sql, args)).rows;
    const v = (rows, line, f) => { const r = rows.find(x => x.line === line); return r ? r[f] : null; };
    if (action === 'overview') {
      const rows = await one(`SELECT to_char(r.period,'YYYY-MM') AS month,
        (SELECT actual::float8 FROM fin_pl WHERE period=r.period AND kind='month' AND line='Total Revenue' LIMIT 1) revenue,
        (SELECT actual::float8 FROM fin_pl WHERE period=r.period AND kind='month' AND line='Operating Profit Before Depn & Amort.' LIMIT 1) operating_profit,
        (SELECT actual::float8 FROM fin_pl WHERE period=r.period AND kind='month' AND line='Net Income' LIMIT 1) net_income,
        (SELECT amount::float8 FROM fin_bs WHERE period=r.period AND line='Total Cash & Equivalents' LIMIT 1) cash,
        (SELECT amount::float8 FROM fin_bs WHERE period=r.period AND line='CBA Loan Facility' LIMIT 1) cba_loan
        FROM fin_reports r ORDER BY r.period DESC`);
      return { ...held, by_month: rows.map(r => ({ ...r, net_bank_debt: r.cba_loan != null && r.cash != null ? Math.round(r.cba_loan - r.cash) : null })) };
    }
    if (!months.includes(m)) return { error: `No finance report is held for ${m}.`, ...held };
    if (action === 'cash_flow') return { ...held, ...(await FIN.cashFlow(q, m)) };
    if (action === 'month') {
      const sum = await one(`SELECT line, actual::float8 actual, budget::float8 budget FROM fin_pl WHERE to_char(period,'YYYY-MM')=$1 AND kind='summary' ORDER BY seq`, [m]);
      const mo = await one(`SELECT line, actual::float8 actual, budget::float8 budget, ly::float8 last_year FROM fin_pl WHERE to_char(period,'YYYY-MM')=$1 AND kind='month' AND line IN ('Total Revenue','Total Expenses','Operating Profit Before Depn & Amort.','EBITDA','Net Income','Dividend','Retained Income')`, [m]);
      const yt = await one(`SELECT line, actual::float8 actual, budget::float8 budget, ly::float8 last_year FROM fin_pl WHERE to_char(period,'YYYY-MM')=$1 AND kind='ytd' AND line IN ('Total Revenue','Total Expenses','Operating Profit Before Depn & Amort.','EBITDA','Net Income','Dividend','Retained Income')`, [m]);
      const bs = await one(`SELECT line, amount::float8 amount, prior::float8 prior FROM fin_bs WHERE to_char(period,'YYYY-MM')=$1 AND line IN ('Total Cash & Equivalents','CBA Loan Facility','Total Shareholders Loan','Total Assets','Total Liabilities','Total Equity','Total Liabilities & Equity')`, [m]);
      const cash = v(bs, 'Total Cash & Equivalents', 'amount'), cba = v(bs, 'CBA Loan Facility', 'amount');
      return { ...held, month: m, summary_pl_vs_budget: sum.length ? hide(sum) : undefined, month_pl: hide(mo), year_to_date_pl: hide(yt), balance_sheet: bs, net_bank_debt: cba != null && cash != null ? Math.round(cba - cash) : null, note: 'Use cash_flow for the derived cash flow, lines to search individual lines, commentary for the finance team\'s explanations.' };
    }
    if (action === 'lines') {
      const pat = '%' + String(text || '').replace(/[%_]/g, '') + '%';
      if (statement === 'bs') return { ...held, month: m, statement: 'balance sheet', lines: await one(`SELECT grp, section, line, amount::float8 amount, prior::float8 prior_month, ly::float8 same_month_last_year FROM fin_bs WHERE to_char(period,'YYYY-MM')=$1 AND line ILIKE $2 ORDER BY seq LIMIT 40`, [m, pat]) };
      const mo = await one(`SELECT section, line, actual::float8 month_actual, budget::float8 month_budget, ly::float8 same_month_last_year FROM fin_pl WHERE to_char(period,'YYYY-MM')=$1 AND kind='month' AND line ILIKE $2 ORDER BY seq LIMIT 40`, [m, pat]);
      const yt = await one(`SELECT line, actual::float8 ytd_actual, budget::float8 ytd_budget, ly::float8 ytd_last_year FROM fin_pl WHERE to_char(period,'YYYY-MM')=$1 AND kind='ytd' AND line ILIKE $2 ORDER BY seq LIMIT 40`, [m, pat]);
      const lines = hide(mo).map(r => ({ ...r, ...(yt.find(y => y.line === r.line) || {}) })); return { ...held, month: m, statement: 'profit and loss', lines, ...(!lines.length && !ar.includes('exec_pay') && EXEC_PAY.test(String(text || '')) ? { note: 'Executive and director pay lines are outside your access.' } : {}) };
    }
    if (action === 'trend') {
      const name = String(text || '').trim(); if (!name) return { error: 'Give the line name in text, e.g. "CBA Loan Facility" or "Royalties".' };
      const pat = '%' + name.replace(/[%_]/g, '') + '%';
      const bs = hide(await one(`SELECT to_char(period,'YYYY-MM') AS month, line, amount::float8 value FROM fin_bs WHERE line ILIKE $1 ORDER BY period, seq`, [pat]));
      const pl = hide(await one(`SELECT to_char(period,'YYYY-MM') AS month, line, actual::float8 value FROM fin_pl WHERE kind='month' AND line ILIKE $1 ORDER BY period, seq`, [pat]));
      const group = (rows, kind) => { const by = {}; for (const r of rows) (by[r.line] = by[r.line] || []).push({ month: r.month, value: r.value }); return Object.entries(by).slice(0, 4).map(([line, series]) => ({ statement: kind, line, series })); };
      return { ...held, matches: [...group(bs, 'balance sheet (month-end balance)'), ...group(pl, 'profit and loss (month actual)')], note: 'Months held only; gaps are months not loaded.' };
    }
    if (action === 'commentary') {
      if (!ar.includes('finance_commentary')) return { error: 'The finance team commentary is outside your access.' };
      const r = (await one(`SELECT commentary FROM fin_reports WHERE to_char(period,'YYYY-MM')=$1`, [m]))[0]; const t = r?.commentary || '';
      if (!t) return { ...held, month: m, commentary: 'This report has no written commentary.' };
      const paras = t.split(/\n/).filter(Boolean); const words = String(text || '').toLowerCase().split(/\s+/).filter(w => w.length > 2);
      const keep = words.length ? paras.filter(x => words.some(w => x.toLowerCase().includes(w))) : paras;
      return { ...held, month: m, commentary: (keep.length ? keep : paras).join('\n').slice(0, 4000) };
    }
    return { error: 'unknown action' };
  },
  async data_status(_in, ctx) {
    const ar = (ctx && ctx.areas) || ALL_AREAS;
    const lw = await latestWeek();
    const wk = (await q(`SELECT count(DISTINCT week_ending) n, min(week_ending)::text mn FROM weekly_sales`)).rows[0];
    const br = (await q(`SELECT brand, count(*) n FROM stores GROUP BY 1 ORDER BY 2 DESC`)).rows;
    const ll = (await q(`SELECT loaded_at::text, kind, file_name FROM load_log ORDER BY id DESC LIMIT 1`)).rows[0];
    const bud = (await q(`SELECT fy, version, count(*) n FROM budget_lines GROUP BY 1,2`).catch(() => ({ rows: [] }))).rows;
    const items = (await q(`SELECT brand, period_start::text ps, period_end::text pe, count(DISTINCT store_name) stores, count(DISTINCT item_name) items FROM item_sales GROUP BY 1,2,3 ORDER BY pe DESC`).catch(() => ({ rows: [] }))).rows;
    const org = (await q(`SELECT count(*) FILTER (WHERE kind='person') people, count(*) FILTER (WHERE kind='vacant') vacancies FROM people`).catch(() => ({ rows: [{}] }))).rows[0];
    const pl = (await q(`SELECT max(as_of)::text a, count(*) n FROM pipeline_projects`).catch(() => ({ rows: [{ n: 0 }] }))).rows[0];
    const fin = (await q(`SELECT to_char(period,'YYYY-MM') m FROM fin_reports ORDER BY period DESC`).catch(() => ({ rows: [] }))).rows.map(r => r.m);
    const bd = (await q(`SELECT count(*) n, min(to_char(period,'YYYY-MM')) a, max(to_char(period,'YYYY-MM')) b, count(*) FILTER (WHERE summary IS NOT NULL) s FROM board_docs`).catch(() => ({ rows: [{ n: 0 }] }))).rows[0];
    const full = { board_papers: Number(bd.n) ? { papers: Number(bd.n), summarised: Number(bd.s), earliest_month: bd.a, latest_month: bd.b } : 'not loaded', finance_reports: fin.length ? { months_held: fin, note: 'Monthly Finance Board Reports; cash flow is derived, not reported.' } : 'not loaded', network_tracker_pipeline: Number(pl.n) ? { latest_entry: pl.a, sites: Number(pl.n) } : 'not loaded', budget: bud.length ? bud : 'not loaded', item_sales: items.length ? items : 'not loaded', organisation_chart: org.people ? { people: Number(org.people), vacancies: Number(org.vacancies), source: 'October FY27 org chart slides' } : 'not loaded', latest_week_ending: lw, weeks_held: Number(wk.n), earliest_week_ending: wk.mn, stores_by_brand: br,
      last_load: ll, limitations: [
        'Sales history is 13 weeks (from the Power BI Detailed Sales Records). Longer history only builds up as weeks are added.',
        'Orders and ATV are held for the latest week only.',
        'Weeks end on a Sunday.',
        'Opening dates: 51 stores have a reliable date; many older stores only have a franchise-agreement start date (marked low reliability); some have none.',
        'Address, trading company and BDM exist only for stores found in the SharePoint franchisee list (Huxtaburger, Acai Bros and most newer stores are not in it).',
      ] };
    // describe only what this person may use
    const mn = (await q('SELECT count(*) n FROM manual_docs').catch(() => ({ rows: [{ n: 0 }] }))).rows[0]; full.manuals = Number(mn.n) ? { manuals_held: Number(mn.n) } : 'not loaded';
    if (!ar.includes('manuals')) delete full.manuals;
    if (!ar.includes('board_papers')) delete full.board_papers;
    if (!ar.includes('finance')) delete full.finance_reports;
    if (!ar.includes('budget')) delete full.budget;
    if (!ar.includes('org')) delete full.organisation_chart;
    if (!ar.includes('sales')) { for (const k of ['network_tracker_pipeline', 'item_sales', 'latest_week_ending', 'weeks_held', 'earliest_week_ending', 'stores_by_brand', 'last_load']) delete full[k]; full.limitations = []; }
    return full;
  },
};

impl.board_papers = BOARD.tool;
impl.manuals = MANUALS.tool;
async function run(name, input, ctx) {   // ctx = { areas: [...] }; without it (scripts, tests) everything is allowed
  if (!impl[name]) return { error: 'unknown tool ' + name };
  if (ctx && ctx.areas && name !== 'data_status' && !ctx.areas.includes(AREA_OF[name])) return { error: 'That is outside this person\'s access, so it cannot be looked up.' };
  try { return await impl[name](input || {}, ctx); } catch (e) { return { error: 'query failed: ' + e.message }; }
}
module.exports = { defs, defsFor, run, latestWeek, ALL_AREAS, AREA_OF };
