// Parses the wide weekly CSV (division,brand,store,"w/e dd/mm/yyyy"..., optional "orders w/e dd/mm/yyyy","ATV w/e dd/mm/yyyy", TOTAL row)
// and writes it to the database. Used by both scripts/load.js and the /admin upload page.
const { parse } = require('csv-parse/sync');
const iso = s => { const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(s); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };

function parseWide(text) {
  const rows = parse(text, { skip_empty_lines: true, relax_column_count: true });
  const hdr = rows[0].map(h => h.trim());
  const cols = { sales: {}, orders: {}, atv: {} };
  hdr.forEach((h, i) => {
    const d = iso(h); if (!d) return;
    if (/^w\/e/i.test(h)) cols.sales[i] = d; else if (/^orders/i.test(h)) cols.orders[i] = d; else if (/^atv/i.test(h)) cols.atv[i] = d;
  });
  if (!Object.keys(cols.sales).length) throw new Error('No "w/e dd/mm/yyyy" columns found in header');
  const num = v => (v === undefined || v === '' ? null : Number(String(v).replace(/[$,]/g, '')));
  const stores = [], total = {};
  for (const r of rows.slice(1)) {
    if (/^total/i.test(r[0])) { for (const [i, d] of Object.entries(cols.sales)) total[d] = num(r[i]); for (const [i, d] of Object.entries(cols.orders)) total['o' + d] = num(r[i]); continue; }
    const rec = { division: r[0], brand: r[1], store: r[2], sales: {}, orders: {}, atv: {} };
    for (const [i, d] of Object.entries(cols.sales)) rec.sales[d] = num(r[i]);
    for (const [i, d] of Object.entries(cols.orders)) rec.orders[d] = num(r[i]);
    for (const [i, d] of Object.entries(cols.atv)) rec.atv[d] = num(r[i]);
    stores.push(rec);
  }
  return { stores, total, weeks: Object.values(cols.sales) };
}

// dry-run analysis against the DB: what would change?
async function analyse(client, parsed) {
  const ex = await client.query('SELECT id,name FROM stores'); const byName = new Map(ex.rows.map(r => [r.name, r.id]));
  const unknown = parsed.stores.filter(s => !byName.has(s.store)).map(s => s.store);
  const cur = await client.query('SELECT s.name, w.week_ending::text d, w.sales FROM weekly_sales w JOIN stores s ON s.id=w.store_id WHERE w.week_ending = ANY($1::date[])', [parsed.weeks]);
  const curMap = new Map(cur.rows.map(r => [r.name + '|' + r.d, Number(r.sales)]));
  let newCells = 0, same = 0; const changed = [];
  for (const s of parsed.stores) for (const [d, v] of Object.entries(s.sales)) {
    if (v === null) continue; const k = s.store + '|' + d;
    if (!curMap.has(k)) newCells++; else if (Math.abs(curMap.get(k) - v) < 0.5) same++; else changed.push({ store: s.store, week: d, old: curMap.get(k), new: v });
  }
  const sums = {}; for (const d of parsed.weeks) sums[d] = parsed.stores.reduce((a, s) => a + (s.sales[d] || 0), 0);
  const checks = parsed.weeks.map(d => ({ week: d, sum_of_stores: Math.round(sums[d]), report_total: parsed.total[d] ?? null, diff: parsed.total[d] != null ? Math.round(sums[d] - parsed.total[d]) : null }));
  return { stores: parsed.stores.length, weeks: parsed.weeks, unknown_stores: unknown, new_cells: newCells, unchanged_cells: same, changed_cells: changed.slice(0, 50), changed_count: changed.length, checks };
}

async function commit(client, parsed, fileName, kind = 'weekly') {
  const log = await client.query('INSERT INTO load_log(kind,file_name) VALUES ($1,$2) RETURNING id', [kind, fileName]);
  const loadId = log.rows[0].id; let ins = 0, chg = 0;
  for (const s of parsed.stores) {
    let r = await client.query('SELECT id FROM stores WHERE name=$1', [s.store]);
    if (!r.rowCount) r = await client.query('INSERT INTO stores(name,brand,division) VALUES ($1,$2,$3) RETURNING id', [s.store, s.brand, s.division]);
    const id = r.rows[0].id;
    const dates = new Set([...Object.keys(s.sales), ...Object.keys(s.orders), ...Object.keys(s.atv)]);
    for (const d of dates) {
      const sales = s.sales[d] ?? null, orders = s.orders[d] ?? null, atv = s.atv[d] ?? null;
      if (sales === null && orders === null) continue;
      const old = await client.query('SELECT sales FROM weekly_sales WHERE store_id=$1 AND week_ending=$2', [id, d]);
      if (old.rowCount) {
        if (sales !== null && old.rows[0].sales !== null && Math.abs(Number(old.rows[0].sales) - sales) >= 0.5) {
          await client.query('INSERT INTO weekly_sales_history(store_id,week_ending,old_sales,new_sales,load_id) VALUES ($1,$2,$3,$4,$5)', [id, d, old.rows[0].sales, sales, loadId]); chg++;
        }
        await client.query('UPDATE weekly_sales SET sales=COALESCE($3,sales), orders=COALESCE($4,orders), atv=COALESCE($5,atv), load_id=$6 WHERE store_id=$1 AND week_ending=$2', [id, d, sales, orders, atv, loadId]);
      } else { await client.query('INSERT INTO weekly_sales(store_id,week_ending,sales,orders,atv,load_id) VALUES ($1,$2,$3,$4,$5,$6)', [id, d, sales, orders, atv, loadId]); ins++; }
    }
  }
  for (const d of parsed.weeks) if (parsed.total[d] != null)
    await client.query('INSERT INTO weekly_totals(week_ending,report_total,report_orders,load_id) VALUES ($1,$2,$3,$4) ON CONFLICT (week_ending) DO UPDATE SET report_total=EXCLUDED.report_total, report_orders=COALESCE(EXCLUDED.report_orders,weekly_totals.report_orders), load_id=EXCLUDED.load_id', [d, parsed.total[d], parsed.total['o' + d] ?? null, loadId]);
  for (const k of Object.keys(parsed.total)) if (k.startsWith('o') && parsed.total[k] != null) {
    const d = k.slice(1); await client.query('INSERT INTO weekly_totals(week_ending,report_orders,load_id) VALUES ($1,$2,$3) ON CONFLICT (week_ending) DO UPDATE SET report_orders=EXCLUDED.report_orders', [d, parsed.total[k], loadId]);
  }
  await client.query('UPDATE load_log SET rows_inserted=$2, rows_changed=$3 WHERE id=$1', [loadId, ins, chg]);
  return { loadId, inserted: ins, restated: chg };
}
module.exports = { parseWide, analyse, commit };
