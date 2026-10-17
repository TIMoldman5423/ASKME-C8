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
  opening_dates: { label: 'Opening dates (store, brand, opening_date, source)' },
  network_events: { label: 'Network events (brand, restaurant, event_type, date …)' },
  new_stores: { label: 'New stores (store, brand, division)' },
};
function detect(text) {
  const first = text.split(/\r?\n/, 1)[0].toLowerCase();
  if (/w\/e\s*\d{2}\/\d{2}\/\d{4}/.test(first)) return 'weekly_sales';
  if (/site_name/.test(first) && /address|trading_company|state|bdm/.test(first)) return 'store_details';
  if (/event_type/.test(first)) return 'network_events';
  if (/opening_date/.test(first)) return 'opening_dates';
  if (/^"?store"?\s*,/.test(first) || /(^|,)store(,|$)/.test(first)) return /division|brand/.test(first) ? 'new_stores' : null;
  return null;
}

async function analyse(c, type, text) {
  if (type === 'weekly_sales') return { type, ...(await W.analyse(c, W.parseWide(text))) };
  const rows = rowsOf(text); const out = { type, rows: rows.length, matched: 0, unmatched: [], ambiguous: [], problems: [], sample: [] };
  if (type === 'store_details') {
    for (const r of rows) { const m = await matchStore(c, r.store || r.site_name, r.store ? undefined : r.brand); tally(out, m, r.site_name || r.store); }
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

async function commit(c, type, text, fileName) {
  if (type === 'weekly_sales') return W.commit(c, W.parseWide(text), fileName);
  const rows = rowsOf(text);
  const log = await c.query('INSERT INTO load_log(kind,file_name) VALUES ($1,$2) RETURNING id', [type, fileName]); const loadId = log.rows[0].id; let n = 0, skipped = 0;
  if (type === 'store_details') {
    for (const r of rows) { const m = await matchStore(c, r.store || r.site_name, r.store ? undefined : r.brand); if (!m.id) { skipped++; continue; }
      await c.query(`UPDATE stores SET state=COALESCE(NULLIF($2,''),state), address=COALESCE(NULLIF($3,''),address), phone=COALESCE(NULLIF($4,''),phone), trading_company=COALESCE(NULLIF($5,''),trading_company), bdm=COALESCE(NULLIF($6,''),bdm), sharepoint_name=COALESCE(NULLIF($7,''),sharepoint_name) WHERE id=$1`,
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
  await c.query('UPDATE load_log SET rows_inserted=$2, note=$3 WHERE id=$1', [loadId, n, skipped ? `${skipped} rows skipped` : null]);
  return { loadId, applied: n, skipped };
}
module.exports = { detect, analyse, commit, rebuildAliases, matchStore, TYPES, BRAND_CANON, BRAND_WORDS, norm };
