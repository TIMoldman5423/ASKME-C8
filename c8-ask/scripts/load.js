// One-off / initial load from the CSVs in data/. Safe to re-run (upserts).
const fs = require('fs'), path = require('path'); const { parse } = require('csv-parse/sync');
const { pool } = require('../db'); const W = require('../lib-weekly'); const { rebuildAliases } = require('../lib-data');
const D = f => path.join(__dirname, '..', 'data', f);
const rd = f => parse(fs.readFileSync(D(f), 'utf8'), { columns: true, skip_empty_lines: true });
const key = s => s.toLowerCase().replace(/\(.*?\)/g, '').replace(/\b(nbx|ab|ps|hux|ss)\b/g, '').replace(/[^a-z]/g, '');

(async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // 1. stores master + weekly sales
    for (const s of rd('stores_master.csv')) {
      await c.query(`INSERT INTO stores(name,brand,division,state,address,phone,trading_company,bdm,sharepoint_name,opening_date,opening_date_source,opening_date_confidence)
        VALUES ($1,$2,$3,NULLIF($4,''),NULLIF($5,''),NULLIF($6,''),NULLIF($7,''),NULLIF($8,''),NULLIF($9,''),NULLIF($10,'')::date,NULLIF($11,''),NULLIF($12,''))
        ON CONFLICT (name) DO UPDATE SET brand=EXCLUDED.brand, division=EXCLUDED.division, state=EXCLUDED.state, address=EXCLUDED.address, phone=EXCLUDED.phone,
          trading_company=EXCLUDED.trading_company, bdm=EXCLUDED.bdm, sharepoint_name=EXCLUDED.sharepoint_name, opening_date=EXCLUDED.opening_date,
          opening_date_source=EXCLUDED.opening_date_source, opening_date_confidence=EXCLUDED.opening_date_confidence`,
        [s.store, s.brand, s.division, s.state, s.address, s.phone, s.trading_company, s.bdm, s.sharepoint_name, s.opening_date, s.opening_date_source, s.opening_date_confidence]);
    }
    const text = fs.readFileSync(D('c8_store_weekly_sales_13wk_plus_lw_orders_atv.csv'), 'utf8');
    const res = await W.commit(c, W.parseWide(text), 'c8_store_weekly_sales_13wk_plus_lw_orders_atv.csv', 'initial');
    console.log('weekly:', res);

    // 2. aliases (auto ones are rebuilt; manual ones are kept)
    const stores = (await c.query('SELECT id,name,brand FROM stores')).rows;
    for (const s of stores) await rebuildAliases(c, s.id);

    // 3. network events + link to stores by brand+name
    await c.query('DELETE FROM network_events');
    const bcanon = b => { b = (b || '').toLowerCase(); if (/noodle|nbx/.test(b)) return 'Noodle Box'; if (/patty/.test(b)) return 'Pattysmiths'; if (/hux/.test(b)) return 'Huxtaburger'; if (/acai/.test(b)) return 'Acai Bros'; if (/seoul/.test(b)) return 'South Seoul'; if (/wok|wiab/.test(b)) return 'Wok In A Box - OTR'; return b; };
    const link = (brand, name) => { const k = key(name.replace(/^OTR\s*/i, 'otr')); const cb = bcanon(brand); const m = stores.filter(s => s.brand === cb && (key(s.name.replace(/^OTR_/, 'otr')) === k || key(s.name) === k)); return m.length === 1 ? m[0].id : null; };
    let n = 0;
    for (const e of rd('c8_network_events_2025_26.csv')) { await c.query('INSERT INTO network_events(source,brand,restaurant,state,event_type,event_date,date_meaning,note,store_id) VALUES ($1,$2,$3,NULLIF($4,\'\'),$5,NULLIF($6,\'\'),$7,NULLIF($8,\'\'),$9)', ['Network Tracker: ' + e.sheet, e.brand, e.restaurant, e.state, e.event_type, e.date, e.date_meaning, e.status_or_note, link(e.brand, e.restaurant)]); n++; }
    for (const e of rd('c8_network_pipeline_and_renewals.csv')) { await c.query('INSERT INTO network_events(source,brand,restaurant,state,event_type,event_date,date_meaning,note,store_id) VALUES ($1,$2,$3,NULLIF($4,\'\'),$5,NULLIF($6,\'\'),$7,NULLIF($8,\'\'),$9)', ['Network Tracker: ' + e.sheet, e.brand, e.restaurant, e.state, e.item, e.date, 'see event type', e.note, e.brand ? link(e.brand, e.restaurant) : null]); n++; }
    console.log('network events:', n);

    // 4. organisation chart (replaces whatever is there)
    if (fs.existsSync(D('org_chart.csv'))) console.log('org chart:', await require('../lib-data').commit(c, 'org_chart', fs.readFileSync(D('org_chart.csv'), 'utf8'), 'org_chart.csv'));
    await c.query('COMMIT');
    const cnt = await pool.query('SELECT (SELECT count(*) FROM stores) stores,(SELECT count(*) FROM weekly_sales) weekly_rows,(SELECT count(*) FROM store_aliases) aliases,(SELECT count(*) FROM network_events WHERE store_id IS NOT NULL) linked_events');
    console.log(cnt.rows[0]);
  } catch (e) { await c.query('ROLLBACK'); console.error(e); process.exit(1); } finally { c.release(); await pool.end(); }
})();
