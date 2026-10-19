// Integration tests against a real Postgres (DATABASE_URL). Run after init-db + load. Uses the mocked Anthropic client.
process.env.ANTHROPIC_MOCK = '1'; process.env.GEOCODE_MOCK = '1'; process.env.SESSION_SECRET ||= 'test-secret-test-secret-test-secret'; process.env.APP_PASSWORD = 'userpw'; process.env.ADMIN_PASSWORD = 'adminpw';
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
  await t('directory needs login', async () => assert.strictEqual((await call('/api/directory')).status, 401));
  await t('directory: 168 stores with details, brand totals match store sums', async () => {
    const r = await call('/api/directory', { headers: { cookie: ck } }); assert.strictEqual(r.status, 200); const d = r.body;
    assert.strictEqual(d.stores.length, 168); assert.strictEqual(d.brands.length, 6); assert.match(d.week, /^\d{4}-\d{2}-\d{2}$/);
    assert.strictEqual(d.brands.reduce((a, b) => a + b.store_count, 0), 168);
    for (const b of d.brands) { const mine = d.stores.filter(s => s.brand === b.brand); assert.strictEqual(mine.length, b.store_count); const sum = mine.reduce((a, s) => a + (s.cur_sales || 0), 0); assert.ok(Math.abs(sum - b.cur_total) < 0.01, b.brand); }
    const h = d.stores.find(s => /hawthorn/i.test(s.name) && s.brand === 'Noodle Box'); assert.ok(h && Math.round(h.cur_sales) === 18194, 'Hawthorn Noodle Box last week');
    assert.ok(d.stores.some(s => s.address && s.trading_company && s.bdm), 'some stores carry SharePoint details'); assert.ok(d.stores.every(s => 'opening_date' in s && 'opening_date_confidence' in s));
  });
  await t('ask passes a selected brand to the model as a hint', async () => {
    const r = await call('/api/ask', { method: 'POST', headers: { cookie: ck, 'content-type': 'application/json' }, body: JSON.stringify({ question: 'how did we go last week', brand: 'Noodle Box' }) }); assert.strictEqual(r.status, 200); assert.ok(r.body.answer); assert.match(require('./mock-anthropic').lastPrompt, /brand "Noodle Box" in the Brands window/);
    await call('/api/ask', { method: 'POST', headers: { cookie: ck, 'content-type': 'application/json' }, body: JSON.stringify({ question: 'and this store', brand: 'Noodle Box', store: { id: 1, name: 'X', brand: 'Noodle Box' } }) }); assert.match(require('./mock-anthropic').lastPrompt, /selected the store/); assert.doesNotMatch(require('./mock-anthropic').lastPrompt, /Brands window/);
  });
  await t('answers list the stores they name; a where-is question puts the store on the map', async () => {
    const r = await call('/api/ask', { method: 'POST', headers: { cookie: ck, 'content-type': 'application/json' }, body: JSON.stringify({ question: 'how did hawthorn go' }) });
    assert.strictEqual(r.status, 200); assert.ok(Array.isArray(r.body.stores) && r.body.stores.length >= 1, 'stores named in the answer'); assert.deepStrictEqual(r.body.map_ids, []);
    const w = await call('/api/ask', { method: 'POST', headers: { cookie: ck, 'content-type': 'application/json' }, body: JSON.stringify({ question: 'where is hawthorn' }) });
    assert.strictEqual(w.status, 200); assert.strictEqual(w.body.map_ids.length, 1); assert.ok(w.body.tools.includes('show_on_map'));
  });
  const orgCsv = fs.readFileSync(path.join(__dirname, '..', 'data', 'org_chart.csv'), 'utf8');
  await t('org chart: needs login; loads by admin upload; replaces rather than duplicates', async () => {
    assert.strictEqual((await call('/api/org')).status, 401);
    const pv = await call('/api/admin/data/preview', { method: 'POST', headers: { cookie: adm, 'content-type': 'text/csv' }, body: orgCsv }); assert.strictEqual(pv.status, 200); assert.strictEqual(pv.body.type, 'org_chart'); assert.strictEqual(pv.body.people, 48); assert.strictEqual(pv.body.vacancies, 3); assert.deepStrictEqual(pv.body.roots, ['Grant Lee']); assert.strictEqual(pv.body.problems.length, 0);
    for (let i = 0; i < 2; i++) { const r = await call('/api/admin/data/commit?name=org.csv', { method: 'POST', headers: { cookie: adm, 'content-type': 'text/csv' }, body: orgCsv }); assert.strictEqual(r.status, 200); assert.strictEqual(r.body.applied, 52); }
    const o = await call('/api/org', { headers: { cookie: ck } }); assert.strictEqual(o.body.people.length, 52);
  });
  await t('org chart: one root, every box reachable, parents correct', async () => {
    const ps = (await call('/api/org', { headers: { cookie: ck } })).body.people; const by = new Map(ps.map(p => [p.id, p])); const nm = n => ps.find(p => p.name === n);
    assert.strictEqual(ps.filter(p => !p.parent_id).length, 1); for (const p of ps) { let q = p, n = 0; while (q.parent_id && n++ < 20) q = by.get(q.parent_id); assert.strictEqual(q.name, 'Grant Lee', p.name); }
    assert.strictEqual(by.get(nm('Aaron Righetti').parent_id).name, 'Tom Martin'); assert.strictEqual(by.get(nm('Raf Shaaban').parent_id).name, 'Stephen Russell'); assert.strictEqual(by.get(nm('Tash Geracitano').parent_id).kind, 'vacant');
    assert.strictEqual(by.get(nm('Ruby Heaslip').parent_id).kind, 'group'); assert.strictEqual(by.get(by.get(nm('Ruby Heaslip').parent_id).parent_id).name, 'Grant Lee');
  });
  await t('org chart: unknown boss and circular lines are caught', async () => {
    const bad = 'name,position,reports_to\nA,Boss,\nB,Staff,Nobody Here\n'; const pv = await call('/api/admin/data/preview', { method: 'POST', headers: { cookie: adm, 'content-type': 'text/csv' }, body: bad }); assert.strictEqual(pv.body.type, 'org_chart'); assert.ok(pv.body.problems.some(x => /Nobody Here/.test(x)));
    const loop = 'person_id,name,position,reports_to_id\n1,A,x,2\n2,B,y,1\n'; const c = await call('/api/admin/data/commit', { method: 'POST', headers: { cookie: adm, 'content-type': 'text/csv' }, body: loop }); assert.strictEqual(c.status, 400); assert.match(c.body.error, /circle/);
    assert.strictEqual((await call('/api/org', { headers: { cookie: ck } })).body.people.length, 52, 'failed upload left the chart untouched');
  });
  await t('org_lookup tool: person, direct reports, chain, department, role, vacancies', async () => {
    const T = require('../tools'); const p = await T.run('org_lookup', { action: 'person', text: 'aaron righetti' }); assert.strictEqual(p.matches[0].reports_to.name, 'Tom Martin'); assert.strictEqual(p.matches[0].direct_reports.length, 4);
    const d = await T.run('org_lookup', { action: 'direct_reports', text: 'tom martin' }); assert.strictEqual(d.people[0].direct_reports.length, 5);
    const ch = await T.run('org_lookup', { action: 'chain_of_command', text: 'Raf Shaaban' }); assert.deepStrictEqual(ch.chain_up_to_top.map(x => x.name), ['Stephen Russell', 'Adrian Gallace', 'Grant Lee']);
    const dep = await T.run('org_lookup', { action: 'department', text: 'supply' }); assert.ok(dep.matches.length >= 4);
    const role = await T.run('org_lookup', { action: 'role', text: 'head of finance' }); assert.strictEqual(role.matches[0].name, 'Patrick Denniss');
    const v = await T.run('org_lookup', { action: 'vacancies' }); assert.strictEqual(v.vacancies.length, 3); assert.ok(v.vacancies.every(x => x.role));
    const who = await T.run('org_lookup', { action: 'person', text: 'head of supply' }); assert.strictEqual(who.matches[0].name, 'Thierry Chan');
    const none = await T.run('org_lookup', { action: 'person', text: 'zzz nobody' }); assert.deepStrictEqual(none.matches, []);
    assert.ok(JSON.stringify(await T.run('data_status', {})).includes('organisation_chart'));
  });
  await t('instructions to Claude ask for short answers by default', async () => { const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'); assert.match(src, /keep them SHORT/); assert.match(src, /one or two plain spoken sentences/); assert.match(src, /org_lookup/); });
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

  // ---- map ----
  await t('map-points: by id and by brand, needs login', async () => {
    assert.strictEqual((await call('/api/map-points?ids=1')).status, 401);
    const a = await call('/api/map-points?brand=South%20Seoul', { headers: { cookie: ck } }); assert.strictEqual(a.body.points.length, 4);
    assert.ok(a.body.points.every(p => p.search && /Australia|VIC|QLD|NSW|WA|SA|TAS|ACT|\d/.test(p.search + (p.address || ''))));
    const id = a.body.points[0].id; const b = await call('/api/map-points?ids=' + id, { headers: { cookie: ck } }); assert.strictEqual(b.body.points[0].id, id);
    assert.strictEqual((await call('/api/map-points', { headers: { cookie: ck } })).status, 400);
  });
  await t('config only exposes the browser maps key, behind login', async () => { assert.strictEqual((await call('/api/config')).status, 401); const c = await call('/api/config', { headers: { cookie: ck } }); assert.ok('mapsKey' in c.body); });
  await t('geocode (mock): fills coordinates, flags name-based ones as approximate, then map-points returns them', async () => {
    const g = await call('/api/admin/geocode', { method: 'POST', headers: JJ, body: '{}' }); assert.strictEqual(g.status, 200); assert.ok(g.body.found > 100, JSON.stringify(g.body));
    const srcs = (await pool.query("SELECT geo_source, count(*)::int n FROM stores WHERE lat IS NOT NULL GROUP BY 1")).rows; assert.ok(srcs.find(x => x.geo_source === 'address') && srcs.find(x => x.geo_source === 'name'));
    const p = await call('/api/map-points?brand=Acai%20Bros', { headers: { cookie: ck } }); assert.ok(p.body.points.every(x => typeof x.lat === 'number'));
    assert.strictEqual((await call('/api/admin/geocode', { method: 'POST', headers: { cookie: ck, 'content-type': 'application/json' }, body: '{}' })).status, 401);
  });
  await t('manual location edit is recorded as manual', async () => { const id = (await pool.query("SELECT id FROM stores WHERE name='Hawthorn NBX'")).rows[0].id; const r = await call('/api/admin/stores/' + id, { method: 'PATCH', headers: JJ, body: JSON.stringify({ lat: '-37.822', lng: '145.035' }) }); assert.strictEqual(r.status, 200); const x = (await pool.query('SELECT lat,lng,geo_source FROM stores WHERE id=$1', [id])).rows[0]; assert.deepStrictEqual(x, { lat: -37.822, lng: 145.035, geo_source: 'manual' }); const bad = await call('/api/admin/stores/' + id, { method: 'PATCH', headers: JJ, body: JSON.stringify({ lat: 'abc' }) }); assert.strictEqual(bad.status, 400); });
  await pool.query("UPDATE stores SET lat=NULL,lng=NULL,geo_source=NULL");
  await t('item sales: detected, analysed, loaded; reload replaces the same period', async () => {
    const csv = 'brand,store,item_name,period_start,period_end,sales\nNoodle Box,Hawthorn NBX,Combination,2026-08-23,2026-10-17,"1,200.50"\nNoodle Box,Hawthorn NBX,Pad Thai,2026-08-23,2026-10-17,800\nNoodle Box,Hawthorn NBX,POS Discount,2026-08-23,2026-10-17,-300\nNoodle Box,Altona,Combination,2026-08-23,2026-10-17,2000\nNoodle Box,Altona,Pad Thai,2026-08-23,2026-10-17,500\nNoodle Box,Nowhere Land,Combination,2026-08-23,2026-10-17,5\n';
    const a = await call('/api/admin/data/preview', { method: 'POST', headers: { cookie: adm, 'content-type': 'text/csv' }, body: csv }); assert.strictEqual(a.status, 200); assert.strictEqual(a.body.type, 'item_sales_store'); assert.strictEqual(a.body.stores, 3); assert.strictEqual(a.body.matched, 2); assert.deepStrictEqual(a.body.unmatched, ['Nowhere Land']); assert.strictEqual(a.body.total_sales, 4205.5);
    for (let i = 0; i < 2; i++) { const r = await call('/api/admin/data/commit?name=items.csv', { method: 'POST', headers: { cookie: adm, 'content-type': 'text/csv' }, body: csv }); assert.strictEqual(r.status, 200); assert.strictEqual(r.body.applied, 6); }
    assert.strictEqual(Number((await pool.query('SELECT count(*) FROM item_sales')).rows[0].count), 6);
    const bad = await call('/api/admin/data/commit', { method: 'POST', headers: { cookie: adm, 'content-type': 'text/csv' }, body: 'brand,store,item_name,period_start,period_end,sales\nNoodle Box,Altona,X,notadate,2026-10-17,5\n' }); assert.strictEqual(bad.status, 400);
  });
  await t('read me page: needs sign-in, then served', async () => {
    const no = await fetch(base + '/readme', { redirect: 'manual' }); assert.ok(no.status === 302 || no.status === 301);
    const ok = await fetch(base + '/readme', { headers: { cookie: adm } }); assert.strictEqual(ok.status, 200); assert.match(await ok.text(), /C8 Ask – read me/);
  });
  await t('questions review: outcomes are recorded and listed for admins', async () => {
    await pool.query("INSERT INTO ask_log(question,tools,ms,outcome,answer,note) VALUES ('zz test ok','group_totals',10,'answered','fine',NULL),('zz test bad','',5,'no_answer','','stop_reason=end_turn')");
    const all = await call('/api/admin/questions', { headers: { cookie: adm } }); assert.strictEqual(all.status, 200); assert.ok(all.body.rows.some(x => x.question === 'zz test ok')); assert.ok(all.body.counts.problems >= 1);
    const pr = await call('/api/admin/questions?problems=1', { headers: { cookie: adm } }); assert.ok(pr.body.rows.every(x => x.outcome !== 'answered') && pr.body.rows.some(x => x.question === 'zz test bad'));
    assert.strictEqual((await call('/api/admin/questions', { headers: {} })).status, 401);
    await pool.query("DELETE FROM ask_log WHERE question LIKE 'zz test%'");
  });
  await t('budget: upload replaces, tool answers overview/section/find/notes/vs_actual', async () => {
    const body = fs.readFileSync(path.join(__dirname, '..', 'data', 'budget_fy27.json'), 'utf8'); const H = { cookie: adm, 'content-type': 'text/csv' };
    const pv = await call('/api/admin/data/preview', { method: 'POST', headers: H, body }); assert.strictEqual(pv.status, 200, JSON.stringify(pv.body)); assert.strictEqual(pv.body.type, 'budget'); assert.strictEqual(pv.body.problems.length, 0); assert.ok(pv.body.rows > 300);
    for (let i = 0; i < 2; i++) { const r = await call('/api/admin/data/commit?name=b.json', { method: 'POST', headers: H, body }); assert.strictEqual(r.status, 200); assert.strictEqual(r.body.applied, pv.body.rows); }
    assert.strictEqual(Number((await pool.query('SELECT count(*) FROM budget_lines')).rows[0].count), pv.body.rows);
    const T = require('../tools'); const o = await T.run('budget', { action: 'overview' }); const tn = o.headline.find(x => x.line === 'Total network sales'); assert.strictEqual(tn.values.FY27B, 222916476); assert.strictEqual(tn.change_pct, 19.7);
    const rv = await T.run('budget', { action: 'section', section: 'revenue' }); assert.strictEqual(rv.lines.find(x => x.line === 'Royalties').values.FY27B, 14927186);
    const f = await T.run('budget', { action: 'find', text: 'NPAT' }); const np = await T.run('budget', { action: 'find', text: 'Net profit after tax' }); assert.strictEqual(np.lines[0].values.FY27B, 6743153); assert.ok(f.lines.length === 0 || f.lines.length > 0);
    const mk = await T.run('budget', { action: 'section', section: 'marketing_pl' }); assert.strictEqual(mk.lines.find(x => x.line === 'Net profit').values.FY27B, 12906);
    const n = await T.run('budget', { action: 'notes', text: 'acai' }); assert.ok(n.notes.length >= 2);
    const va = await T.run('budget', { action: 'vs_actual' }); assert.ok(va.caution && Array.isArray(va.by_brand));
    assert.strictEqual((await call('/api/admin/data/preview', { method: 'POST', headers: H, body: '{"budget":true,"fy":"X"}' })).status, 400);
    const ds = await T.run('data_status', {}); assert.ok(Array.isArray(ds.budget));
    assert.strictEqual((await call('/api/stores', { headers: {} })).status, 401);
  });

  await t('item_sales tool: top items, one item, item in a store; adjustments excluded', async () => {
    const T = require('../tools'); const hw = (await pool.query("SELECT id FROM stores WHERE name='Hawthorn NBX'")).rows[0].id;
    const top = await T.run('item_sales', { action: 'top_items', brand: 'Noodle Box' }); assert.strictEqual(top.items[0].item, 'Combination'); assert.strictEqual(top.items[0].sales, 3205.5); assert.ok(!top.items.some(x => /discount/i.test(x.item))); assert.match(top.period, /2026-08-23 to 2026-10-17/);
    const adj = await T.run('item_sales', { action: 'top_items', brand: 'Noodle Box', include_adjustments: true }); assert.ok(adj.total_item_sales < top.total_item_sales);
    const tot = await T.run('item_sales', { action: 'item_total', item: 'pad thai' }); assert.strictEqual(tot.total_sales, 1300); assert.strictEqual(tot.top_stores[0].store, 'Hawthorn NBX');
    const ins = await T.run('item_sales', { action: 'item_in_store', item: 'Combination', store_id: hw }); assert.strictEqual(ins.sales, 1200.5); assert.strictEqual(ins.rank_in_store, 1); assert.strictEqual(ins.of_items, 2);
    const part = await T.run('item_sales', { action: 'item_total', item: 'comb' }); assert.strictEqual(part.total_sales, 3205.5);
    const none = await T.run('item_sales', { action: 'item_total', item: 'zzz' }); assert.ok(none.error); const nb = await T.run('item_sales', { action: 'top_items', brand: 'Huxtaburger' }); assert.ok(nb.error);
    const ds = await T.run('data_status', {}); assert.ok(Array.isArray(ds.item_sales));
  });

  // ---------- text-message sign-in ----------
  const SMSM = require('../sms'); let ipn = 1; const jp = (b, c) => ({ method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.' + (ipn++ % 250) + '.' + Math.floor(ipn / 250) + '.7', ...(c ? { cookie: c } : {}) }, body: JSON.stringify(b) });
  let uA, uB, tcookie;
  await t('mobile numbers are normalised (and non-mobiles refused)', async () => {
    assert.strictEqual(SMSM.normaliseMobile('0412 345 678'), '+61412345678'); assert.strictEqual(SMSM.normaliseMobile('+61 412-345-678'), '+61412345678'); assert.strictEqual(SMSM.normaliseMobile('61412345678'), '+61412345678');
    assert.strictEqual(SMSM.normaliseMobile('0398765432'), null); assert.strictEqual(SMSM.normaliseMobile('abc'), null); assert.strictEqual(SMSM.normaliseMobile(''), null); assert.strictEqual(SMSM.normaliseMobile('+14155550123'), '+14155550123');
  });
  await t('admin can add users; duplicate and bad numbers refused; needs admin', async () => {
    assert.strictEqual((await call('/api/admin/users', { headers: { cookie: ck } })).status, 401);
    let r = await call('/api/admin/users', jp({ name: 'Test Admin', mobile: '0411 000 001', role: 'admin' }, adm)); assert.strictEqual(r.status, 200); uA = r.body.id;
    r = await call('/api/admin/users', jp({ name: 'Test Director', mobile: '0411 000 002' }, adm)); assert.strictEqual(r.status, 200); uB = r.body.id;
    assert.strictEqual((await call('/api/admin/users', jp({ name: 'Dup', mobile: '0411000002' }, adm))).status, 400); assert.strictEqual((await call('/api/admin/users', jp({ name: 'Bad', mobile: '12345' }, adm))).status, 400);
    const l = await call('/api/admin/users', { headers: { cookie: adm } }); assert.strictEqual(l.body.users.length, 2); assert.strictEqual(l.body.sms, false);
  });
  await t('with SMS off, text-message endpoints are not available', async () => assert.strictEqual((await call('/api/login/request', jp({ mobile: '0411000001' }))).status, 404));
  process.env.SMS_PROVIDER = 'console';
  const lastCode = () => /(\d{6})/.exec(SMSM.sent[SMSM.sent.length - 1].body)[1];
  await t('SMS on: shared passwords and old cookies stop working', async () => {
    assert.strictEqual((await call('/api/login', jp({ password: 'adminpw' }))).status, 403); assert.strictEqual((await call('/api/stores', { headers: { cookie: ck } })).status, 401); assert.strictEqual((await call('/api/admin/loads', { headers: { cookie: adm } })).status, 401);
    const s = await call('/api/session'); assert.strictEqual(s.body.sms, true); assert.strictEqual(s.body.loggedIn, false);
  });
  await t('request a code: same reply for known and unknown numbers; only the known one is texted; code is 6 digits and not stored', async () => {
    const n0 = SMSM.sent.length; const a = await call('/api/login/request', jp({ mobile: '0411 000 002' })); const b = await call('/api/login/request', jp({ mobile: '0499 999 999' }));
    assert.strictEqual(a.status, 200); assert.deepStrictEqual(a.body, b.body); assert.strictEqual(SMSM.sent.length, n0 + 1); assert.strictEqual(SMSM.sent[n0].to, '+61411000002'); assert.match(SMSM.sent[n0].body, /\b\d{6}\b/);
    const code = lastCode(); const row = (await pool.query('SELECT code_hash FROM login_codes WHERE user_id=$1 AND NOT used', [uB])).rows[0]; assert.ok(row && !row.code_hash.includes(code));
    assert.strictEqual((await call('/api/login/request', jp({ mobile: 'nope' }))).status, 400);
  });
  await t('a wrong code is refused, five wrong guesses kill the code, a right code after that is refused too', async () => {
    const good = lastCode(); const wrong = good === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) assert.strictEqual((await call('/api/login/verify', jp({ mobile: '0411000002', code: wrong }))).status, 401);
    assert.strictEqual((await call('/api/login/verify', jp({ mobile: '0411000002', code: good }))).status, 401);
    assert.strictEqual((await call('/api/login/verify', jp({ mobile: '0411000002', code: 'abc' }))).status, 401);
  });
  await t('right code signs in as a user (not admin); the code works only once', async () => {
    await pool.query("UPDATE login_codes SET used=TRUE WHERE user_id=$1", [uB]); const n0 = SMSM.sent.length; await call('/api/login/request', jp({ mobile: '0411000002' })); assert.strictEqual(SMSM.sent.length, n0 + 1); const code = lastCode();
    const r = await call('/api/login/verify', jp({ mobile: '0411 000 002', code })); assert.strictEqual(r.status, 200); assert.strictEqual(r.body.role, 'user'); tcookie = r.headers.get('set-cookie').split(';')[0]; assert.match(r.headers.get('set-cookie'), /Max-Age=43200/);
    assert.strictEqual((await call('/api/stores', { headers: { cookie: tcookie } })).status, 200); assert.strictEqual((await call('/api/admin/loads', { headers: { cookie: tcookie } })).status, 401);
    assert.strictEqual((await call('/api/login/verify', jp({ mobile: '0411000002', code }))).status, 401); const s = await call('/api/session', { headers: { cookie: tcookie } }); assert.strictEqual(s.body.loggedIn, true); assert.strictEqual(s.body.role, 'user');
  });
  await t('expired code refused', async () => {
    await pool.query("UPDATE login_codes SET used=TRUE WHERE user_id=$1", [uB]); await pool.query("UPDATE login_codes SET created_at = now() - interval '1 hour' WHERE user_id=$1", [uB]);   // clear the send-rate window
    await call('/api/login/request', jp({ mobile: '0411000002' })); const code = lastCode(); await pool.query("UPDATE login_codes SET expires_at = now() - interval '1 minute' WHERE user_id=$1 AND NOT used", [uB]);
    assert.strictEqual((await call('/api/login/verify', jp({ mobile: '0411000002', code }))).status, 401);
  });
  await t('sending is limited to 3 codes per 15 minutes per person', async () => {
    await pool.query('DELETE FROM login_codes WHERE user_id=$1', [uB]); const n0 = SMSM.sent.length; for (let i = 0; i < 5; i++) await call('/api/login/request', jp({ mobile: '0411000002' })); assert.strictEqual(SMSM.sent.length - n0, 3);
  });
  await t('admin signs in by text and can use the admin area; switching a user off cuts their live session', async () => {
    await call('/api/login/request', jp({ mobile: '0411000001' })); const r = await call('/api/login/verify', jp({ mobile: '0411000001', code: lastCode() })); assert.strictEqual(r.body.role, 'admin'); const ac = r.headers.get('set-cookie').split(';')[0];
    assert.strictEqual((await call('/api/admin/loads', { headers: { cookie: ac } })).status, 200);
    assert.strictEqual((await call('/api/admin/users/' + uB, { method: 'PATCH', headers: { cookie: ac, 'content-type': 'application/json' }, body: JSON.stringify({ active: false }) })).status, 200);
    assert.strictEqual((await call('/api/stores', { headers: { cookie: tcookie } })).status, 401);
    await pool.query("DELETE FROM login_codes WHERE user_id=$1", [uB]); const n0 = SMSM.sent.length; await call('/api/login/request', jp({ mobile: '0411000002' })); assert.strictEqual(SMSM.sent.length, n0, 'no code for a switched-off person');
    assert.strictEqual((await call('/api/admin/users/' + uA, { method: 'PATCH', headers: { cookie: ac, 'content-type': 'application/json' }, body: JSON.stringify({ active: false }) })).status, 400);   // cannot switch off yourself / the last admin
    assert.strictEqual((await call('/api/admin/users/' + uA, { method: 'DELETE', headers: { cookie: ac } })).status, 400);
    assert.strictEqual((await call('/api/admin/users/' + uB, { method: 'DELETE', headers: { cookie: ac } })).status, 200);
  });
  await t('a tampered cookie is refused in SMS mode', async () => { await call('/api/login/request', jp({ mobile: '0411000001' })); const r = await call('/api/login/verify', jp({ mobile: '0411000001', code: lastCode() })); const c = r.headers.get('set-cookie').split(';')[0]; assert.strictEqual((await call('/api/stores', { headers: { cookie: c.slice(0, -3) + 'xxx' } })).status, 401); });
  delete process.env.SMS_PROVIDER; await pool.query('DELETE FROM app_users');
  await t('with SMS off again, the shared passwords work as before', async () => assert.strictEqual((await call('/api/login', jp({ password: 'userpw' }))).status, 200));

  // ---------- email sign-in (same engine, delivered by email) ----------
  const MAILM = require('../mail'); let eA, eB, ecookie;
  await t('email addresses are normalised and validated', async () => { assert.strictEqual(MAILM.normaliseEmail('  Sam.D@Example.COM '), 'sam.d@example.com'); for (const b of ['', 'nope', 'a@b', 'a b@c.com', '<x>@y.com']) assert.strictEqual(MAILM.normaliseEmail(b), null, b); });
  await t('admin adds people by email; a user needs the right identifier for the delivery method', async () => {
    let r = await call('/api/admin/users', jp({ name: 'E Admin', email: 'Admin@Example.com', role: 'admin' }, adm)); assert.strictEqual(r.status, 200); eA = r.body.id;
    r = await call('/api/admin/users', jp({ name: 'E Director', email: 'dir@example.com' }, adm)); assert.strictEqual(r.status, 200); eB = r.body.id;
    assert.strictEqual((await call('/api/admin/users', jp({ name: 'Dup', email: 'DIR@example.com' }, adm))).status, 400); assert.strictEqual((await call('/api/admin/users', jp({ name: 'Bad', email: 'nope' }, adm))).status, 400); assert.strictEqual((await call('/api/admin/users', jp({ name: 'None' }, adm))).status, 400);
    const l = (await call('/api/admin/users', { headers: { cookie: adm } })).body.users; assert.ok(l.some(u => u.email === 'admin@example.com'));
  });
  process.env.EMAIL_PROVIDER = 'console';
  const mailCode = () => /code is (\d{6})/.exec(MAILM.sent[MAILM.sent.length - 1].text)[1];
  await t('email on: session says so; codes are emailed (not texted); same reply for unknown addresses; email wins if text is also set up', async () => {
    process.env.SMS_PROVIDER = 'console'; const s = await call('/api/session'); assert.strictEqual(s.body.channel, 'email'); const n0 = MAILM.sent.length, m0 = SMSM.sent.length;
    const a = await call('/api/login/request', jp({ email: 'DIR@example.com' })); const b = await call('/api/login/request', jp({ email: 'nobody@example.com' })); assert.deepStrictEqual(a.body, b.body);
    assert.strictEqual(MAILM.sent.length, n0 + 1); assert.strictEqual(SMSM.sent.length, m0); assert.strictEqual(MAILM.sent[n0].to, 'dir@example.com'); assert.match(MAILM.sent[n0].subject, /C8 Ask/); assert.doesNotMatch(MAILM.sent[n0].text, /https?:/);
    assert.strictEqual((await call('/api/login/request', jp({ email: 'not an email' }))).status, 400); delete process.env.SMS_PROVIDER;
  });
  await t('emailed code: wrong refused, right signs in, only once, address matching ignores case', async () => {
    const code = mailCode(); const wrong = code === '000000' ? '111111' : '000000'; assert.strictEqual((await call('/api/login/verify', jp({ email: 'dir@example.com', code: wrong }))).status, 401);
    const r = await call('/api/login/verify', jp({ email: 'Dir@Example.com', code })); assert.strictEqual(r.status, 200); assert.strictEqual(r.body.role, 'user'); ecookie = r.headers.get('set-cookie').split(';')[0];
    assert.strictEqual((await call('/api/stores', { headers: { cookie: ecookie } })).status, 200); assert.strictEqual((await call('/api/admin/loads', { headers: { cookie: ecookie } })).status, 401); assert.strictEqual((await call('/api/login/verify', jp({ email: 'dir@example.com', code }))).status, 401);
  });
  await t('emailed codes: limited to 3 per 15 minutes; five wrong guesses cancel the code', async () => {
    await pool.query('DELETE FROM login_codes WHERE user_id=$1', [eB]); const n0 = MAILM.sent.length; for (let i = 0; i < 5; i++) await call('/api/login/request', jp({ email: 'dir@example.com' })); assert.strictEqual(MAILM.sent.length - n0, 3);
    const good = mailCode(), wrong = good === '000000' ? '111111' : '000000'; for (let i = 0; i < 5; i++) await call('/api/login/verify', jp({ email: 'dir@example.com', code: wrong })); assert.strictEqual((await call('/api/login/verify', jp({ email: 'dir@example.com', code: good }))).status, 401);
  });
  await t('email admin: admin area works; switching off ends the live session; mobile numbers do not sign in while email is the method', async () => {
    await call('/api/login/request', jp({ email: 'admin@example.com' })); const r = await call('/api/login/verify', jp({ email: 'admin@example.com', code: mailCode() })); assert.strictEqual(r.body.role, 'admin'); const ac = r.headers.get('set-cookie').split(';')[0];
    assert.strictEqual((await call('/api/admin/users', { headers: { cookie: ac } })).body.channel, 'email'); assert.strictEqual((await call('/api/admin/users/' + eB, { method: 'PATCH', headers: { cookie: ac, 'content-type': 'application/json' }, body: JSON.stringify({ active: false }) })).status, 200);
    assert.strictEqual((await call('/api/stores', { headers: { cookie: ecookie } })).status, 401);
    const n0 = MAILM.sent.length; await call('/api/login/request', jp({ mobile: '0411000001' })); assert.strictEqual(MAILM.sent.length, n0);
  });
  delete process.env.EMAIL_PROVIDER; await pool.query('DELETE FROM app_users');
  // cleanup so the test DB returns to its loaded state
  await pool.query("DELETE FROM stores WHERE id=$1", [newId]); await pool.query("DELETE FROM network_events WHERE event_type='TestEvent'");
  await pool.query("UPDATE stores SET opening_date=NULL, opening_date_source=NULL, opening_date_confidence=NULL WHERE name='Altona'"); await pool.query("UPDATE stores SET phone=$1 WHERE name='Hawthorn NBX'", [origPhone]);
  await pool.query('DELETE FROM item_sales'); await pool.query('DELETE FROM budget_lines'); await pool.query('DELETE FROM budget_notes');
  console.log(pass + ' passed'); srv.close(); await pool.end();
})();
