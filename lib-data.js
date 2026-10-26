// Maintenance loaders for everything except weekly sales: store details (SharePoint capture), opening dates,
// network events, new stores. Each dataset type has: detect(headers), analyse(client, rows), commit(client, rows, loadId).
const { parse } = require('csv-parse/sync');
const W = require('./lib-weekly');

const key = s => String(s || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/^otr[_ \-]+/, 'otr').replace(/\b(nbx|ab|ps|hux|ss)\b/g, '').replace(/[^a-z]/g, '');
const norm = a => String(a || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const BRAND_CANON = b => { b = String(b || '').toLowerCase(); if (/noodle|nbx/.test(b)) return 'Noodle Box'; if (/patty/.test(b)) return 'Pattysmiths'; if (/hux/.test(b)) return 'Huxtaburger'; if (/acai/.test(b)) return 'Acai Bros'; if (/seoul/.test(b)) return 'South Seoul'; if (/wok|wiab|otr/.test(b)) return 'Wok In A Box - OTR'; return String(b).trim(); };
const BRAND_WORDS = { 'Noodle Box': ['noodle box', 'nbx'], 'Pattysmiths': ['pattysmiths', 'patty smiths', 'patty smith', 'ps'], 'Huxtaburger': ['huxtaburger', 'huxta', 'hux'], 'Acai Bros': ['acai bros', 'acai brothers', 'acai', 'ab'], 'South Seoul': ['south seoul', 'southern seoul', 'ss'], 'Wok In A Box - OTR': ['wok in a box', 'wokinabox', 'wiab', 'otr'] };

async function rebuildAliases(c, storeId) {
  const s = (await c.query('SELECT id,name,brand FROM stores WHERE id=$1', [storeId])).rows[0]; if (!s) return;
  await c.query("DELETE FROM store_aliases WHERE store_id=$1 AND source='auto'", [storeId]);
  const add = async a => { a = norm(a); if (a) await c.query("INSERT INTO store_aliases(alias,store_id,source) VALUES ($1,$2,'auto') ON CONFLICT DO NOTHING", [a, storeId]); };
  const bare = s.name.replace(/\(.*?\)/g, '').replace(/^OTR[_ ]/i, '').replace(/\b(NBX|AB|PS|HUX|SS)\b/g, '').trim();
  await add(s.name); await add(bare);
  for (const w of BRAND_WORDS[s.brand] || []) { await add(`${bare} ${w}`); await add(`${w} ${bare}`); }
}

// find ONE store for a name (+ optional brand). Returns {id} or {ambiguous:[..]} or {none:true}
async function matchStore(c, name, brand) {
  const m0 = await matchStore1(c, name, brand);
  if (m0.id || m0.ambiguous) return m0;
  // Power BI style names: "Noodle Box - Toowoomba NBX", "Burswood (Crown Perth)": strip brand prefix, trailing site code and brackets, then retry
  const b = brand ? BRAND_CANON(brand) : null;
  let bare = String(name || '').replace(/\(.*?\)/g, ' ').replace(/\b(NBX|AB|PS|HUX|SS|NB)\b/gi, ' ');
  const words = [].concat(...(b ? [BRAND_WORDS[b] || []] : Object.values(BRAND_WORDS)));
  for (const w of words.filter(w => w.length > 2)) bare = bare.replace(new RegExp('^\\s*' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[-–:]?\\s*', 'i'), '');
  bare = bare.replace(/\s+/g, ' ').trim();
  if (!bare || norm(bare) === norm(name)) return m0;
  const cands = [bare]; for (const w of (b ? BRAND_WORDS[b] || [] : [])) { cands.push(bare + ' ' + w, w + ' ' + bare); }
  for (const t of cands) { const m = await matchStore1(c, t, brand); if (m.id) return m; }
  return m0;
}
async function matchStore1(c, name, brand) {
  const n = norm(name); if (!n) return { none: true };
  const b = brand ? BRAND_CANON(brand) : null;
  let r = await c.query(`SELECT DISTINCT s.id,s.name,s.brand FROM store_aliases a JOIN stores s ON s.id=a.store_id WHERE a.alias=$1 ${b ? 'AND s.brand=$2' : ''}`, b ? [n, b] : [n]);
  if (r.rowCount === 1) return { id: r.rows[0].id, name: r.rows[0].name };
  if (r.rowCount > 1) return { ambiguous: r.rows.map(x => `${x.name} (${x.brand})`) };
  // fall back to normalised-key equality within brand
  const k = key(name); const all = (await c.query(`SELECT id,name,brand FROM stores ${b ? 'WHERE brand=$1' : ''}`, b ? [b] : [])).rows.filter(s => key(s.name) === k);
  if (all.length === 1) return { id: all[0].id, name: all[0].name };
  if (all.length > 1) return { ambiguous: all.map(x => `${x.name} (${x.brand})`) };
  return { none: true };
}

const rowsOf = text => parse(text, { columns: h => h.map(x => x.trim().toLowerCase().replace(/[\s\/]+/g, '_')), skip_empty_lines: true, relax_column_count: true, bom: true });
const dateOk = d => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d));
const toIso = d => { d = String(d || '').trim(); const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(d); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : d; };

const TYPES = {
  weekly_sales: { label: 'Weekly sales (Power BI detailed sales, with optional orders / ATV)' },
  store_details: { label: 'Store details (SharePoint capture: site_name, brand, state, bdm, trading_company, address, phone)' },
  store_state: { label: 'Store states (store, brand, state): fills the state on the store and on its events and pipeline records' },
  store_agreements: { label: 'Store agreements (SharePoint Franchise Master: site_name, brand, abn, royalty_rate, fa_start, fa_end, lease_start, lease_end, landlord …)' },
  company_lfl: { label: 'Company like-for-like % by week (Power BI LFL Weekly Trend: week_ending, lfl_pct [, scope, source])' },
  opening_dates: { label: 'Opening dates (store, brand, opening_date, source)' },
  network_events: { label: 'Network events (brand, restaurant, event_type, date …)' },
  new_stores: { label: 'New stores (store, brand, division)' },
  item_sales_store: { label: 'Item sales by store (brand, store, item_name, period_start, period_end, sales … replaces that brand and period)' },
  budget: { label: 'Budget (JSON file: fy, version, lines, notes … replaces that fy)' },
  pipeline: { label: 'Network Tracker pipeline (JSON file made from the tracker workbook … replaces the whole pipeline)' },
  org_chart: { label: 'Organisation chart (name, position, reports_to_id / reports_to … replaces the whole chart)' },
};
function detect(text) {
  if (/^\s*\{\s*"budget"\s*:\s*true/.test(text.slice(0, 200))) return 'budget';
  if (/^\s*\{\s*"pipeline"\s*:\s*true/.test(text.slice(0, 200))) return 'pipeline';
  const first = text.split(/\r?\n/, 1)[0].toLowerCase();
  if (/w\/e\s*\d{2}\/\d{2}\/\d{4}/.test(first)) return 'weekly_sales';
  if (/item_name/.test(first) && /(^|,)store(,|$)/.test(first) && /(^|,)sales(,|$)/.test(first)) return 'item_sales_store';
  if (/(^|,)position(,|$)/.test(first) && /reports_to/.test(first) && /(^|,)name(,|$)/.test(first)) return 'org_chart';
  if (/site_name/.test(first) && /royalty_rate|fa_end|lease_end/.test(first)) return 'store_agreements';
  if (/site_name/.test(first) && /address|trading_company|state|bdm/.test(first)) return 'store_details';
  if (/(^|,)(store|restaurant)(,|$)/.test(first) && /(^|,)state(,|$)/.test(first) && !/event_type|item_name|division|address|trading_company|bdm/.test(first)) return 'store_state';
  if (/(^|,)week_ending(,|$)/.test(first) && /lfl/.test(first)) return 'company_lfl';
  if (/event_type/.test(first)) return 'network_events';
  if (/opening_date/.test(first)) return 'opening_dates';
  if (/^"?store"?\s*,/.test(first) || /(^|,)store(,|$)/.test(first)) return /division|brand/.test(first) ? 'new_stores' : null;
  return null;
}

async function analyse(c, type, text) {
  if (type === 'budget') return analyseBudget(text);
  if (type === 'pipeline') return analysePipeline(c, text);
  if (type === 'weekly_sales') return { type, ...(await W.analyse(c, W.parseWide(text))) };
  const rows = rowsOf(text); const out = { type, rows: rows.length, matched: 0, unmatched: [], ambiguous: [], problems: [], sample: [] };
  if (type === 'item_sales_store') return analyseItemSales(c, rows);
  if (type === 'org_chart') { const plan = orgPlan(rows); return { type, rows: rows.length, people: plan.list.filter(p => p.kind === 'person').length, vacancies: plan.list.filter(p => p.kind === 'vacant').length, groups: plan.list.filter(p => p.kind === 'group').length, roots: plan.list.filter(p => !p.parent).map(p => p.name), problems: plan.problems, loop: plan.loop, note: 'Loading replaces the whole chart.' }; }
  if (type === 'company_lfl') {
    const ok = rows.filter(r => dateOk(toIso(r.week_ending)) && r.lfl_pct !== '' && Number.isFinite(Number(String(r.lfl_pct).replace('%', ''))));
    out.matched = ok.length; for (const r of rows) if (!ok.includes(r)) out.problems.push(`bad row: ${r.week_ending} / ${r.lfl_pct}`);
    const ds = ok.map(r => toIso(r.week_ending)).sort(); out.note = ok.length ? `${ok.length} weeks of like-for-like %, ${ds[0]} to ${ds.at(-1)}. Weeks already held for the same scope are replaced.` : 'No usable rows'; out.sample = ok.slice(0, 3);
    return out;
  }
  if (type === 'store_details' || type === 'store_agreements' || type === 'store_state') {
    for (const r of rows) { const m = await matchStore(c, r.store || r.restaurant || r.site_name, r.store ? undefined : r.brand); tally(out, m, r.site_name || r.store || r.restaurant); }
  } else if (type === 'opening_dates') {
    for (const r of rows) { const d = toIso(r.opening_date); if (!dateOk(d)) { out.problems.push(`${r.store}: bad date "${r.opening_date}" (use YYYY-MM-DD or dd/mm/yyyy)`); continue; } const m = await matchStore(c, r.store, r.brand); tally(out, m, r.store); if (m.id && out.sample.length < 8) out.sample.push(`${m.name}: ${d}`); }
  } else if (type === 'network_events') {
    for (const r of rows) { if (!r.event_type || !r.restaurant) { out.problems.push('row missing restaurant or event_type'); continue; } const m = await matchStore(c, r.restaurant, r.brand); if (m.id) out.matched++; else out.unmatched.push(r.restaurant + ' (stored unlinked)'); }
    out.note = 'Events are stored even if the restaurant is not in the sales list (pipeline sites, closed stores).';
  } else if (type === 'new_stores') {
    const ex = new Set((await c.query('SELECT lower(name) n FROM stores')).rows.map(x => x.n));
    out.newStores = rows.filter(r => r.store && !ex.has(r.store.toLowerCase())).map(r => `${r.store} (${r.brand})`); out.existing = rows.length - out.newStores.length;
    for (const r of rows) if (!r.store || !r.brand) out.problems.push('row missing store or brand');
  }
  out.unmatched = [...new Set(out.unmatched)]; return out;
}
function tally(out, m, label) { if (m.id) out.matched++; else if (m.ambiguous) out.ambiguous.push(`${label} → ${m.ambiguous.join(' / ')}`); else out.unmatched.push(label); }

// copy each store's state onto the events and pipeline records linked to it
async function propagateState(c) {
  for (const t of ['network_events', 'pipeline_projects', 'pipeline_activity'])
    await c.query(`UPDATE ${t} x SET state=s.state FROM stores s WHERE x.store_id=s.id AND COALESCE(s.state,'')<>'' AND x.state IS DISTINCT FROM s.state`);
}

async function commit(c, type, text, fileName) {
  if (type === 'budget') return commitBudget(c, text, fileName);
  if (type === 'pipeline') return commitPipeline(c, text, fileName);
  if (type === 'weekly_sales') return W.commit(c, W.parseWide(text), fileName);
  const rows = rowsOf(text);
  if (type === 'org_chart') return commitOrg(c, rows, fileName);
  if (type === 'item_sales_store') return commitItemSales(c, rows, fileName);
  const log = await c.query('INSERT INTO load_log(kind,file_name) VALUES ($1,$2) RETURNING id', [type, fileName]); const loadId = log.rows[0].id; let n = 0, skipped = 0;
  if (type === 'company_lfl') {
    for (const r of rows) { const wk = toIso(r.week_ending), v = Number(String(r.lfl_pct).replace('%', '')); if (!dateOk(wk) || r.lfl_pct === '' || !Number.isFinite(v)) { skipped++; continue; }
      await c.query(`INSERT INTO company_weekly(week_ending,scope,lfl_pct,source,load_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (week_ending,scope) DO UPDATE SET lfl_pct=EXCLUDED.lfl_pct, source=EXCLUDED.source, load_id=EXCLUDED.load_id`,
        [wk, (r.scope || 'All').trim() || 'All', v, (r.source || fileName || 'Power BI').slice(0, 160), loadId]); n++; }
  } else if (type === 'store_agreements') {
    const d = x => { x = toIso(x); return dateOk(x) ? x : null; }, t = x => (x || '').trim() || null;
    for (const r of rows) { const m = await matchStore(c, r.site_name, r.brand); if (!m.id) { skipped++; continue; }
      await c.query(`UPDATE stores SET abn=COALESCE($2,abn), royalty_rate=COALESCE($3,royalty_rate), fa_start=COALESCE($4,fa_start), fa_end=COALESCE($5,fa_end), fa_options=COALESCE($6,fa_options), lease_start=COALESCE($7,lease_start), lease_end=COALESCE($8,lease_end), lease_options=COALESCE($9,lease_options), landlord=COALESCE($10,landlord), site_size=COALESCE($11,site_size), annual_rent=COALESCE($12,annual_rent), property_agent=COALESCE($13,property_agent) WHERE id=$1`,
        [m.id, t(r.abn), r.royalty_rate === '' || r.royalty_rate == null ? null : Number(r.royalty_rate), d(r.fa_start), d(r.fa_end), t(r.fa_options), d(r.lease_start), d(r.lease_end), t(r.lease_options), t(r.landlord), t(r.site_size), t(r.annual_rent), t(r.property_agent)]); n++; }
  } else if (type === 'store_state') {
    for (const r of rows) { const st = (r.state || '').toUpperCase().trim(); const m = await matchStore(c, r.store || r.restaurant, r.brand); if (!m.id || !st) { skipped++; continue; }
      await c.query('UPDATE stores SET state=$2 WHERE id=$1', [m.id, st]); n++; }
  } else if (type === 'store_details') {
    for (const r of rows) { const m = await matchStore(c, r.store || r.site_name, r.store ? undefined : r.brand); if (!m.id) { skipped++; continue; }
      await c.query(`UPDATE stores SET state=COALESCE(NULLIF($2,''),state), address=COALESCE(NULLIF($3,''),address), phone=COALESCE(NULLIF($4,''),phone), trading_company=COALESCE(NULLIF($5,''),trading_company), bdm=COALESCE(NULLIF($6,''),bdm), lat=CASE WHEN NULLIF($3,'') IS NOT NULL AND address IS DISTINCT FROM NULLIF($3,'') AND COALESCE(geo_source,'')<>'manual' THEN NULL ELSE lat END, lng=CASE WHEN NULLIF($3,'') IS NOT NULL AND address IS DISTINCT FROM NULLIF($3,'') AND COALESCE(geo_source,'')<>'manual' THEN NULL ELSE lng END, geo_source=CASE WHEN NULLIF($3,'') IS NOT NULL AND address IS DISTINCT FROM NULLIF($3,'') AND COALESCE(geo_source,'')<>'manual' THEN NULL ELSE geo_source END, sharepoint_name=COALESCE(NULLIF($7,''),sharepoint_name) WHERE id=$1`,
        [m.id, (r.state || '').toUpperCase().trim(), r.address, r.phone, r.trading_company, r.bdm, r.site_name]); n++; }
  } else if (type === 'opening_dates') {
    for (const r of rows) { const d = toIso(r.opening_date); if (!dateOk(d)) { skipped++; continue; } const m = await matchStore(c, r.store, r.brand); if (!m.id) { skipped++; continue; }
      await c.query(`UPDATE stores SET opening_date=$2, opening_date_source=$3, opening_date_confidence=$4 WHERE id=$1`, [m.id, d, 'Manual upload: ' + (r.source || fileName), r.confidence || 'high']); n++; }
  } else if (type === 'network_events') {
    const sources = [...new Set(rows.map(r => 'Upload: ' + (r.sheet || fileName)))];
    await c.query('DELETE FROM network_events WHERE source = ANY($1)', [sources]);   // re-uploading a file replaces its earlier events
    for (const r of rows) { if (!r.event_type || !r.restaurant) { skipped++; continue; } const m = await matchStore(c, r.restaurant, r.brand);
      await c.query(`INSERT INTO network_events(source,brand,restaurant,state,event_type,event_date,date_meaning,note,store_id) VALUES ($1,$2,$3,NULLIF($4,''),$5,NULLIF($6,''),$7,NULLIF($8,''),$9)`,
        ['Upload: ' + (r.sheet || fileName), r.brand, r.restaurant, r.state, r.event_type, toIso(r.date || r.event_date), r.date_meaning || '', r.status_or_note || r.note, m.id || null]); n++; }
  } else if (type === 'new_stores') {
    for (const r of rows) { if (!r.store || !r.brand) { skipped++; continue; }
      const ins = await c.query(`INSERT INTO stores(name,brand,division) VALUES ($1,$2,NULLIF($3,'')) ON CONFLICT (name) DO NOTHING RETURNING id`, [r.store.trim(), BRAND_CANON(r.brand), r.division]);
      if (ins.rowCount) { await rebuildAliases(c, ins.rows[0].id); n++; } else skipped++; }
  } else throw new Error('Unknown dataset type');
  if (type === 'store_state' || type === 'store_details') await propagateState(c);
  await c.query('UPDATE load_log SET rows_inserted=$2, note=$3 WHERE id=$1', [loadId, n, skipped ? `${skipped} rows skipped` : null]);
  return { loadId, applied: n, skipped };
}

// ---- item sales by store: a file replaces the same brand + period ----
async function itemSalesPlan(c, rows) {
  const stores = new Map(), problems = []; const out = []; const periods = new Set(), brands = new Set();
  for (const r of rows) {
    const name = String(r.store || '').trim(), item = String(r.item_name || '').trim(), sales = Number(String(r.sales).replace(/[$,]/g, ''));
    const ps = toIso(r.period_start), pe = toIso(r.period_end), brand = BRAND_CANON(r.brand || '');
    if (!name || !item || !isFinite(sales) || String(r.sales).trim() === '') { if (problems.length < 20) problems.push(`bad row: ${name || '?'} / ${item || '?'} / ${r.sales}`); continue; }
    if (!dateOk(ps) || !dateOk(pe)) { if (problems.length < 20) problems.push(`${name}: bad period "${r.period_start}" to "${r.period_end}"`); continue; }
    if (!brand) { if (problems.length < 20) problems.push(`${name}: no brand`); continue; }
    const k = brand + '|' + name; if (!stores.has(k)) stores.set(k, await matchStore(c, name, brand));
    periods.add(brand + ' ' + ps + ' to ' + pe); brands.add(brand);
    out.push({ brand, name, item, ps, pe, sales, m: stores.get(k) });
  }
  return { out, stores, problems, periods: [...periods], brands: [...brands] };
}
async function analyseItemSales(c, rows) {
  const p = await itemSalesPlan(c, rows); const unmatched = [], ambiguous = [];
  for (const [k, m] of p.stores) { if (m.id) continue; const label = k.split('|')[1]; if (m.ambiguous) ambiguous.push(`${label} → ${m.ambiguous.join(' / ')}`); else unmatched.push(label); }
  const total = p.out.reduce((a, r) => a + r.sales, 0);
  return { type: 'item_sales_store', rows: rows.length, valid_rows: p.out.length, stores: p.stores.size, matched: [...p.stores.values()].filter(m => m.id).length, unmatched, ambiguous, problems: p.problems, periods: p.periods, items: new Set(p.out.map(r => r.item)).size, total_sales: Math.round(total * 100) / 100, note: 'Loading replaces any earlier item sales for the same brand and period. Stores that are not matched are still stored (by name) but cannot be linked to a store profile.' };
}
async function commitItemSales(c, rows, fileName) {
  const p = await itemSalesPlan(c, rows); if (!p.out.length) throw new Error('No valid rows found in the file');
  const log = await c.query('INSERT INTO load_log(kind,file_name) VALUES ($1,$2) RETURNING id', ['item_sales_store', fileName]); const loadId = log.rows[0].id;
  for (const k of new Set(p.out.map(r => r.brand + '|' + r.ps + '|' + r.pe))) { const [b, s, e] = k.split('|'); await c.query('DELETE FROM item_sales WHERE brand=$1 AND period_start=$2 AND period_end=$3', [b, s, e]); }
  const CH = 1000; for (let i = 0; i < p.out.length; i += CH) {
    const part = p.out.slice(i, i + CH); const vals = [], ph = [];
    part.forEach((r, j) => { const o = j * 8; ph.push(`($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8})`); vals.push(r.m.id || null, r.name, r.brand, r.item, r.ps, r.pe, r.sales, loadId); });
    await c.query(`INSERT INTO item_sales(store_id,store_name,brand,item_name,period_start,period_end,sales,load_id) VALUES ${ph.join(',')}`, vals); }
  const unlinked = [...p.stores.values()].filter(m => !m.id).length;
  await c.query('UPDATE load_log SET rows_inserted=$2, note=$3 WHERE id=$1', [loadId, p.out.length, unlinked ? unlinked + ' stores not linked to a store profile' : null]);
  return { loadId, applied: p.out.length, skipped: rows.length - p.out.length, unlinked_stores: unlinked };
}

// ---- organisation chart: the file replaces the whole chart ----
function orgPlan(rows) {
  const problems = []; const clean = v => String(v ?? '').trim();
  const list = rows.map((r, i) => { const name = clean(r.name); const kindIn = clean(r.kind).toLowerCase();
    return { i, ext: clean(r.person_id), name, position: clean(r.position), department: clean(r.department), team: clean(r.team_or_section || r.team), kind: ['person', 'vacant', 'group'].includes(kindIn) ? kindIn : (/^vacant$/i.test(name) ? 'vacant' : 'person'),
      chart_group: clean(r.chart_group), status_flag: clean(r.status_flag), region: clean(r.region), notes: clean(r.notes), basis: clean(r.reports_to_basis), parent: null }; });
  const ok = list.filter(p => { if (!p.name) { problems.push(`row ${p.i + 2}: no name`); return false; } return true; });
  const byExt = new Map(), byName = new Map();
  for (const p of ok) { if (p.ext) { if (byExt.has(p.ext)) problems.push(`person_id ${p.ext} used twice`); byExt.set(p.ext, p); } if (p.kind !== 'vacant') { const k = p.name.toLowerCase(); byName.set(k, [...(byName.get(k) || []), p]); } }
  for (const p of ok) {
    const r = rows[p.i]; const rid = clean(r.reports_to_id), rn = clean(r.reports_to); const who = `${p.name}${p.kind === 'vacant' ? ' (' + p.position + ')' : ''}`;
    if (rid) { p.parent = byExt.get(rid) || null; if (!p.parent) problems.push(`${who}: reports_to_id ${rid} is not in the file`); }
    else if (rn) { const m = byName.get(rn.toLowerCase()); if (m && m.length === 1) p.parent = m[0]; else problems.push(`${who}: cannot tell who "${rn}" is (${m ? 'more than one person has that name' : 'not in the file'}); add a reports_to_id column`); }
  }
  let loop = false; for (const p of ok) { let q = p, n = 0; while (q.parent && n++ < 500) q = q.parent; if (n >= 500) { loop = true; problems.push(`${p.name}: the reporting lines go round in a circle`); break; } }
  return { list: ok, problems, loop };
}
async function commitOrg(c, rows, fileName) {
  const plan = orgPlan(rows); if (plan.loop) throw new Error('The reporting lines go round in a circle: ' + plan.problems.filter(x => /circle/.test(x)).join('; '));
  if (!plan.list.length) throw new Error('No people found in the file');
  const log = await c.query('INSERT INTO load_log(kind,file_name) VALUES ($1,$2) RETURNING id', ['org_chart', fileName]);
  await c.query('DELETE FROM people');
  for (const p of plan.list) p.id = (await c.query(`INSERT INTO people(name,position,department,team,kind,chart_group,status_flag,region,notes,reports_to_basis) VALUES ($1,NULLIF($2,''),NULLIF($3,''),NULLIF($4,''),$5,NULLIF($6,''),NULLIF($7,''),NULLIF($8,''),NULLIF($9,''),NULLIF($10,'')) RETURNING id`,
    [p.name, p.position, p.department, p.team, p.kind, p.chart_group, p.status_flag, p.region, p.notes, p.basis])).rows[0].id;
  for (const p of plan.list) if (p.parent) await c.query('UPDATE people SET parent_id=$2 WHERE id=$1', [p.id, p.parent.id]);
  await c.query('UPDATE load_log SET rows_inserted=$2, note=$3 WHERE id=$1', [log.rows[0].id, plan.list.length, plan.problems.length ? plan.problems.length + ' reporting lines could not be resolved' : null]);
  return { loadId: log.rows[0].id, applied: plan.list.length, skipped: rows.length - plan.list.length, unresolved: plan.problems.length };
}
function parseBudget(text) {
  let j; try { j = JSON.parse(text); } catch (e) { throw new Error('Budget file is not valid JSON: ' + e.message); }
  if (!j || j.budget !== true || !j.fy || !j.version || !Array.isArray(j.lines)) throw new Error('Budget file needs budget:true, fy, version and lines');
  const problems = []; const lines = [];
  j.lines.forEach((l, i) => { const v = Number(l.value); if (!l.section || !l.line || !l.period || !Number.isFinite(v)) { problems.push(`line ${i + 1}: needs section, line, period and a numeric value`); return; } lines.push({ section: String(l.section), brand: String(l.brand || ''), line: String(l.line), period: String(l.period), value: v, unit: String(l.unit || 'AUD') }); });
  const notes = (Array.isArray(j.notes) ? j.notes : []).filter(n => n.topic && n.note).map(n => ({ topic: String(n.topic), note: String(n.note) }));
  return { fy: String(j.fy), version: String(j.version), lines, notes, problems };
}
function analyseBudget(text) {
  const b = parseBudget(text); const sections = {}; for (const l of b.lines) sections[l.section] = (sections[l.section] || 0) + 1;
  return { type: 'budget', rows: b.lines.length, fy: b.fy, version: b.version, sections, notes: b.notes.length, problems: b.problems, note: 'Loading replaces any earlier budget for the same year. Budget figures are board-level numbers: visible to signed-in directors only.' };
}
async function commitBudget(c, text, fileName) {
  const b = parseBudget(text); if (!b.lines.length) throw new Error('No budget lines found');
  const log = await c.query('INSERT INTO load_log(kind,file_name) VALUES ($1,$2) RETURNING id', ['budget', fileName]); const loadId = log.rows[0].id;
  await c.query('DELETE FROM budget_lines WHERE fy=$1', [b.fy]); await c.query('DELETE FROM budget_notes WHERE fy=$1', [b.fy]);
  for (let i = 0; i < b.lines.length; i += 200) { const ch = b.lines.slice(i, i + 200); const vals = [], ph = [];
    ch.forEach((l, k) => { const o = k * 9; ph.push(`($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9})`); vals.push(b.fy, b.version, l.section, l.brand, l.line, l.period, l.value, l.unit, loadId); });
    await c.query(`INSERT INTO budget_lines(fy,version,section,brand,line,period,value,unit,load_id) VALUES ${ph.join(',')}`, vals); }
  for (const n of b.notes) await c.query('INSERT INTO budget_notes(fy,version,topic,note,load_id) VALUES ($1,$2,$3,$4,$5)', [b.fy, b.version, n.topic, n.note, loadId]);
  await c.query('UPDATE load_log SET rows_inserted=$2 WHERE id=$1', [loadId, b.lines.length]).catch(() => {});
  return { loadId, applied: b.lines.length, notes: b.notes.length, note: `Budget ${b.fy} (${b.version}) loaded: ${b.lines.length} figures, ${b.notes.length} assumption notes.` };
}

// ---- Network Tracker pipeline (JSON made by scripts/make-pipeline-json.py) ----
function parsePipeline(text) {
  let j; try { j = JSON.parse(text); } catch (e) { throw new Error('Pipeline file is not valid JSON: ' + e.message); }
  if (!j || j.pipeline !== true || !Array.isArray(j.projects)) throw new Error('Pipeline file needs pipeline:true and projects');
  const d = x => { x = toIso(x); return dateOk(x) ? x : null; }; const t = x => (x == null || String(x).trim() === '' ? null : String(x).trim());
  const n = x => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
  const projects = j.projects.filter(p => p.restaurant && p.kind).map(p => ({ tab: t(p.tab), kind: p.kind, restaurant: String(p.restaurant).trim(), brand: t(p.brand) && BRAND_CANON(p.brand), state: t(p.state), gsm: t(p.gsm), partner: t(p.partner),
    status: t(p.status), at_risk: t(p.at_risk), target_date: d(p.target_date), actual_date: d(p.actual_date), delayed_days: n(p.delayed_days) == null ? null : Math.round(n(p.delayed_days)), delay_reason: t(p.delay_reason),
    budgeted_date: d(p.budgeted_date), est_weekly_sales: n(p.est_weekly_sales), lost_revenue: n(p.lost_revenue), fa_expiry: d(p.fa_expiry), lease_expiry: d(p.lease_expiry),
    steps: (Array.isArray(p.steps) ? p.steps : []).filter(s => s.step && t(s.value) !== null).map(s => ({ phase: t(s.phase), step: String(s.step), value: String(s.value) })) }));
  const activity = (Array.isArray(j.activity) ? j.activity : []).filter(a => a.restaurant && a.type).map(a => ({ brand: t(a.brand) && BRAND_CANON(a.brand), restaurant: String(a.restaurant).trim(), state: t(a.state), type: String(a.type), date: d(a.date), partner: t(a.franchise_partner), incentive: t(a.incentive), description: t(a.description), lead: t(a.lead_source) }));
  const leases = (Array.isArray(j.leases) ? j.leases : []).filter(l => l.site).map(l => ({ site: String(l.site).trim(), term: n(l.term_years), commencement: d(l.commencement), expiry: d(l.expiry), guarantee: n(l.bank_guarantee), landlord: t(l.landlord), tenant: t(l.tenant), guarantor: t(l.guarantor), licence: t(l.occupancy_licence), further: t(l.further_term) }));
  return { as_of: d(j.as_of), source: t(j.source), projects, activity, leases };
}
// spelling differences between the tracker and the sales-report store names
const PIPE_NAMES = { 'adelaide hospital': 'Royal Adelaide Hospital', 'north ringwood': 'Ringwood North', 'braken ridge': 'Bracken Ridge', 'gillies plains': 'Gilles Plains', 'sailsbury': 'Salisbury', 'uwa': 'University WA', 'benowa': 'Benowa Village', 'brassal': 'Brassall', 'berinnba': 'Berrinba' };
async function analysePipeline(c, text) {
  const b = parsePipeline(text); const out = { type: 'pipeline', as_of: b.as_of, projects: b.projects.length, steps: b.projects.reduce((a, p) => a + p.steps.length, 0), activity: b.activity.length, leases: b.leases.length, kinds: {}, matched: 0, unmatched: [], ambiguous: [], problems: [] };
  for (const p of b.projects) out.kinds[p.kind] = (out.kinds[p.kind] || 0) + 1;
  const seen = new Set();
  for (const p of b.projects) { const k = p.restaurant + '|' + p.brand; if (seen.has(k)) continue; seen.add(k); const m = await matchStore(c, PIPE_NAMES[norm(p.restaurant)] || p.restaurant, p.brand); if (m.id) out.matched++; else if (m.ambiguous) out.ambiguous.push(`${p.restaurant} → ${m.ambiguous.join(' / ')}`); else out.unmatched.push(`${p.restaurant} (${p.brand || '?'})`); }
  out.sites = seen.size; out.unmatched = [...new Set(out.unmatched)];
  out.latest_entry = b.as_of; out.note = 'Loading replaces the whole pipeline (all tracker tabs, the activity log and the lease list). Sites not in the stores list (new sites, closed stores) are kept, just not linked to a store. Visible to signed-in directors only.';
  return out;
}
async function commitPipeline(c, text, fileName) {
  const b = parsePipeline(text); if (!b.projects.length) throw new Error('No pipeline rows found');
  const log = await c.query('INSERT INTO load_log(kind,file_name) VALUES ($1,$2) RETURNING id', ['pipeline', fileName]); const loadId = log.rows[0].id;
  await c.query('DELETE FROM pipeline_projects'); await c.query('DELETE FROM pipeline_activity'); await c.query('DELETE FROM lease_liability');
  const link = async (name, brand) => { const m = await matchStore(c, PIPE_NAMES[norm(name)] || name, brand); return m.id || null; };
  let steps = 0;
  for (const p of b.projects) {
    const id = (await c.query(`INSERT INTO pipeline_projects(tab,kind,restaurant,brand,state,gsm,partner,status,at_risk,target_date,actual_date,delayed_days,delay_reason,budgeted_date,est_weekly_sales,lost_revenue,fa_expiry,lease_expiry,store_id,as_of,load_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING id`,
      [p.tab, p.kind, p.restaurant, p.brand, p.state, p.gsm, p.partner, p.status, p.at_risk, p.target_date, p.actual_date, p.delayed_days, p.delay_reason, p.budgeted_date, p.est_weekly_sales, p.lost_revenue, p.fa_expiry, p.lease_expiry, await link(p.restaurant, p.brand), b.as_of, loadId])).rows[0].id;
    for (let i = 0; i < p.steps.length; i++) { await c.query('INSERT INTO pipeline_steps(project_id,seq,phase,step,value) VALUES ($1,$2,$3,$4,$5)', [id, i, p.steps[i].phase, p.steps[i].step, p.steps[i].value]); steps++; }
  }
  for (const a of b.activity) await c.query('INSERT INTO pipeline_activity(brand,restaurant,state,type,action_date,franchise_partner,incentive,description,lead_source,store_id,load_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [a.brand, a.restaurant, a.state, a.type, a.date, a.partner, a.incentive, a.description, a.lead, await link(a.restaurant, a.brand), loadId]);
  for (const l of b.leases) await c.query('INSERT INTO lease_liability(site,term_years,commencement,expiry,bank_guarantee,landlord,tenant,guarantor,occupancy_licence,further_term,store_id,load_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [l.site, l.term, l.commencement, l.expiry, l.guarantee, l.landlord, l.tenant, l.guarantor, l.licence, l.further, await link(l.site, null), loadId]);
  await c.query('UPDATE load_log SET rows_inserted=$2 WHERE id=$1', [loadId, b.projects.length + b.activity.length + b.leases.length]).catch(() => {});
  return { loadId, applied: b.projects.length, steps, activity: b.activity.length, leases: b.leases.length, note: `Pipeline loaded: ${b.projects.length} sites, ${steps} stage entries, ${b.activity.length} activity rows, ${b.leases.length} leases.` };
}
module.exports = { detect, analyse, commit, rebuildAliases, matchStore, TYPES, BRAND_CANON, BRAND_WORDS, norm };
