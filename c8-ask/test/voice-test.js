const { chromium } = require('/opt/npm-tools/node_modules/playwright-core'); const assert = require('assert');
const OUT = '/tmp/claude-0/-home-claude/dbefbb01-4e63-51b5-9e7a-34930d8ac77a/scratchpad/org/'; let n = 0; const ok = m => console.log('ok  ', ++n, m);
const FAKE = () => {   // fake microphone + speaker: window.__say(text) "hears" a phrase; spoken texts are logged
  window.__spoken = []; window.__prints = 0; window.print = () => { window.__prints++; };
  let cur = null;
  window.SpeechRecognition = window.webkitSpeechRecognition = function () { const r = this; r.start = () => { cur = r; window.__listening = true; }; r.abort = r.stop = () => { if (cur === r) cur = null; window.__listening = false; r.onend && r.onend(); }; };
  window.__say = t => { const r = cur; if (!r) return false; cur = null; window.__listening = false; r.onresult({ results: [Object.assign([{ transcript: t }], { isFinal: true })] }); r.onend(); return true; };
  window.SpeechSynthesisUtterance = function (t) { this.text = t; };
  Object.defineProperty(window, 'speechSynthesis', { value: { getVoices: () => [], addEventListener() {}, cancel() {}, speak(u) { if (u.text.trim()) window.__spoken.push(u.text); u.onstart && u.onstart(); setTimeout(() => u.onend && u.onend(), 30); } }, configurable: true });
};
(async () => {
  const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] }); const errs = [];
  // ---- big screen: no auto speech, speaker button works, print works
  let ctx = await br.newContext({ viewport: { width: 1180, height: 820 } }); await ctx.addInitScript(FAKE); let pg = await ctx.newPage(); pg.on('pageerror', e => errs.push(e.message));
  await pg.goto('http://localhost:3111/'); await pg.fill('#pw', 'userpw'); await pg.click('#go'); await pg.waitForSelector('#foot', { state: 'visible' });
  assert.ok(!(await pg.isChecked('#speak'))); ok('big screen: read-aloud is off by default');
  assert.ok(await pg.locator('#printbtn').isDisabled()); ok('print button disabled until there is a reply');
  await pg.fill('#q', 'how did we go last week'); await pg.click('#send'); await pg.waitForSelector('.msg.bot .spk');
  assert.deepStrictEqual(await pg.evaluate(() => window.__spoken), []); ok('answer arrives silently');
  await pg.click('.msg.bot .spk'); assert.strictEqual((await pg.evaluate(() => window.__spoken)).length, 1); ok('🔊 button speaks that answer');
  await pg.waitForTimeout(100); assert.ok(await pg.locator('#printbtn').isEnabled()); await pg.click('#printbtn'); assert.strictEqual(await pg.evaluate(() => window.__prints), 1);
  const sheet = await pg.locator('#printsheet').innerText(); assert.match(sheet, /C8 Ask/); assert.match(sheet, /how did we go last week/); ok('print sheet holds question and answer: ' + sheet.replace(/\n+/g, ' / ').slice(0, 120));
  await pg.emulateMedia({ media: 'print' }); assert.ok(await pg.locator('#printsheet').isVisible() && await pg.locator('#foot').isHidden()); await pg.screenshot({ path: OUT + 'ui-print.png' }); await pg.emulateMedia({ media: 'screen' }); ok('print view shows only the sheet');
  await pg.check('#speak'); await pg.reload(); await pg.waitForSelector('#foot', { state: 'visible' }); assert.ok(await pg.isChecked('#speak')); ok('auto-read choice is remembered');
  await ctx.close();
  // ---- phone: auto speech on
  ctx = await br.newContext({ viewport: { width: 390, height: 780 } }); await ctx.addInitScript(FAKE); pg = await ctx.newPage();
  await pg.goto('http://localhost:3111/'); await pg.fill('#pw', 'userpw'); await pg.click('#go'); await pg.waitForSelector('#foot', { state: 'visible' });
  assert.ok(await pg.isChecked('#speak')); ok('narrow screen: read-aloud is on by default'); await ctx.close();
  // ---- voice window
  ctx = await br.newContext({ viewport: { width: 380, height: 520 } }); await ctx.addInitScript(FAKE); pg = await ctx.newPage(); pg.on('pageerror', e => errs.push(e.message));
  await pg.goto('http://localhost:3111/?voice=1'); await pg.fill('#pw', 'userpw'); await pg.click('#go'); await pg.waitForSelector('#voiceui', { state: 'visible' });
  assert.ok(await pg.locator('#foot').isHidden() && await pg.locator('#log').isHidden()); ok('?voice=1 shows only the voice window');
  const say = async t => { await pg.waitForFunction(() => window.__listening, null, { timeout: 4000 }); await pg.evaluate(t => window.__say(t), t); };
  const spoken = () => pg.evaluate(() => window.__spoken);
  await pg.click('#vmic'); await say('how did we go last week'); await pg.waitForFunction(() => window.__spoken.length >= 1 && window.__listening, null, { timeout: 5000 });
  assert.ok((await pg.locator('#vans').innerText()).length > 5); ok('question asked by voice, answer shown and spoken, then it listens again');
  const a1 = (await spoken())[0];
  await say('repeat'); await pg.waitForFunction(() => window.__spoken.length >= 2 && window.__listening); assert.strictEqual((await spoken())[1], a1); ok('"repeat" says the last answer again');
  await say('print that'); await pg.waitForFunction(() => window.__prints === 1 && window.__listening); ok('"print" prints the last answer');
  await say('new chat'); await pg.waitForFunction(() => window.__listening && window.__spoken.some(s => /new chat/i.test(s))); await say('repeat'); await pg.waitForFunction(() => window.__spoken.some(s => /nothing to repeat/i.test(s))); ok('"new chat" clears; repeat then has nothing');
  await pg.screenshot({ path: OUT + 'ui-voice.png' });
  await say('finish'); await pg.waitForFunction(() => !window.__listening); await pg.waitForTimeout(700); assert.match(await pg.locator('#vstatus').innerText(), /Finished/); ok('"finish" stops listening');
  assert.deepStrictEqual(errs, [], errs.join('|')); ok('no page errors'); await br.close(); console.log('VOICE PASS');
})().catch(e => { console.error('VOICE FAIL', e.message); process.exit(1); });
