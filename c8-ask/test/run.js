// Integration tests against a real Postgres (DATABASE_URL). Run after init-db + load. Uses the mocked Anthropic client.
process.env.ANTHROPIC_MOCK = '1'; process.env.SESSION_SECRET ||= 'test-secret-test-secret-test-secret'; process.env.APP_PASSWORD = 'userpw'; process.env.ADMIN_PASSWORD = 'adminpw';
const assert = require('assert'); const http = require('http'); const app = require('../server'); const { pool } = require('../db'); const fs = require('fs'), path = require('path');
const srv = http.createServer(app).listen(0); const base = `http://127.0.0.1:${srv.address().port}`;
const call = async (p, o = {}) => { const r = await fetch(base + p, o); let j; try { j = await r.json(); } catch {} return { status: r.status, body: j, headers: r.headers }; };
let pass = 0; const t = async (n, f) => { try { await f(); pass++; console.log('ok  ', n); } catch (e) { console.log('FAIL', n, '-', e.message); process.exitCode = 1; } };
(async () => {
  let ck, adm;
  await t('stores list requires login', async () => assert.strictEqual((await call('/api/stores')).status, 401));
  await t('wrong password rejected', async () => assert.strictEqual((await call('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'nope' }) })).status, 401));
  await t('user login', async () => { const r = await call('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'userpw' }) }); assert.strictEqual(r.status, 200); ck = r.headers.get('set-cookie').split(';')[0]; });
  await t('admin login', async () => { const r = await call('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'adminpw' }) }); adm = r.headers.get('set-cookie').split(';')[0]; assert.strictEqual(r.body.role, 'admin'); });
  await t('tampered cookie rejected', async () => assert.strictEqual((await call('/api/stores', { headers: { cookie: ck.slice(0, -3) + 'xxx' } })).status, 401));
  await t('stores grouped by brand, 168 total', async () => { const r = await call('/api/stores', { headers: { cookie: ck } }); assert.strictEqual(r.body.brands.length, 6); assert.strictEqual(r.body.brands.reduce((a, b) => a + b.stores.length, 0), 168); });
  await t('ask runs tool loop and answers from DB', async () => { const r = await call('/api/ask', { method: 'POST', headers: { cookie: ck, 'content-type': 'application/json' }, body: JSON.stringify({ question: 'what did hawthorn do last week' }) }); assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.body.tools, ['find_store', 'store_summary']); assert.match(r.body.answer, /\$18,194/); });
  await t('ask needs login', async () => assert.strictEqual((await call('/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"question":"x"}' })).status, 401));
  await t('user cannot use admin endpoints', async () => assert.strictEqual((await call('/api/admin/loads', { headers: { cookie: ck } })).status, 401));
  const csv = fs.readFileSync(path.join(__dirname, '..', 'data', 'c8_store_weekly_sales_13wk_plus_lw_orders_atv.csv'), 'utf8');
  await t('preview of identical file: nothing new, nothing changed, totals reconcile', async () => { const r = await call('/api/admin/preview', { method: 'POST', headers: { cookie: adm, 'content-type': 'text/csv' }, body: csv }); assert.strictEqual(r.status, 200); assert.strictEqual(r.body.new_cells, 0); assert.strictEqual(r.body.changed_count, 0); assert.ok(r.body.checks.every(c => Math.abs(c.diff) <= 5), JSON.stringify(r.body.checks)); });
  await t('restatement is detected, recorded in history, then reverted', async () => {
    const changed = csv.replace('Albany Creek,17119.41', 'Albany Creek,18000.00'); // first week of Albany Creek
    const p = await call('/api/admin/preview', { method: 'POST', headers: { cookie: adm, 'content-type': 'text/csv' }, body: changed }); assert.strictEqual(p.body.changed_count, 1);
    const c = await call('/api/admin/commit?name=test', { method: 'POST', headers: { cookie: adm, 'content-type': 'text/csv' }, body: changed }); assert.strictEqual(c.body.restated, 1);
    const h = await pool.query('SELECT old_sales::float o, new_sales::float n FROM weekly_sales_history ORDER BY id DESC LIMIT 1'); assert.deepStrictEqual(h.rows[0], { o: 17119.41, n: 18000 });
    await call('/api/admin/commit?name=revert', { method: 'POST', headers: { cookie: adm, 'content-type': 'text/csv' }, body: csv });
  });
  await t('unknown store in upload is refused', async () => { const bad = csv.replace('Albany Creek,', 'Albany Creeek,'); const r = await call('/api/admin/commit', { method: 'POST', headers: { cookie: adm, 'content-type': 'text/csv' }, body: bad }); assert.strictEqual(r.status, 400); assert.match(r.body.error, /Unknown stores/); });
  await t('new week appended (simulated)', async () => {
    const lines = csv.trim().split('\n'); const hdr = lines[0].split(',').slice(0, 16); hdr.splice(13, 0, 'w/e 18/10/2026'); // insert new week col after 11/10
    const out = [hdr.join(',')]; for (const l of lines.slice(1)) { const c = l.split(','); c.splice(13, 0, /^TOTAL/.test(l) ? '4000000' : '1000'); out.push(c.slice(0, 17).join(',')); }
    const p = await call('/api/admin/preview', { method: 'POST', headers: { cookie: adm, 'content-type': 'text/csv' }, body: out.join('\n') }); assert.ok(p.body.new_cells > 100, 'new cells ' + p.body.new_cells);
  });

  // ---- maintenance datasets ----
  const J = { cookie: adm, 'content-type': 'text/csv' }; const JJ = { cookie: adm, 'content-type': 'application/json' };
  const prev = (csv) => call('/api/admin/data/preview', { method: 'POST', headers: J, body: csv });
  const com = (csv, n = 't.csv') => call('/api/admin/data/commit?name=' + n, { method: 'POST', headers: J, body: csv });
  await t('unknown file type is refused with a helpful message', async () => { const r = await prev('foo,bar\n1,2\n'); assert.strictEqual(r.status, 400); assert.match(r.body.error, /Supported/); });
  await t('weekly file auto-detected', async () => { const r = await prev(csv); assert.strictEqual(r.body.type, 'weekly_sales'); });
  const origPhone = (await pool.query("SELECT phone FROM stores WHERE name='Hawthorn NBX'")).rows[0].phone;
  const details = 'site_name,brand,state,address,phone,trading_company,bdm\nHawthorn,Noodlebox,vic,800 Glenferrie Rd,(03) 0000 0000,Li & Co Pty Ltd,BM\nNowhereville,Noodlebox,VIC,1 Nowhere St,,,\n';
  await t('store details: matches by brand, reports unmatched, applies', async () => {
    const p = await prev(details); assert.strictEqual(p.body.type, 'store_details'); assert.strictEqual(p.body.matched, 1); assert.deepStrictEqual(p.body.unmatched, ['Nowhereville']);
    const c = await com(details); assert.strictEqual(c.body.applied, 1); assert.strictEqual(c.body.skipped, 1);
    const r = (await pool.query("SELECT phone,state FROM stores WHERE name='Hawthorn NBX'")).rows[0]; assert.deepStrictEqual(r, { phone: '(03) 0000 0000', state: 'VIC' });
  });
  await t('store details: ambiguous name without brand is flagged, not guessed', async () => { const p = await prev('site_name,state,address\nHawthorn,VIC,x\n'); assert.strictEqual(p.body.matched, 0); assert.strictEqual(p.body.ambiguous.length, 1); });
  await t('opening dates: dd/mm/yyyy accepted, bad date flagged', async () => {
    const f = 'store,brand,opening_date,source\nAltona,Noodle Box,15/03/2017,Legal file\nBallarat,Noodle Box,notadate,x\n';
    const p = await prev(f); assert.strictEqual(p.body.type, 'opening_dates'); assert.strictEqual(p.body.problems.length, 1);
    await com(f); const r = (await pool.query("SELECT opening_date::text d, opening_date_confidence c FROM stores WHERE name='Altona'")).rows[0]; assert.deepStrictEqual(r, { d: '2017-03-15', c: 'high' });
  });
  await t('network events: re-upload replaces rather than duplicates', async () => {
    const f = 'sheet,brand,restaurant,state,event_type,date,date_meaning,status_or_note\nTestSheet,Noodle Box,Altona,VIC,TestEvent,2026-11-01,actioned,hello\nTestSheet,Noodle Box,Unknown Place,,TestEvent,,no date,\n';
    await com(f, 'ev.csv'); await com(f, 'ev.csv'); const n = (await pool.query("SELECT count(*)::int n, count(store_id)::int linked FROM network_events WHERE event_type='TestEvent'")).rows[0]; assert.deepStrictEqual(n, { n: 2, linked: 1 });
  });
  let newId;
  await t('new store via CSV then appears in pull-down and in weekly upload', async () => {
    const f = 'store,brand,division\nZed Test Store,Noodle Box,Asian\n'; assert.strictEqual((await prev(f)).body.newStores.length, 1); const c = await com(f); assert.strictEqual(c.body.applied, 1);
    newId = (await pool.query("SELECT id FROM stores WHERE name='Zed Test Store'")).rows[0].id;
    const st = await call('/api/stores', { headers: { cookie: ck } }); assert.ok(st.body.brands.find(b => b.brand === 'Noodle Box').stores.some(x => x.name === 'Zed Test Store'));
    const T = require('../tools'); const m = await T.run('find_store', { text: 'zed test store noodle box' }); assert.strictEqual(m.matches[0].id, newId);
  });
  await t('edit store, manual alias is findable, inactive store leaves the pull-down', async () => {
    let r = await call('/api/admin/stores/' + newId, { method: 'PATCH', headers: JJ, body: JSON.stringify({ state: 'qld', opening_date: '2026-10-01', address: '1 Test St' }) }); assert.strictEqual(r.status, 200);
    const row = (await pool.query('SELECT state,opening_date::text d,opening_date_source s FROM stores WHERE id=$1', [newId])).rows[0]; assert.deepStrictEqual(row, { state: 'QLD', d: '2026-10-01', s: 'Manual edit' });
    r = await call(`/api/admin/stores/${newId}/aliases`, { method: 'POST', headers: JJ, body: JSON.stringify({ alias: 'The Zed' }) }); assert.strictEqual(r.body.alias, 'the zed');
    const T = require('../tools'); assert.strictEqual((await T.run('find_store', { text: 'the zed' })).matches[0].id, newId);
    r = await call('/api/admin/stores/' + newId, { method: 'PATCH', headers: JJ, body: JSON.stringify({ name: 'Zed Renamed' }) }); assert.strictEqual(r.status, 200);
    assert.strictEqual((await T.run('find_store', { text: 'the zed' })).matches[0].id, newId, 'manual alias survives rename');
    await call('/api/admin/stores/' + newId, { method: 'PATCH', headers: JJ, body: JSON.stringify({ active: false }) });
    const st = await call('/api/stores', { headers: { cookie: ck } }); assert.ok(!st.body.brands.find(b => b.brand === 'Noodle Box').stores.some(x => x.id === newId));
    r = await call('/api/admin/stores/' + newId, { method: 'PATCH', headers: JJ, body: JSON.stringify({ opening_date: '1/2/2020' }) }); assert.strictEqual(r.status, 400);
  });
  await t('duplicate store name refused', async () => { const r = await call('/api/admin/stores', { method: 'POST', headers: JJ, body: JSON.stringify({ name: 'Altona', brand: 'Noodle Box' }) }); assert.strictEqual(r.status, 400); assert.match(r.body.error, /already exists/); });
  await t('user (non-admin) cannot edit stores', async () => assert.strictEqual((await call('/api/admin/stores/1', { method: 'PATCH', headers: { cookie: ck, 'content-type': 'application/json' }, body: '{"state":"X"}' })).status, 401));
  // cleanup so the test DB returns to its loaded state
  await pool.query("DELETE FROM stores WHERE id=$1", [newId]); await pool.query("DELETE FROM network_events WHERE event_type='TestEvent'");
  await pool.query("UPDATE stores SET opening_date=NULL, opening_date_source=NULL, opening_date_confidence=NULL WHERE name='Altona'"); await pool.query("UPDATE stores SET phone=$1 WHERE name='Hawthorn NBX'", [origPhone]);
  console.log(pass + ' passed'); srv.close(); await pool.end();
})();
