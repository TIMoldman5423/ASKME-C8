// Drives the real sign-in page in a browser with email sign-in on (console provider). Needs the server running on :3111 with EMAIL_PROVIDER=console, ADMIN_EMAIL=admin@example.com, log in $SMSLOG.
const { chromium } = require('/opt/npm-tools/node_modules/playwright-core'); const assert = require('assert'); const fs = require('fs');
const code = () => { const m = [...fs.readFileSync(process.env.SMSLOG, 'utf8').matchAll(/code is (\d{6})/g)]; return m[m.length - 1][1]; };
(async () => {
  const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] }); const pg = await (await br.newContext({ viewport: { width: 400, height: 760 } })).newPage(); const errs = []; let n = 0; const ok = m => console.log('ok  ', ++n, m);
  pg.on('pageerror', e => errs.push(e.message));
  await pg.goto('http://localhost:3111/'); await pg.waitForSelector('#stepMobile', { state: 'visible' }); assert.ok(await pg.locator('#stepPw').isHidden()); ok('Code sign-in on: asks for an email address, no password box');
  await pg.fill('#mob', 'not-an-email'); await pg.click('#sendcode'); await pg.waitForFunction(() => document.querySelector('#loginerr').textContent.length > 0); assert.ok(await pg.locator('#stepCode').isHidden()); ok('bad address stays on step 1 with a message');
  await pg.fill('#mob', 'Admin@Example.com'); await pg.click('#sendcode'); await pg.waitForSelector('#stepCode', { state: 'visible' }); ok('code step shown');
  await pg.fill('#code', '000000'); await pg.click('#verify'); await pg.waitForFunction(() => /not right/.test(document.querySelector('#loginerr').textContent)); ok('wrong code shows a message');
  await pg.fill('#code', code()); await pg.click('#verify'); await pg.waitForSelector('#foot', { state: 'visible' }); ok('right code opens the app');
  await pg.goto('http://localhost:3111/admin'); await pg.waitForSelector('#main', { state: 'visible' }); await pg.click('[data-t=us]'); await pg.waitForSelector('#ulist table'); assert.match(await pg.textContent('#usnote'), /on/); ok('admin page: Users tab lists the first admin');
  await pg.fill('#un', 'Sam Director'); await pg.fill('#ue', 'sam@example.com'); await pg.click('#uadd'); await pg.waitForFunction(() => /Sam Director/.test(document.querySelector('#ulist').textContent)); ok('add a user');
  await pg.click('tr:has-text("Sam Director") button[data-uact]'); await pg.waitForFunction(() => /Switch on/.test(document.querySelector('#ulist').textContent)); ok('switch a user off');
  assert.deepStrictEqual(errs, []); ok('no page errors'); await br.close(); console.log('SMS UI PASS');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
