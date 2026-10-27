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
  await t('ask records how long it took and the tokens used, and the admin question list shows them', async () => {
    await call('/api/ask', { method: 'POST', headers: { cookie: ck, 'content-type': 'application/json' }, body: JSON.stringify({ question: 'what did hawthorn do last week' }) });
    const row = (await pool.query('SELECT id, ms, input_tokens, output_tokens FROM ask_log ORDER BY id DESC LIMIT 1')).rows[0]; assert.ok(row.ms >= 0 && row.input_tokens >= 300 && row.input_tokens % 100 === 0 && row.output_tokens === row.input_tokens / 5, JSON.stringify(row));
    const qs = await call('/api/admin/questions', { headers: { cookie: adm } }); const qr = qs.body.rows.find(r => r.id === row.id); assert.strictEqual(qr.input_tokens, row.input_tokens); assert.ok(Math.abs(Number(qr.cost_usd) - (row.input_tokens * 2 + row.output_tokens * 10) / 1e6) < 1e-9, 'cost'); assert.ok(qs.body.counts.cost_usd > 0);
    assert.match(await (await fetch(base + '/api/admin/questions.csv', { headers: { cookie: adm } })).text(), /input_tokens,output_tokens/);
  });
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
  await t('store states file: detected, sets state, copies to linked events', async () => {
    const f = 'store,brand,state\nHawthorn NBX,Noodlebox,nsw\nNowhereville,Noodlebox,VIC\n';
    const p = await prev(f); assert.strictEqual(p.body.type, 'store_state'); assert.strictEqual(p.body.matched, 1);
    await pool.query("INSERT INTO network_events(source,brand,restaurant,event_type,store_id) SELECT 'test','Noodle Box','Hawthorn NBX','opened',id FROM stores WHERE name='Hawthorn NBX'");
    const c = await com(f); assert.strictEqual(c.body.applied, 1);
    assert.strictEqual((await pool.query("SELECT state FROM stores WHERE name='Hawthorn NBX'")).rows[0].state, 'NSW');
    assert.strictEqual((await pool.query("SELECT state FROM network_events WHERE source='test'")).rows[0].state, 'NSW');
    await pool.query("DELETE FROM network_events WHERE source='test'");
  });
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
    const qc = await fetch(base + '/api/admin/questions.csv', { headers: { cookie: adm } }); assert.strictEqual(qc.status, 200); assert.match(qc.headers.get('content-disposition'), /attachment; filename="c8-ask-questions-/); const qt = await qc.text(); assert.match(qt, /^id,asked_at,question/); assert.ok(qt.includes('zz test ok'));
    assert.strictEqual((await fetch(base + '/api/admin/questions.csv', { headers: { cookie: ck } })).status, 401); assert.strictEqual((await fetch(base + '/api/admin/loads.csv', { headers: { cookie: adm } })).status, 200);
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

  await t('pipeline: upload replaces, tool answers overview/list/site/delayed/expiries/activity', async () => {
    const body = fs.readFileSync(path.join(__dirname, '..', 'data', 'network_pipeline.json'), 'utf8'); const H = { cookie: adm, 'content-type': 'text/csv' };
    const pv = await call('/api/admin/data/preview', { method: 'POST', headers: H, body }); assert.strictEqual(pv.status, 200, JSON.stringify(pv.body)); assert.strictEqual(pv.body.type, 'pipeline'); assert.strictEqual(pv.body.kinds.greenfield, 19);
    for (let i = 0; i < 2; i++) { const cm = await call('/api/admin/data/commit?name=tracker.json', { method: 'POST', headers: H, body }); assert.strictEqual(cm.status, 200, JSON.stringify(cm.body)); }
    assert.strictEqual(Number((await pool.query('SELECT count(*) FROM pipeline_projects')).rows[0].count), pv.body.projects);   // second load replaced, not doubled
    assert.ok(Number((await pool.query('SELECT count(*) FROM pipeline_steps')).rows[0].count) > 1000);
    const T = require('../tools'); const ov = await T.run('pipeline', { action: 'overview' }); assert.match(ov.latest_entry, /^2026-0[5-9]/); assert.ok(ov.sites_by_tab.length >= 6);
    const gf = await T.run('pipeline', { action: 'list', kind: 'greenfield', brand: 'Noodle Box' }); assert.ok(gf.count > 3 && gf.sites.every(x => x.brand === 'Noodle Box' && x.kind === 'greenfield')); assert.ok(gf.sites[0].progress && 'steps_done' in gf.sites[0].progress);
    const br = await T.run('pipeline', { action: 'site', text: 'Brassall' }); assert.ok(br.tracker_entries.length >= 1 && br.tracker_entries[0].steps.some(x => /Lease Signed/.test(x)));
    const dl = await T.run('pipeline', { action: 'delayed' }); assert.ok(dl.sites.length > 3 && dl.sites[0].delayed_days >= dl.sites[1].delayed_days);
    const ex = await T.run('pipeline', { action: 'expiries', months: 60 }); assert.ok(Array.isArray(ex.coming_up) && Array.isArray(ex.c8_held_leases_coming_up) && ex.already_past_dates.c8_held_leases.length > 3);
    const ac = await T.run('pipeline', { action: 'activity', kind: 'closure' }); assert.ok(ac.rows.every(x => /closure/i.test(x.type)));
    const sg = await T.run('pipeline', { action: 'step', text: 'Fran Docs Signed' }); assert.ok(sg.by_tab_and_step['greenfield / Fran Docs Signed'].by_value.Returned >= 5); assert.strictEqual(sg.by_tab_and_step['greenfield / Fran Docs Signed'].dated, 0);
    const od = await T.run('pipeline', { action: 'step', text: 'Out of Disclosure', kind: 'opened' }); assert.ok(od.by_tab_and_step['opened / Out of Disclosure'].dated >= 5);
    assert.ok((await T.run('pipeline', { action: 'step', text: 'zzzz' })).matched_steps.length === 0);
    assert.match((await T.run('pipeline', { action: 'site' })).error, /store_id or the site name/);
    assert.strictEqual((await call('/api/admin/data/preview', { method: 'POST', headers: H, body: '{"pipeline":true}' })).status, 400);
    const ds = await T.run('data_status', {}); assert.strictEqual(ds.network_tracker_pipeline.sites, pv.body.projects);
  });

  await t('item_sales tool: state filter, period choice, partial (top-30) periods are flagged', async () => {
    const T = require('../tools'); const all = await T.run('item_sales', { action: 'top_items', brand: 'Noodle Box' }); assert.ok(Array.isArray(all.available_periods) && all.available_periods.length >= 1);
    const vic = await T.run('item_sales', { action: 'top_items', brand: 'Noodle Box', state: 'vic' }); assert.match(vic.scope, /VIC/); assert.ok(vic.error || vic.total_item_sales <= all.total_item_sales);
    const bad = await T.run('item_sales', { action: 'top_items', brand: 'Noodle Box', period_end: '2001-01-01' }); assert.match(bad.error, /No item sales period ends/);
    const nostate = await T.run('item_sales', { action: 'top_items', brand: 'Noodle Box', state: 'ZZ' }); assert.match(nostate.error, /No stores are held for state/);
    assert.strictEqual(all.partial, true);   // the test file holds only a handful of items, which counts as a partial period
  });
  await t('item_sales tool: shared end date - a store question uses the period that holds the store; period_start picks explicitly', async () => {
    const T = require('../tools'); const sid = (await pool.query("SELECT store_id id, brand FROM item_sales WHERE store_id IS NOT NULL LIMIT 1")).rows[0];
    await pool.query("INSERT INTO item_sales(store_id,store_name,brand,item_name,period_start,period_end,sales) SELECT NULL,'All stores (brand total)',$1,'ZZ Test Item','2031-02-01','2031-02-28',1", [sid.brand]);
    const ps = (await pool.query("SELECT period_start::text ps, period_end::text pe FROM item_sales WHERE store_id=$1 ORDER BY period_end DESC LIMIT 1", [sid.id])).rows[0];
    await pool.query("INSERT INTO item_sales(store_id,store_name,brand,item_name,period_start,period_end,sales) VALUES (NULL,'All stores (brand total)',$1,'ZZ Test Item',$2::date + 20,$3,1)", [sid.brand, ps.ps, ps.pe]);
    const r = await T.run('item_sales', { action: 'store_items', store_id: sid.id }); assert.ok(!r.error, r.error); assert.strictEqual(r.period, ps.ps + ' to ' + ps.pe);
    const x = await T.run('item_sales', { action: 'top_items', brand: sid.brand, period_end: ps.pe, period_start: ps.ps }); assert.strictEqual(x.period, ps.ps + ' to ' + ps.pe);
    await pool.query("DELETE FROM item_sales WHERE item_name='ZZ Test Item'");
  });
  await t('item sales by month with units: store-level and brand-total files coexist; units are queryable', async () => {
    const T = require('../tools'); const H = { cookie: adm, 'content-type': 'text/csv' };
    const sid = (await pool.query("SELECT id FROM stores WHERE name ILIKE 'altona%' AND brand='Noodle Box' LIMIT 1")).rows[0].id;
    const store = 'Noodle Box - Altona NBX';
    const csvS = 'brand,store,item_name,period_start,period_end,sales,units\nNoodle Box,' + store + ',Combination,2030-01-01,2030-01-31,900,100\nNoodle Box,' + store + ',Pad Thai,2030-01-01,2030-01-31,300,40\n';
    const csvT = 'brand,store,item_name,period_start,period_end,sales\nNoodle Box,All stores (brand total),Combination,2030-01-01,2030-01-31,5000\n';
    const a = await call('/api/admin/data/preview', { method: 'POST', headers: H, body: csvS }); assert.strictEqual(a.body.type, 'item_sales_store'); assert.strictEqual(a.body.total_units, 140);
    assert.strictEqual((await call('/api/admin/data/commit?name=s.csv', { method: 'POST', headers: H, body: csvS })).status, 200);
    assert.strictEqual((await call('/api/admin/data/commit?name=t.csv', { method: 'POST', headers: H, body: csvT })).status, 200);
    assert.strictEqual(Number((await pool.query("SELECT count(*) FROM item_sales WHERE period_start='2030-01-01'")).rows[0].count), 3);   // neither file wiped the other
    const u = await T.run('item_sales', { action: 'store_items', store_id: sid, measure: 'units', period_start: '2030-01-01', period_end: '2030-01-31' }); assert.ok(!u.error, u.error); assert.strictEqual(u.items[0].item, 'Combination'); assert.strictEqual(u.items[0].units, 100); assert.strictEqual(u.total_item_units, 140);
    const d = await T.run('item_sales', { action: 'top_items', brand: 'Noodle Box', period_start: '2030-01-01', period_end: '2030-01-31' }); assert.strictEqual(d.brand_total_only, true); assert.strictEqual(d.total_item_sales, 5000);
    const nu = await T.run('item_sales', { action: 'top_items', brand: 'Noodle Box', measure: 'units', period_start: '2030-01-01', period_end: '2030-01-31', state: 'VIC' }); assert.ok(nu.error || nu.total_item_units === 140);
    await pool.query("DELETE FROM item_sales WHERE period_start='2030-01-01'");
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
    const r = await call('/api/login/verify', jp({ mobile: '0411 000 002', code })); assert.strictEqual(r.status, 200); assert.strictEqual(r.body.role, 'user'); tcookie = r.headers.get('set-cookie').split(';')[0]; assert.match(r.headers.get('set-cookie'), /Max-Age=2592000/);   // the browser keeps the cookie 30 days; each person's own length is checked on every request
    assert.strictEqual((await call('/api/stores', { headers: { cookie: tcookie } })).status, 200); assert.strictEqual((await call('/api/admin/loads', { headers: { cookie: tcookie } })).status, 401);
    assert.strictEqual((await call('/api/login/verify', jp({ mobile: '0411000002', code }))).status, 401); const s = await call('/api/session', { headers: { cookie: tcookie } }); assert.strictEqual(s.body.loggedIn, true); assert.strictEqual(s.body.role, 'user');
  });
  await t('session length is set per person: default 12 hours, shorter or longer per user, checked on every request; invalid values refused', async () => {
    const AU = require('../auth'); const real = Date.now; Date.now = () => real() - 2 * 3600e3; const old = 'c8s=' + AU.make('user', uB); Date.now = real;   // a sign-in made 2 hours ago
    const ok = async () => (await call('/api/stores', { headers: { cookie: old } })).status;
    assert.strictEqual(await ok(), 200);   // default 12 hours
    await pool.query('UPDATE app_users SET session_hours=1 WHERE id=$1', [uB]); AU.forget(uB); assert.strictEqual(await ok(), 401); assert.strictEqual((await call('/api/session', { headers: { cookie: old } })).body.loggedIn, false);
    await pool.query('UPDATE app_users SET session_hours=4 WHERE id=$1', [uB]); AU.forget(uB); assert.strictEqual(await ok(), 200);
    const adc = 'c8s=' + AU.make('admin', uA);   // a signed-in admin
    const pa = b => call('/api/admin/users/' + uB, { method: 'PATCH', headers: { cookie: adc, 'content-type': 'application/json' }, body: JSON.stringify(b) });
    assert.strictEqual((await pa({ session_hours: 0 })).status, 400); assert.strictEqual((await pa({ session_hours: 721 })).status, 400); assert.strictEqual((await pa({ session_hours: 24 })).status, 200);
    assert.strictEqual((await pool.query('SELECT session_hours FROM app_users WHERE id=$1', [uB])).rows[0].session_hours, 24); assert.strictEqual((await pa({ session_hours: null })).status, 200);
    assert.strictEqual((await pool.query('SELECT session_hours FROM app_users WHERE id=$1', [uB])).rows[0].session_hours, null);
    const lst = (await call('/api/admin/users', { headers: { cookie: adc } })).body; assert.strictEqual(lst.default_hours, 12); assert.strictEqual(lst.max_hours, 720);
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
  const MAILM = require('../mail'); let eA, eB, ecookie; const A_forget = () => require('../auth').forgetAll();
  await t('email addresses are normalised and validated', async () => { assert.strictEqual(MAILM.normaliseEmail('  Sam.D@Example.COM '), 'sam.d@example.com'); for (const b of ['', 'nope', 'a@b', 'a b@c.com', '<x>@y.com']) assert.strictEqual(MAILM.normaliseEmail(b), null, b); });
  await t('admin adds people by email; a user needs the right identifier for the delivery method', async () => {
    let r = await call('/api/admin/users', jp({ name: 'E Admin', email: 'Admin@Example.com', role: 'admin' }, adm)); assert.strictEqual(r.status, 200); eA = r.body.id;
    r = await call('/api/admin/users', jp({ name: 'E Director', email: 'dir@example.com' }, adm)); assert.strictEqual(r.status, 200); eB = r.body.id;
    assert.strictEqual((await call('/api/admin/users', jp({ name: 'Dup', email: 'DIR@example.com' }, adm))).status, 400); assert.strictEqual((await call('/api/admin/users', jp({ name: 'Bad', email: 'nope' }, adm))).status, 400); assert.strictEqual((await call('/api/admin/users', jp({ name: 'None' }, adm))).status, 400);
    const l = (await call('/api/admin/users', { headers: { cookie: adm } })).body.users; assert.ok(l.some(u => u.email === 'admin@example.com'));
  });
  // ---- monthly finance report: parse -> store -> derived cash flow (synthetic report text; the PDF reader itself is exercised with real files by hand) ----
  const FINL = require('../lib-finance'); const TOOLS = require('../tools');
  const finLines = ['Finance Board Report', 'Concept Eight Group', 'March 2031', 'Executive Summary', 'Profit and Loss Summary Mar 2031 Budget (Mar 2031) This month vs budget', 'Revenue $1,000 $900 $100 11.11%', 'Profit and Loss Commentary - Operating P&L', 'Royalties were ahead of budget.', 'Balance Sheet', 'Cash: At the end of March, the cash balance was $500', '',
    'PROFIT & LOSS Mar 2031 Budget Budget Variance This month vs Mar 2030 This month vs', 'Revenue', 'Total Revenue $1,000 $900 $100 11.11% $800 $200', 'Net Income $400 $350 $50 14.29% $300 $100', 'Dividends', 'Dividend $100 $100 $0 0.00% $90 $10', '',
    'PROFIT & LOSS 2030/2031 Budget (YTD) This year vs This year vs 2029/2030 This year vs last', 'Total Revenue $3,000 $2,700 $300 11.11% $2,400 $600', '',
    'BALANCE SHEET Mar 2031 Feb 2031 Variance ($) Variance (%) Mar 2030 This month vs', 'ASSETS', 'Cash & Equivalents', 'Cash at Bank', 'CBA Operating $500 $300 $200 66.67% $0 $500', 'Total Cash & Equivalents $500 $300 $200 66.67% $0 $500', 'Accounts Receivable', 'Trade Debtors $210 $100 $110 110.00% $0 $210', 'Total Accounts Receivable $210 $100 $110 110.00% $0 $210',
    'Fixed Assets', 'Computer Equipment $60 $50 $10 20.00% $0 $60', 'Total Fixed Assets $60 $50 $10 20.00% $0 $60', 'Total Assets $770 $450 $320 71.11% $0 $770', 'LIABILITIES', 'Accounts Payable', 'Trade Creditors $80 $50 $30 60.00% $0 $80', 'Total Accounts Payable $80 $50 $30 60.00% $0 $80',
    'Other Non-Current Liabilities', 'Bank Loan', 'CBA Loan Facility $190 $200 -$10 -5.00% $0 $190', 'Total Other Non-Current Liabilities $190 $200 -$10 -5.00% $0 $190', 'Total Liabilities $270 $250 $20 8.00% $0 $270', 'EQUITY', 'Retained Earnings', 'Retained Earnings $200 $200 $0 0.00% $0 $200', 'Current Earnings', 'Current Year Earnings $300 $0 $300 - $0 $300', 'Total Equity $500 $200 $300 150.00% $0 $500', 'Total Liabilities & Equity $770 $450 $320 71.11% $0 $770'];
  await t('finance: report text is parsed into month, YTD and balance sheet lines with the month found', async () => {
    const p = FINL.parseReport(finLines); assert.strictEqual(p.period, '2031-03-31'); assert.deepStrictEqual([p.counts.month, p.counts.ytd, p.counts.summary, p.counts.bs], [3, 1, 1, 16]); assert.ok(/Royalties were ahead/.test(p.commentary)); assert.strictEqual(p.assets, 770); assert.strictEqual(p.liab_equity, 770);
    assert.strictEqual(FINL.parseReport(['nothing useful here']).period, null);
  });
  await t('finance: load replaces the month; derived cash flow ties to the change in cash; tool answers', async () => {
    const p = FINL.parseReport(finLines); const c = await pool.connect();
    try { for (let i = 0; i < 2; i++) { await c.query('BEGIN'); const r = await FINL.commit(c, p, 'fin.pdf'); await c.query('COMMIT'); assert.strictEqual(r.replaced, i === 1); } } finally { c.release(); }
    assert.strictEqual((await pool.query("SELECT count(*) n FROM fin_reports WHERE period='2031-03-31'")).rows[0].n, '1'); assert.strictEqual((await pool.query("SELECT count(*) n FROM fin_bs WHERE period='2031-03-31'")).rows[0].n, '16');
    const cf = await TOOLS.run('finance', { action: 'cash_flow', month: '2031-03' });
    assert.strictEqual(cf.operating.operating_cash_flow, 320); assert.strictEqual(cf.free_cash_flow_before_dividend, 310); assert.strictEqual(cf.dividend, -100); assert.strictEqual(cf.financing[0].amount, -10); assert.strictEqual(cf.derived_net_movement, 200); assert.strictEqual(cf.actual_change_in_cash, 200); assert.strictEqual(cf.balance_sheet_out_of_balance_adjustment, 0); assert.strictEqual(cf.opening_cash, 300); assert.strictEqual(cf.net_bank_debt.net_bank_debt, -310);
    const ov = await TOOLS.run('finance', { action: 'overview' }); const om = ov.by_month.find(x => x.month === '2031-03'); assert.ok(om && om.revenue === 1000 && om.net_income === 400 && om.cash === 500 && om.net_bank_debt === -310);
    const mo = await TOOLS.run('finance', { action: 'month', month: '2031-03' }); assert.strictEqual(mo.net_bank_debt, -310); assert.ok(mo.months_held.includes('2031-03'));
    const tr = await TOOLS.run('finance', { action: 'trend', text: 'CBA Loan' }); assert.ok(tr.matches.some(m => m.series.some(x => x.month === '2031-03' && x.value === 190)));
    assert.ok((await TOOLS.run('finance', { action: 'commentary', month: '2031-03', text: 'royalties' })).commentary.includes('ahead of budget')); assert.ok((await TOOLS.run('finance', { action: 'cash_flow', month: '1999-01' })).error);
  });
  await t('finance: an out-of-balance report shows the gap as an adjustment, not a hidden error', async () => {
    const bad = finLines.map(l => l.startsWith('Total Assets') ? 'Total Assets $790 $450 $340 75.56% $0 $790' : l.replace('March 2031', 'April 2031').replace('Mar 2031', 'Apr 2031'));
    const bs = bad.map(l => l.startsWith('Computer Equipment') ? 'Computer Equipment $80 $50 $30 60.00% $0 $80' : l.startsWith('Total Fixed Assets') ? 'Total Fixed Assets $80 $50 $30 60.00% $0 $80' : l);
    const p = FINL.parseReport(bs); assert.strictEqual(p.period, '2031-04-30'); const c = await pool.connect();
    try { await c.query('BEGIN'); await FINL.commit(c, p, 'fin2.pdf'); await c.query('COMMIT'); } finally { c.release(); }
    const cf = await TOOLS.run('finance', { action: 'cash_flow', month: '2031-04' }); assert.strictEqual(cf.checks.assets_minus_liabilities_and_equity_this_month, 20); assert.strictEqual(cf.balance_sheet_out_of_balance_adjustment, 20); assert.strictEqual(cf.actual_change_in_cash, 200);
  });
  await t('finance: PDF upload routes are admin only and refuse files that are not PDFs', async () => {
    const asUser = await fetch(base + '/api/admin/finance/preview', { method: 'POST', headers: { cookie: ck, 'content-type': 'application/pdf' }, body: Buffer.from('%PDF-1.4 x') }); assert.strictEqual(asUser.status, 401);
    const bad = await fetch(base + '/api/admin/finance/preview', { method: 'POST', headers: { cookie: adm, 'content-type': 'application/pdf' }, body: Buffer.from('this is plainly not a pdf at all, just words '.repeat(5)) }); assert.strictEqual(bad.status, 400);
    const bad2 = await fetch(base + '/api/admin/finance/commit', { method: 'POST', headers: { cookie: adm, 'content-type': 'application/pdf' }, body: Buffer.from('nope') }); assert.strictEqual(bad2.status, 400);
  });
  await t('ask: the finance tool is offered to the model', async () => assert.ok(TOOLS.defs.some(d => d.name === 'finance')));
  // ---- board papers library ----
  const BRD = require('../lib-board');
  const miniPdf = (pageTexts) => { // smallest valid multi-page PDF with one line of text per page
    const objs = []; const n = pageTexts.length; objs.push('<< /Type /Catalog /Pages 2 0 R >>'); objs.push(`<< /Type /Pages /Kids [${pageTexts.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${n} >>`); objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    pageTexts.forEach((t, i) => { objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`); const st = `BT /F1 12 Tf 72 720 Td (${t}) Tj ET`; objs.push(`<< /Length ${st.length} >>\nstream\n${st}\nendstream`); });
    let out = '%PDF-1.4\n'; const offs = []; objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const x = out.length; out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`; return Buffer.from(out, 'latin1'); };
  await t('board papers: file names give the type and the month (financial year ends in June)', async () => {
    const g = n => BRD.guessMeta(n);
    assert.deepStrictEqual([g('C8 Board Pack - February FY25.pdf').doc_type, g('C8 Board Pack - February FY25.pdf').period], ['board_pack', '2025-02-01']);
    assert.strictEqual(g('C8 September FY26 Board Pack.pdf').period, '2025-09-01'); assert.strictEqual(g('C8 Finance Board Pack March FY23.pdf').period, '2023-03-01');
    const f = g('Finance Board Report - Concept Eight Group (Aug 2026).pdf'); assert.deepStrictEqual([f.doc_type, f.period], ['finance_board_report', '2026-08-01']);
    const m = g('C8 Board Meeting Minutes 20 June 2024.pdf'); assert.deepStrictEqual([m.doc_type, m.period, m.meeting_date], ['minutes', '2024-06-01', '2024-06-20']);
    assert.strictEqual(g('16 Apr 2026 Draft Agenda C8 April FY226 Board Meeting.pdf').meeting_date, '2026-04-16'); assert.strictEqual(g('random.pdf').doc_type, 'other');
  });
  let bid;
  await t('board papers: PDF upload is admin only and refuses non-PDFs', async () => {
    const pdf = miniPdf(['x']); const asUser = await fetch(base + '/api/admin/board/commit?name=a.pdf', { method: 'POST', headers: { cookie: ck, 'content-type': 'application/pdf' }, body: pdf }); assert.strictEqual(asUser.status, 401);
    assert.strictEqual((await fetch(base + '/api/admin/board/commit?name=a.pdf', { method: 'POST', headers: { cookie: adm, 'content-type': 'application/pdf' }, body: Buffer.from('nope') })).status, 400);
    assert.strictEqual((await fetch(base + '/api/admin/board', { headers: { cookie: ck } })).status, 401);
  });
  await t('board papers: load reads every page, Claude summary is stored, tool searches and points at the page and file', async () => {
    const pdf = miniPdf(['Board pack February. Revenue was ahead of budget for the month and every brand traded close to plan.', 'The Ingle Farm conversion is on track and the CBA loan was reduced.', 'Resolved: approve the Ingle Farm budget.']);
    const r = await fetch(base + '/api/admin/board/commit?name=' + encodeURIComponent('C8 Board Pack - February FY25.pdf'), { method: 'POST', headers: { cookie: adm, 'content-type': 'application/pdf' }, body: pdf }); const j = await r.json(); assert.strictEqual(r.status, 200, JSON.stringify(j));
    assert.strictEqual(j.pages, 3); assert.strictEqual(j.summarised, true); bid = j.id;
    const sm = await TOOLS.run('board_papers', { action: 'summary', doc_id: bid }); assert.strictEqual(sm.month, '2025-02'); assert.strictEqual(sm.type, 'Board pack'); assert.match(sm.summary, /Ingle Farm/); assert.strictEqual(sm.decisions[0].page, 3); assert.strictEqual(sm.file_name, 'C8 Board Pack - February FY25.pdf'); assert.ok(sm.kept_in.includes('Board Papers'));
    const se = await TOOLS.run('board_papers', { action: 'search', query: 'Ingle Farm conversion' }); assert.ok(se.matching_pages.some(p => p.page === 2 && /Ingle/.test(p.snippet) && p.file_name === 'C8 Board Pack - February FY25.pdf'), JSON.stringify(se)); assert.ok(se.matching_papers.length >= 1);
    assert.strictEqual((await TOOLS.run('board_papers', { action: 'search', query: 'Ingle Farm', month: '2024-01' })).matching_pages.length, 0);
    const ls = await TOOLS.run('board_papers', { action: 'list', month: '2025-02', type: 'board_pack' }); assert.strictEqual(ls.papers.length, 1);
    const ds = await TOOLS.run('data_status', {}); assert.strictEqual(ds.board_papers.papers, 1);
  });
  await t('board papers: reloading replaces the paper and keeps its link; summary can be made again; delete removes it', async () => {
    const link = 'https://www.dropbox.com/example'; assert.strictEqual((await (await fetch(base + '/api/admin/board/' + bid, { method: 'PATCH', headers: { cookie: adm, 'content-type': 'application/json' }, body: JSON.stringify({ link }) })).json()).ok, true);
    assert.strictEqual((await fetch(base + '/api/admin/board/' + bid, { method: 'PATCH', headers: { cookie: adm, 'content-type': 'application/json' }, body: JSON.stringify({ link: 'javascript:alert(1)' }) })).status, 400);
    const pdf = miniPdf(['Board pack February second version page one.', 'Page two of the second version has more words in it.', 'Page three closes the second version of the pack.']); const r = await (await fetch(base + '/api/admin/board/commit?name=' + encodeURIComponent('C8 Board Pack - February FY25.pdf') + '&summarise=0', { method: 'POST', headers: { cookie: adm, 'content-type': 'application/pdf' }, body: pdf })).json();
    const list = await (await fetch(base + '/api/admin/board', { headers: { cookie: adm } })).json(); assert.strictEqual(list.length, 1); assert.strictEqual(list[0].page_count, 3); assert.strictEqual(list[0].link, link); assert.strictEqual(list[0].summarised, false);
    assert.strictEqual((await TOOLS.run('board_papers', { action: 'summary', doc_id: r.id })).no_summary_reason, 'summary skipped');
    const rs = await (await fetch(base + '/api/admin/board/' + r.id + '/summarise', { method: 'POST', headers: { cookie: adm } })).json(); assert.strictEqual(rs.summarised, true, JSON.stringify(rs));
    assert.strictEqual((await TOOLS.run('board_papers', { action: 'summary', doc_id: r.id })).decisions.length, 1);
    await fetch(base + '/api/admin/board/' + r.id, { method: 'DELETE', headers: { cookie: adm } }); assert.ok((await TOOLS.run('board_papers', { action: 'list' })).error);
  });
  await t('board papers: a PDF with almost no text still loads (searchable only a little) but says why there is no summary', async () => {
    const r = await (await fetch(base + '/api/admin/board/commit?name=scan.pdf', { method: 'POST', headers: { cookie: adm, 'content-type': 'application/pdf' }, body: miniPdf(['.']) })).json(); assert.strictEqual(r.summarised, false); assert.match(r.summary_note, /almost no text/);
  });
  await t('board papers: a summaries file is admin only, bigger than the normal limit, stored by file name, used at PDF load instead of Claude, and updates papers already held', async () => {
    const post = (body, cookie) => fetch(base + '/api/admin/board/summaries', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const one = (text) => ({ title: 'Stored title', doc_type: 'finance_report', covers: 'March 2025', summary: text, key_points: [{ point: 'A stored point', page: 2 }, { point: '' }], decisions: [{ decision: 'A stored decision', page: 1 }], topics: ['Stored Topic'] });
    assert.strictEqual((await post({ 'x.pdf': one('x') }, ck)).status, 401);
    assert.strictEqual((await post([1], adm)).status, 400); assert.strictEqual((await post({}, adm)).status, 400);
    const big = { 'C8 Board Pack - March FY25.pdf': one('Stored summary text about the March pack.') }; for (let i = 0; i < 60; i++) big['Filler paper ' + i + '.pdf'] = one('f'.repeat(2000));
    const r1 = await post(big, adm); const j1 = await r1.json(); assert.strictEqual(r1.status, 200, JSON.stringify(j1)); assert.strictEqual(j1.stored, 61); assert.strictEqual(j1.applied_to_loaded_papers, 0); assert.strictEqual(j1.waiting_for_their_pdf, 61);
    const pdf = miniPdf(['Board pack March. Revenue was ahead of budget.', 'Page two has some words in it for the test.']);
    const lr = await (await fetch(base + '/api/admin/board/commit?name=' + encodeURIComponent('C8 Board Pack - March FY25.pdf'), { method: 'POST', headers: { cookie: adm, 'content-type': 'application/pdf' }, body: pdf })).json(); assert.strictEqual(lr.summarised, true);
    const sm = await TOOLS.run('board_papers', { action: 'summary', doc_id: lr.id }); assert.strictEqual(sm.summary, 'Stored summary text about the March pack.'); assert.strictEqual(sm.key_points.length, 1); assert.strictEqual(sm.key_points[0].page, 2); assert.strictEqual(sm.type, 'Board pack');
    assert.strictEqual((await pool.query('SELECT summarised_by FROM board_docs WHERE id=$1', [lr.id])).rows[0].summarised_by, 'stored summary file');
    const r2 = await (await post({ 'C8 Board Pack - March FY25.pdf': one('Updated stored summary.') }, adm)).json(); assert.strictEqual(r2.applied_to_loaded_papers, 1); assert.strictEqual(r2.waiting_for_their_pdf, 0);
    assert.strictEqual((await TOOLS.run('board_papers', { action: 'summary', doc_id: lr.id })).summary, 'Updated stored summary.');
    const r3 = await (await post({ 'bad.pdf': { title: 'no summary' } }, adm)).json(); assert.strictEqual(r3.stored, 0); assert.strictEqual(r3.skipped.length, 1);
    await pool.query('DELETE FROM board_summaries'); await pool.query('DELETE FROM board_docs');
  });
  await t('ask: the board_papers tool is offered to the model', async () => assert.ok(TOOLS.defs.some(d => d.name === 'board_papers')));

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
  await t('stores_by_opening: filters by years and reports reliability', async () => {
    const r = await TOOLS.run('stores_by_opening', { brand: 'Noodle Box', min_years: 5 });
    assert.ok(r.total_matching > 0 && r.stores.every(x => x.brand === 'Noodle Box' && new Date(x.opening_date) <= new Date(Date.now() - 5 * 365.25 * 864e5)));
    assert.ok('low_reliability_among_matching' in r && 'stores_with_no_date_on_record' in r);
  });
  await t('rank_stores_growth: no history -> nobody ranked; with a year of history -> ranked best first, newer stores excluded', async () => {
    const r0_ = await TOOLS.run('rank_stores_growth', { weeks: 4 });
    assert.ok(r0_.total_ranked === 0 && r0_.excluded_new_or_short_history > 0, 'nobody ranked without prior-year weeks');
    const ids = (await pool.query("SELECT id FROM stores WHERE name IN ('Hawthorn NBX','Altona')")).rows.map(x => x.id);
    const wks = (await pool.query("SELECT DISTINCT week_ending::text d FROM weekly_sales ORDER BY 1 DESC LIMIT 4")).rows.map(x => x.d);
    const added = [];
    for (const [k, id] of ids.entries()) for (const d of wks) { const cur = Number((await pool.query('SELECT sales FROM weekly_sales WHERE store_id=$1 AND week_ending=$2', [id, d])).rows[0].sales); await pool.query("INSERT INTO weekly_sales(store_id,week_ending,sales) VALUES ($1,$2::date-364,$3) ON CONFLICT DO NOTHING", [id, d, cur / (k ? 1.2 : 0.9)]); added.push([id, d]); }
    const r = await TOOLS.run('rank_stores_growth', { weeks: 4 });
    assert.strictEqual(r.total_ranked, 2); assert.ok(r.results[0].growth_pct >= r.results[1].growth_pct && r.results[0].growth_pct > 0 && r.results[1].growth_pct < 0, 'sorted best first');
    const b = await TOOLS.run('rank_stores_growth', { weeks: 4, order: 'bottom', limit: 1 }); assert.ok(b.results[0].growth_pct < 0);
    for (const [id, d] of added) await pool.query("DELETE FROM weekly_sales WHERE store_id=$1 AND week_ending=$2::date-364", [id, d]);
  });
  await t('weekly_trend: weekly totals, no LFL without a year of history; LFL once prior-year weeks exist; show_chart validates', async () => {
    const a = await TOOLS.run('weekly_trend', { weeks: 52 });
    assert.ok(a.weeks_returned >= 10 && a._chart && a._chart.series.length === 1 && a.weeks_with_lfl === 0 && /LFL cannot|cannot be calculated/.test(a.note));
    const st = (await pool.query("SELECT id FROM stores WHERE name='Hawthorn NBX'")).rows[0].id, wk = a.weeks[a.weeks.length - 1];
    await pool.query("INSERT INTO weekly_sales(store_id,week_ending,sales) VALUES ($1, $2::date-364, 1000) ON CONFLICT DO NOTHING", [st, wk.week_ending]);
    try {
      const b = await TOOLS.run('weekly_trend', { weeks: 4 }); const last = b.weeks.at(-1);
      assert.strictEqual(b.weeks_with_lfl, 1); assert.strictEqual(last.lfl_stores, 1); assert.strictEqual(last.lfl_prior_year_sales, 1000); assert.ok(last.lfl_growth_pct !== null && b._chart.series.length === 2);
    } finally { await pool.query("DELETE FROM weekly_sales WHERE store_id=$1 AND week_ending=$2::date-364", [st, wk.week_ending]); }
    const c = await TOOLS.run('show_chart', { type: 'bar', title: 'x', labels: ['a', 'b'], series: [{ name: 's', values: [1, 'z'] }] });
    assert.deepStrictEqual(c._chart.series[0].values, [1, null]); assert.ok((await TOOLS.run('show_chart', { type: 'bar', title: 'x', labels: [], series: [] })).error);
  });
  await t('company_lfl: Power BI weekly LFL % uploads (replaces by week) and weekly_trend uses it', async () => {
    const csv = 'week_ending,lfl_pct,scope,source\n2026-09-20,1.19,All,test\n2026-09-27,1.71,All,test\n2026-10-04,2.79,All,test\n2026-10-11,6.37,All,test\n2026-10-18,12.74,All,test\n';
    const hd = { cookie: adm, 'content-type': 'text/csv' };
    const an = await call('/api/admin/upload?name=lfl.csv&analyse=1', { method: 'POST', headers: hd, body: csv }).catch(() => null);
    const out = await require('../lib-data').detect(csv); assert.strictEqual(out, 'company_lfl');
    const c = await pool.connect(); try { await require('../lib-data').commit(c, 'company_lfl', csv, 'lfl.csv'); await require('../lib-data').commit(c, 'company_lfl', csv.replace('12.74', '12.80'), 'lfl.csv'); } finally { c.release(); }
    const r = await TOOLS.run('weekly_trend', { weeks: 52 });
    assert.strictEqual(r.weeks_returned, 5); assert.strictEqual(r.weeks.at(-1).lfl_growth_pct, 12.8); assert.strictEqual(r._chart.unit, '%'); assert.match(r.source, /Power BI/);
    assert.strictEqual((await pool.query("SELECT count(*)::int n FROM company_weekly")).rows[0].n, 5);
    await pool.query('DELETE FROM company_weekly');
  });
  await t('rank_stores: lists more than 25 stores and pages with offset, and says how many match', async () => {
    const all = await TOOLS.run('rank_stores', { limit: 100 }); assert.ok(all.total_matching > 25 && all.returned > 25 && all.returned === Math.min(100, all.total_matching));
    const p1 = await TOOLS.run('rank_stores', { limit: 30 }), p2 = await TOOLS.run('rank_stores', { limit: 30, offset: 30 });
    assert.strictEqual(p2.results[0].rank, 31); assert.strictEqual(p2.results[0].store_id, all.results[30].store_id); assert.match(p1.more_available, /offset 30/);
    assert.ok(new Set([...p1.results, ...p2.results].map(x => x.store_id)).size === 60);
  });
  await t('store agreements tool: one store, and what is ending soon; stores without details say so; finance area only', async () => {
    const id = (await pool.query("SELECT id FROM stores WHERE name='Hawthorn NBX'")).rows[0].id;
    await pool.query("UPDATE stores SET royalty_rate=0.06, fa_start='2018-07-04', fa_end=current_date + 90, lease_end=current_date - 30, landlord='Test Landlord', annual_rent='$52K' WHERE id=$1", [id]);
    const one = await TOOLS.run('store_agreements', { action: 'store', store_id: id }); assert.strictEqual(one.royalty_rate_pct, 6); assert.strictEqual(one.franchise_agreement.days_to_end, 90); assert.strictEqual(one.lease.landlord, 'Test Landlord');
    const ex = await TOOLS.run('store_agreements', { action: 'expiring', kind: 'fa', within_months: 6 }); assert.ok(ex.stores.some(s => s.store_id === id));
    const le = await TOOLS.run('store_agreements', { action: 'expiring', kind: 'lease', within_months: 1 }); assert.ok(le.stores.find(s => s.store_id === id).lease.days_to_end < 0);
    const other = (await pool.query("SELECT id FROM stores WHERE id<>$1 AND royalty_rate IS NULL AND fa_end IS NULL AND lease_end IS NULL AND abn IS NULL LIMIT 1", [id])).rows[0].id; assert.match((await TOOLS.run('store_agreements', { action: 'store', store_id: other })).note, /No franchise agreement/);
    assert.ok(TOOLS.defsFor(['finance']).some(d => d.name === 'store_agreements') && !TOOLS.defsFor(['sales', 'org']).some(d => d.name === 'store_agreements'));
    await pool.query("UPDATE stores SET royalty_rate=NULL, fa_start=NULL, fa_end=NULL, lease_end=NULL, landlord=NULL, annual_rent=NULL WHERE id=$1", [id]);
  });
  await t('a new address clears the map pin so it is found again, unless the pin was placed by hand', async () => {
    const [a1, a2] = (await pool.query("SELECT id FROM stores ORDER BY id LIMIT 2")).rows.map(r => r.id);
    await pool.query("UPDATE stores SET lat=-30, lng=140, geo_source='name', address='old' WHERE id=$1", [a1]); await pool.query("UPDATE stores SET lat=-31, lng=141, geo_source='manual', address='old' WHERE id=$1", [a2]);
    const nm = id => pool.query('SELECT name, brand FROM stores WHERE id=$1', [id]).then(r => r.rows[0]);
    const n1 = await nm(a1), n2 = await nm(a2); const csv = `site_name,brand,address\n${n1.name},${n1.brand},1 New Street\n${n2.name},${n2.brand},2 New Street\n`;
    const DD = require('../lib-data'), cc = await pool.connect(); try { await DD.commit(cc, 'store_details', csv, 'geo.csv'); } finally { cc.release(); }
    const r1 = (await pool.query('SELECT lat, address FROM stores WHERE id=$1', [a1])).rows[0], r2 = (await pool.query('SELECT lat, address FROM stores WHERE id=$1', [a2])).rows[0];
    assert.strictEqual(r1.address, '1 New Street'); assert.strictEqual(r1.lat, null); assert.strictEqual(r2.address, '2 New Street'); assert.strictEqual(r2.lat, -31);
  });
  await t('access classes: each class sees only its areas (windows, questions, tools, data_status, finance commentary and executive pay); admins see everything; new people start in Operations', async () => {
    const mk = async (email, cls) => { await pool.query("INSERT INTO app_users(name,email,role,access_class) VALUES ($1,$2,'user',$3)", ['T ' + cls, email, cls]); await call('/api/login/request', jp({ email })); const r = await call('/api/login/verify', jp({ email, code: mailCode() })); assert.strictEqual(r.status, 200); return r.headers.get('set-cookie').split(';')[0]; };
    const fin = await mk('fin@example.com', 'finance'), ops = await mk('ops@example.com', 'operations'), brd = await mk('brd@example.com', 'board');
    assert.deepStrictEqual((await call('/api/session', { headers: { cookie: fin } })).body.areas, ['sales', 'org', 'finance', 'manuals']);
    assert.strictEqual((await call('/api/stores', { headers: { cookie: ops } })).status, 200); assert.strictEqual((await call('/api/org', { headers: { cookie: ops } })).status, 200);
    // tools offered
    const names = a => TOOLS.defsFor(a).map(d => d.name);
    assert.ok(!names(['sales', 'org']).includes('finance') && !names(['sales', 'org']).includes('budget') && !names(['sales', 'org']).includes('board_papers') && names(['sales', 'org']).includes('data_status') && names(['sales', 'org']).includes('find_store'));
    assert.ok(names(['finance']).includes('finance') && !names(['finance']).includes('find_store') && !names(['finance']).includes('org_lookup'));
    assert.ok(!TOOLS.defsFor(['finance']).find(d => d.name === 'finance').input_schema.properties.action.enum.includes('commentary')); assert.ok(TOOLS.defsFor(['finance', 'finance_commentary']).find(d => d.name === 'finance').input_schema.properties.action.enum.includes('commentary'));
    // refusals at run time
    const FIN = { areas: ['sales', 'org', 'finance'] }, ALL = { areas: TOOLS.ALL_AREAS };
    assert.match((await TOOLS.run('board_papers', { action: 'list' }, FIN)).error, /outside/); assert.match((await TOOLS.run('budget', { action: 'overview' }, FIN)).error, /outside/); assert.match((await TOOLS.run('org_lookup', { action: 'vacancies' }, { areas: ['sales'] })).error, /outside/);
    assert.match((await TOOLS.run('finance', { action: 'commentary' }, FIN)).error, /commentary is outside/); assert.ok(!(await TOOLS.run('finance', { action: 'commentary', month: '2031-03' }, ALL)).error);
    // executive and director pay lines
    await pool.query("INSERT INTO fin_pl(period,kind,seq,line,actual,budget,ly) VALUES ('2031-03-31','month',999,'Director''s wages',34255,30000,30000)");
    const dw = o => JSON.stringify(o).includes('Director'); assert.ok(dw(await TOOLS.run('finance', { action: 'lines', text: 'director', month: '2031-03' }, ALL)));
    const hid = await TOOLS.run('finance', { action: 'lines', text: 'director', month: '2031-03' }, FIN); assert.ok(!dw(hid) || /outside your access/.test(hid.note || '')); assert.strictEqual(hid.lines.length, 0); assert.ok(!dw(await TOOLS.run('finance', { action: 'trend', text: 'director' }, FIN)));
    assert.ok((await TOOLS.run('finance', { action: 'lines', text: 'revenue', month: '2031-03' }, FIN)).lines.length > 0);   // ordinary lines still come through
    await pool.query("DELETE FROM fin_pl WHERE line='Director''s wages'");
    // data_status only describes what the person may use
    const dsF = await TOOLS.run('data_status', {}, FIN), dsO = await TOOLS.run('data_status', {}, { areas: ['sales', 'org'] }), dsA = await TOOLS.run('data_status', {}, ALL);
    assert.ok(dsF.finance_reports && !('board_papers' in dsF) && !('budget' in dsF)); assert.ok(!('finance_reports' in dsO) && !('board_papers' in dsO) && 'stores_by_brand' in dsO); assert.ok('board_papers' in dsA && 'finance_reports' in dsA);
    // a person with no sales area gets no store data
    assert.match((await TOOLS.run('find_store', { text: 'Hawthorn' }, { areas: ['finance'] })).error, /outside/);   // no sales area, no store data
    await pool.query("UPDATE access_classes SET areas=ARRAY['org'] WHERE code='operations'"); A_forget();
    assert.strictEqual((await call('/api/stores', { headers: { cookie: ops } })).status, 403); assert.strictEqual((await call('/api/directory', { headers: { cookie: ops } })).status, 403); assert.strictEqual((await call('/api/org', { headers: { cookie: ops } })).status, 200);
    await pool.query("UPDATE access_classes SET areas=ARRAY['sales','org'] WHERE code='operations'"); A_forget();
    // admin screen: change a class and a person's class; board class cannot be edited; unknown class refused
    const ad = (await call('/api/session', { headers: { cookie: brd } })).body; assert.strictEqual(ad.role, 'user');
    await call('/api/login/request', jp({ email: 'admin@example.com' })); const ar = await call('/api/login/verify', jp({ email: 'admin@example.com', code: mailCode() })); assert.strictEqual(ar.status, 200); const ac = ar.headers.get('set-cookie').split(';')[0];
    // operating manuals: loaded from a file, searchable by page, offered only with the manuals area
    const mf = JSON.stringify({ manuals: [{ title: 'TEST MANUAL v1', pages: { '1': 'Cleaning the fryer: drain the oil and scrub the basket.', '2': 'Hand washing must happen before every shift.' } }] });
    const mr = await fetch(base + '/api/admin/manuals', { method: 'POST', headers: { cookie: ac, 'content-type': 'application/json' }, body: mf }); const mj = await mr.json(); assert.strictEqual(mr.status, 200, JSON.stringify(mj)); assert.strictEqual(mj.pages, 2);
    const ms = await TOOLS.run('manuals', { action: 'search', query: 'fryer cleaning' }); assert.strictEqual(ms.matching_pages[0].page, 1); assert.strictEqual(ms.matching_pages[0].title, 'TEST MANUAL v1');
    const mp = await TOOLS.run('manuals', { action: 'page', doc_id: ms.matching_pages[0].doc_id, page: 2 }); assert.match(mp.text, /Hand washing/);
    assert.ok(TOOLS.defsFor(['manuals']).some(d => d.name === 'manuals') && !TOOLS.defsFor(['sales']).some(d => d.name === 'manuals'));
    assert.match((await TOOLS.run('manuals', { action: 'list' }, { areas: ['sales'] })).error, /outside/);
    // legal documents: a PDF is read into pages, searchable only through the legal tool and only with the legal area
    const lpages = ['Clause 18 Termination. The Franchisor may terminate this Agreement by written notice if the Franchisee', 'fails to remedy a breach within 14 days of notice. Clause 19 Renewal. The Franchisee may renew for', 'a further term of five years if it has given notice six months before expiry and is not in default.', 'Clause 20 Transfer. The Franchisee must not transfer this Agreement without the written consent of', 'the Franchisor. Clause 21 Insurance. The Franchisee must keep public liability insurance in force at', 'all times and provide a certificate of currency on request. Clause 22 Restraint applies after the term.'];
    const lr = await fetch(base + '/api/admin/legal?name=' + encodeURIComponent('Franchise Agreement 2026.pdf'), { method: 'POST', headers: { cookie: ac, 'content-type': 'application/pdf' }, body: miniPdf(lpages) }); const lj = await lr.json(); assert.strictEqual(lr.status, 200, JSON.stringify(lj)); assert.strictEqual(lj.pages, 6);
    const lse = await TOOLS.run('legal_documents', { action: 'search', query: 'termination notice breach' }); assert.strictEqual(lse.matching_pages[0].page, 1); assert.strictEqual(lse.matching_pages[0].title, 'Franchise Agreement 2026');
    assert.ok(!(await TOOLS.run('manuals', { action: 'list' })).manuals.some(m => /Franchise Agreement/.test(m.title)), 'legal docs must not appear in the manuals tool');
    assert.strictEqual((await TOOLS.run('manuals', { action: 'search', query: 'termination breach' })).matching_pages.length, 0);
    assert.ok(TOOLS.defsFor(['legal']).some(d => d.name === 'legal_documents') && !TOOLS.defsFor(['sales', 'manuals', 'finance']).some(d => d.name === 'legal_documents'));
    const lbad = await fetch(base + '/api/admin/legal?name=x', { method: 'POST', headers: { cookie: ac, 'content-type': 'application/pdf' }, body: miniPdf(['hi']) }); assert.strictEqual(lbad.status, 400);
    const tx = await fetch(base + '/api/admin/legal?name=' + encodeURIComponent('Scan.txt'), { method: 'POST', headers: { cookie: ac, 'content-type': 'text/plain' }, body: Buffer.from(lpages.join('\f') + '\f' + 'x'.repeat(10)) }); const txj = await tx.json(); assert.strictEqual(tx.status, 200, JSON.stringify(txj)); assert.strictEqual(txj.pages, 7);
    await pool.query("DELETE FROM manual_docs WHERE kind='legal'");
    await pool.query("DELETE FROM manual_docs WHERE title='TEST MANUAL v1'");
    const put = (code, areas) => call('/api/admin/access-classes/' + code, { method: 'PUT', headers: { cookie: ac, 'content-type': 'application/json' }, body: JSON.stringify({ areas }) });
    assert.strictEqual((await put('board', ['sales'])).status, 400); const pr = await put('finance', ['sales', 'exec_pay']); assert.strictEqual(pr.status, 200); assert.ok(pr.body.areas.includes('finance'));   // executive pay sits inside finance
    assert.ok((await call('/api/session', { headers: { cookie: fin } })).body.areas.includes('exec_pay')); await put('finance', ['sales', 'org', 'finance']);
    assert.strictEqual((await call('/api/admin/access-classes', { headers: { cookie: ops } })).status, 401);
    const list = (await call('/api/admin/users', { headers: { cookie: ac } })).body; assert.strictEqual(list.classes.length, 3); assert.ok(list.users.every(u => u.access_class));
    const uid = list.users.find(u => u.email === 'ops@example.com').id; const pa = (b) => call('/api/admin/users/' + uid, { method: 'PATCH', headers: { cookie: ac, 'content-type': 'application/json' }, body: JSON.stringify(b) });
    assert.strictEqual((await pa({ access_class: 'nonsense' })).status, 400); assert.strictEqual((await pa({ access_class: 'finance' })).status, 200); assert.ok((await call('/api/session', { headers: { cookie: ops } })).body.areas.includes('finance'));
    const nu = await call('/api/admin/users', { method: 'POST', headers: { cookie: ac, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'New Person', email: 'new@example.com' }) }); assert.strictEqual(nu.status, 200);
    assert.strictEqual((await pool.query('SELECT access_class FROM app_users WHERE id=$1', [nu.body.id])).rows[0].access_class, 'operations');
    assert.strictEqual((await call('/api/admin/users', { method: 'POST', headers: { cookie: ac, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'X', email: 'x@example.com', access_class: 'zzz' }) })).status, 400);
  });
  await t('sign-in record: every attempt is kept with what was typed (full address), the outcome and the address it came from; strangers are listed; admin only; CSV', async () => {
    await pool.query('DELETE FROM signin_log'); const bef = MAILM.sent.length;
    await call('/api/login/request', jp({ email: 'Stranger@Evil.example' })); await call('/api/login/request', jp({ email: 'not an address' })); await call('/api/login/verify', jp({ email: 'stranger@evil.example', code: '123456' }));
    await call('/api/login/request', jp({ email: 'admin@example.com' })); const ok = await call('/api/login/verify', jp({ email: 'admin@example.com', code: mailCode() })); assert.strictEqual(ok.status, 200); const ac = ok.headers.get('set-cookie').split(';')[0];
    await call('/api/login/verify', jp({ email: 'admin@example.com', code: '000000' }));
    assert.strictEqual(MAILM.sent.length, bef + 1);   // the stranger got no email
    const rows = (await pool.query('SELECT identifier, outcome, ip FROM signin_log ORDER BY id')).rows; const oc = rows.map(r => r.outcome);
    assert.deepStrictEqual(oc, ['unknown_user', 'bad_format', 'unknown_user_code', 'code_sent', 'signed_in', 'no_live_code']); assert.strictEqual(rows[0].identifier, 'stranger@evil.example'); assert.strictEqual(rows[1].identifier, 'not an address'); assert.ok(rows[0].ip);
    const all = await call('/api/admin/signins?strangers=0', { headers: { cookie: ac } }); assert.strictEqual(all.status, 200); assert.strictEqual(all.body.counts.total, 6); assert.strictEqual(all.body.counts.strangers, 3); assert.strictEqual(all.body.counts.ok, 1);
    const str = await call('/api/admin/signins?strangers=1', { headers: { cookie: ac } }); assert.strictEqual(str.body.rows.length, 3); assert.ok(str.body.rows.every(r => ['unknown_user', 'unknown_user_code', 'bad_format'].includes(r.outcome)));
    assert.strictEqual((await call('/api/admin/signins', { headers: { cookie: ecookie } })).status, 401); const csv = await fetch(base + '/api/admin/signins.csv', { headers: { cookie: ac } }); assert.strictEqual(csv.status, 200); assert.match(await csv.text(), /stranger@evil\.example/);
  });
  delete process.env.EMAIL_PROVIDER; await pool.query('DELETE FROM app_users');
  // cleanup so the test DB returns to its loaded state
  await pool.query("DELETE FROM stores WHERE id=$1", [newId]); await pool.query("DELETE FROM network_events WHERE event_type='TestEvent'");
  await pool.query("UPDATE stores SET opening_date=NULL, opening_date_source=NULL, opening_date_confidence=NULL WHERE name='Altona'"); await pool.query("UPDATE stores SET phone=$1 WHERE name='Hawthorn NBX'", [origPhone]);
  await pool.query('DELETE FROM fin_reports'); await pool.query('DELETE FROM board_docs'); await pool.query('DELETE FROM item_sales'); await pool.query('DELETE FROM budget_lines'); await pool.query('DELETE FROM budget_notes');
  console.log(pass + ' passed'); srv.close(); await pool.end();
})();
