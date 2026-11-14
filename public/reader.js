// Board paper reader with private marks (v1.15). Classic script, loaded after the main page script (uses its $, api, say, add, state).
(function () {
  const css = `
#reader{position:fixed;left:0;right:0;top:0;bottom:var(--footh,130px);z-index:15;background:var(--bg);display:none;flex-direction:column}
#reader.show{display:flex}
#rhead,#rtools{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:6px 8px;border-bottom:1px solid var(--line);background:var(--card)}
#rhead select{flex:1 1 160px;min-width:0;min-height:40px}
#rhead button,#rtools button{min-height:40px;padding:0 10px;font-size:.85rem}
#rpage{font-size:.85rem;min-width:70px;text-align:center}
#rbody{flex:1;overflow:auto;padding:10px 6px 40px;background:var(--line);-webkit-overflow-scrolling:touch}
.rpg{position:relative;margin:0 auto 12px;background:#fff;box-shadow:0 1px 6px rgba(0,0,0,.25)}
.rpg canvas{display:block;width:100%;height:100%}
.rtext{position:absolute;left:0;top:0;right:0;bottom:0;overflow:hidden;line-height:1;opacity:.25}
.rtext span,.rtext br{color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0 0}
.rtext ::selection{background:rgba(0,80,255,.6)}
.rmarks{position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none}
.rm{position:absolute;pointer-events:none}
.rm.highlight{mix-blend-mode:multiply;opacity:.45}
.rm.yellow{background:#ffe600}.rm.green{background:#42d65c}.rm.amber{background:#ffbf00}.rm.orange{background:#ff9d2e}.rm.red{background:#ff4d4d}
.rm.circle{background:none!important;box-sizing:border-box;border:2.5px solid #e00;border-radius:12px}
.rm.circle.yellow{border-color:#e6c200}.rm.circle.green{border-color:#1fae3d}.rm.circle.amber{border-color:#f5a800}.rm.circle.orange{border-color:#ff7a00}.rm.circle.red{border-color:#e00}
.rm.underline{border-bottom:2px solid #d00}
.rm.strike{background:linear-gradient(transparent 46%,#d00 46%,#d00 56%,transparent 56%)}
.rpin{position:absolute;pointer-events:auto;min-width:26px;min-height:26px;padding:0 4px;border-radius:13px;border:1px solid #888;background:#fff8c4;color:#222;font-size:.75rem;line-height:24px;cursor:pointer;z-index:2}
.rpin.q{background:#ffd9d2;border-color:#d00}
#rsel{position:fixed;display:none;z-index:40;background:var(--card);border:1px solid var(--line);border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.35);padding:4px;gap:4px;flex-wrap:wrap;max-width:340px;user-select:none;-webkit-user-select:none}
#rsel button{min-height:40px;min-width:40px;padding:0 8px;font-size:.85rem}
#rsel .dot{width:34px;height:34px;border-radius:50%;border:2px solid #666;padding:0}#rsel .ring{width:34px;height:34px;border-radius:50%;background:none;padding:0;border-width:4px;border-style:solid}#rsel .ring.yellow{border-color:#e6c200}#rsel .ring.green{border-color:#1fae3d}#rsel .ring.amber{border-color:#f5a800}#rsel .ring.red{border-color:#e00}#rsel #rsent.on{background:#2b6cb0;color:#fff}
#rsel .dot.yellow{background:#ffe600}#rsel .dot.amber{background:#ffbf00}#rsel .dot.green{background:#42d65c}#rsel .dot.orange{background:#ff9d2e}#rsel .dot.red{background:#ff4d4d}
#rpop,#rsend{position:absolute;left:8px;right:8px;top:90px;z-index:30;background:var(--card);border:1px solid var(--line);border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,.35);padding:12px;display:none;flex-direction:column;gap:8px;max-height:75%;overflow:auto}
#rpop textarea{width:100%;min-height:90px;font:inherit;padding:8px;box-sizing:border-box}
#rpop .quote{font-size:.8rem;color:var(--mute);border-left:3px solid var(--line);padding-left:8px}
#rsend pre{white-space:pre-wrap;font:inherit;font-size:.85rem;background:var(--bg);padding:8px;border-radius:8px;margin:0}
#rpanel{position:absolute;right:0;top:92px;bottom:0;width:min(360px,100%);background:var(--card);border-left:1px solid var(--line);z-index:25;display:none;flex-direction:column}
#rpanel.show{display:flex}
#rlist{overflow:auto;flex:1}
.rli{padding:8px 10px;border-bottom:1px solid var(--line);font-size:.88rem}
.rli .rq{color:var(--mute);font-size:.78rem}
.rli button{min-height:34px;padding:0 8px;font-size:.78rem;margin-right:4px}
#rtoast{position:absolute;left:8px;right:8px;bottom:8px;z-index:35;background:#222;color:#fff;border-radius:10px;padding:8px 36px 8px 12px;font-size:.9rem;display:none;max-height:40%;overflow:auto;white-space:pre-wrap}
#rtoast button{position:absolute;right:4px;top:4px;min-height:30px;background:transparent;color:#fff;border:0}
#rpick{padding:10px}
#rpick button{display:block;width:100%;text-align:left;margin-bottom:6px;min-height:48px}
body.voice #reader{display:none!important}
@media (max-width:800px){body.reading #foot .pick,body.reading #foot .sub{display:none!important}}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  const el = (t, props = {}, kids = []) => { const e = document.createElement(t); Object.assign(e, props); for (const k of [].concat(kids)) e.append(k); return e; };
  const root = el('div', { id: 'reader', role: 'dialog', 'aria-label': 'Board paper reader' });
  root.innerHTML = `<div id="rhead"><button id="rclose" type="button">✕ Close</button><select id="rsel2" aria-label="Board paper"></select><button id="rprev" type="button" aria-label="Previous page">‹</button><span id="rpage"></span><button id="rnext" type="button" aria-label="Next page">›</button><button id="rzout" type="button" aria-label="Smaller">−</button><button id="rzin" type="button" aria-label="Larger">+</button></div>
<div id="rtools"><button id="rcom" type="button">💬 Comment on this page</button><button id="rqst" type="button">❓ Question on this page</button><button id="rmarks" type="button">📋 My remarks</button><button id="rsendbtn" type="button">✉ Send my questions</button></div>
<div id="rbody"></div><div id="rpick" style="display:none"></div>
<div id="rpanel"><div class="winhead" style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;border-bottom:1px solid var(--line)"><b>My remarks on this paper</b><label style="font-size:.8rem;display:flex;align-items:center;gap:4px"><input type="checkbox" id="rqonly"> Questions only</label><button id="rpx" type="button" aria-label="Close list">×</button></div><div id="rlist"></div></div>
<div id="rpop"><div class="quote" id="rpquote"></div><textarea id="rptext" placeholder="Type, or tap the microphone and speak…" aria-label="Comment"></textarea><div id="rpstat" aria-live="polite" style="font-size:.85rem;color:var(--mute,#666)"></div><div style="display:flex;gap:6px;flex-wrap:wrap"><button id="rpmic" type="button">🎤 Speak</button><label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="rpq"> This is a question</label><span style="flex:1"></span><button id="rpcancel" type="button">Cancel</button><button class="primary" id="rpsave" type="button">Save</button></div></div>
<div id="rsend"><b>Send my questions</b><label>To <select id="rsto"></select></label><pre id="rsprev"></pre><div style="display:flex;gap:6px;justify-content:flex-end"><button id="rscancel" type="button">Cancel</button><button id="rspreview" type="button">Preview</button><button class="primary" id="rsgo" type="button" disabled>Send</button></div></div>
<div id="rtoast"><span id="rtoasttxt"></span><button id="rtoastx" type="button" aria-label="Dismiss">×</button></div>`;
  document.body.append(root);
  const bar = el('div', { id: 'rsel' }); bar.innerHTML = ['yellow', 'green', 'amber', 'orange', 'red'].map(c => `<button class="dot ${c}" data-act="highlight" data-c="${c}" aria-label="Highlight ${c}"></button>`).join('') + '<button id="rsent" data-act="sentence" aria-pressed="false" aria-label="Apply to the whole sentence" title="Whole sentence: tap this, then a colour">¶ Sentence</button>' + ['green', 'amber', 'red', 'yellow'].map(c => `<button class="ring ${c}" data-act="circle" data-c="${c}" aria-label="Circle in ${c}"></button>`).join('') + '<button data-act="underline" aria-label="Underline"><u>U</u></button><button data-act="strike" aria-label="Strike through"><s>S</s></button><button data-act="comment" aria-label="Comment">💬</button><button data-act="question" aria-label="Question">❓</button>';
  document.body.append(bar);
  const $r = s => root.querySelector(s);

  let dictating = null, pdfjs = null, R = null, papersCache = [], pending = null, pendingSend = null;
  const NUMW = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
  const num = s => /^\d+$/.test(s) ? +s : NUMW[s] || null;
  const j = async (p, o) => { const r = await api(p, o); let b = null; try { b = await r.json(); } catch (e) {} if (!r.ok) throw new Error((b && b.error) || 'Something went wrong'); return b; };
  const jpost = (p, body, method = 'POST') => j(p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  function toast(t, sticky) { $r('#rtoasttxt').textContent = t; $r('#rtoast').style.display = 'block'; clearTimeout(toast.t); if (!sticky) toast.t = setTimeout(() => { $r('#rtoast').style.display = 'none'; }, 9000); }
  $r('#rtoastx').onclick = () => { $r('#rtoast').style.display = 'none'; };

  async function loadLib() {
    if (pdfjs) return pdfjs;
    await new Promise((ok, no) => { const s = document.createElement('script'); s.src = '/vendor/pdfjs/pdf.min.js'; s.onload = ok; s.onerror = () => no(new Error('Could not load the PDF viewer')); document.head.appendChild(s); });
    pdfjs = window.pdfjsLib || window['pdfjs-dist/build/pdf']; pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js'; return pdfjs;
  }
  function footHeight() { document.body.classList.add('reading'); const f = $('#foot'); document.documentElement.style.setProperty('--footh', (f ? f.offsetHeight : 130) + 'px'); }
  addEventListener('resize', () => { if (root.classList.contains('show')) footHeight(); });

  async function openList() {
    footHeight(); root.classList.add('show'); R = null; $r('#rbody').style.display = 'none'; $r('#rtools').style.display = 'none'; $r('#rpick').style.display = 'block'; $r('#rpage').textContent = '';
    try { papersCache = (await j('/api/board/papers')).papers; } catch (e) { $r('#rpick').textContent = e.message; return; }
    const sel = $r('#rsel2'); sel.innerHTML = '<option value="">Choose a paper…</option>' + papersCache.map(p => `<option value="${p.id}"${p.has_pdf ? '' : ' disabled'}>${esc2(label(p))}${p.has_pdf ? '' : ' (no reading copy yet)'}</option>`).join('');
    const box = $r('#rpick'); box.innerHTML = '';
    if (!papersCache.length) box.textContent = 'No board papers have been loaded yet.';
    if (papersCache.some(p => !p.has_pdf)) box.appendChild(el('p', { className: 'hint', style: 'margin:0 0 10px', textContent: 'Greyed-out papers were loaded before reading copies were kept, so they cannot open here yet. Load each one\'s PDF again (Admin → Board papers) and it will open here. Marks you already made on it are kept.' }));
    for (const p of papersCache) { const b = el('button', { type: 'button', textContent: label(p) + (p.has_pdf ? '' : '  (no reading copy yet)') + (p.marks ? '  · ' + p.marks + ' marks' : '') }); b.disabled = !p.has_pdf; b.onclick = () => openPaper(p.id); box.append(b); }
  }
  const esc2 = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const label = p => (p.title || p.file_name.replace(/\.pdf$/i, '')) + (p.month ? ' (' + p.month + ')' : '');

  async function openPaper(id) {
    footHeight(); root.classList.add('show'); $r('#rpick').style.display = 'none'; $r('#rbody').style.display = 'block'; $r('#rtools').style.display = 'flex';
    $r('#rsel2').value = String(id); $r('#rbody').innerHTML = '<div style="padding:20px">Opening…</div>';
    try {
      const lib = await loadLib(); const pdf = await lib.getDocument({ url: '/api/board/' + id + '/pdf', withCredentials: true }).promise;
      const mk = await j('/api/board/' + id + '/marks'); R = { id, pdf, marks: mk.marks, zoom: 1, page: 1, pages: [], cur: 1 };
      const p1 = await pdf.getPage(1); R.base = p1.getViewport({ scale: 1 }); layout();
    } catch (e) { const missing = e && (e.name === 'MissingPDFException' || /missing pdf|404/i.test(e.message || '')); $r('#rbody').textContent = missing ? 'There is no reading copy of this paper yet. It was loaded before reading copies were kept. Ask the administrator to load the PDF again (Admin, Board papers) and it will open here.' : (e.message || 'Could not open this paper.'); R = null; }
  }
  function scale() { const w = $r('#rbody').clientWidth - 12; return Math.max(0.3, Math.min(3, (w / R.base.width) * R.zoom)); }
  let io = null;
  function layout() {
    const body = $r('#rbody'); const keep = R.cur; body.innerHTML = ''; R.pages = []; if (io) io.disconnect();
    const sc = scale(); R.sc = sc; const W = R.base.width * sc, H = R.base.height * sc;
    io = new IntersectionObserver(es => { for (const e of es) { const p = R.pages[+e.target.dataset.n - 1]; if (e.isIntersecting) draw(p); else free(p); } }, { root: body, rootMargin: '900px 0px' });
    for (let n = 1; n <= R.pdf.numPages; n++) {
      const d = el('div', { className: 'rpg' }); d.dataset.n = n; d.style.width = W + 'px'; d.style.height = H + 'px';
      const cv = el('canvas'); const tl = el('div', { className: 'rtext' }); const ml = el('div', { className: 'rmarks' }); d.append(cv, tl, ml); body.append(d);
      R.pages.push({ n, d, cv, tl, ml, done: false }); io.observe(d);
    }
    drawMarks(); setCur(keep, true);
  }
  async function draw(p) {
    if (p.done || p.busy) return; p.busy = true;
    try {
      const page = await R.pdf.getPage(p.n); const vp = page.getViewport({ scale: R.sc }); const dpr = Math.min(2, devicePixelRatio || 1);
      p.cv.width = Math.floor(vp.width * dpr); p.cv.height = Math.floor(vp.height * dpr); p.d.style.width = vp.width + 'px'; p.d.style.height = vp.height + 'px';
      await page.render({ canvasContext: p.cv.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
      p.tl.innerHTML = ''; p.tl.style.setProperty('--scale-factor', R.sc); await pdfjs.renderTextLayer({ textContentSource: await page.getTextContent(), container: p.tl, viewport: vp, textDivs: [] }).promise;
      p.done = true;
    } catch (e) { /* page went away while drawing */ } finally { p.busy = false; }
  }
  function free(p) { if (!p.done) return; p.cv.width = 1; p.cv.height = 1; p.tl.innerHTML = ''; p.done = false; }
  function setCur(n, scroll) { n = Math.max(1, Math.min(R.pdf.numPages, n)); R.cur = n; $r('#rpage').textContent = n + ' / ' + R.pdf.numPages; if (scroll) R.pages[n - 1].d.scrollIntoView({ block: 'start' }); }
  $r('#rbody').addEventListener('scroll', () => { if (!R) return; const top = $r('#rbody').getBoundingClientRect().top; for (const p of R.pages) { const b = p.d.getBoundingClientRect(); if (b.bottom > top + 60) { if (R.cur !== p.n) { R.cur = p.n; $r('#rpage').textContent = p.n + ' / ' + R.pdf.numPages; } break; } } }, { passive: true });

  // ----- marks on the page -----
  const sorted = () => R.marks.slice().sort((a, b) => a.page - b.page || a.id - b.id);
  function drawMarks() {
    if (!R) return; for (const p of R.pages) p.ml.innerHTML = '';
    const idx = new Map(sorted().map((m, i) => [m.id, i + 1])); const stack = {};
    for (const m of R.marks) {
      const p = R.pages[m.page - 1]; if (!p) continue;
      for (const r of (m.kind === 'circle' ? circleBox(m.rects || []) : (m.rects || []))) { const d = el('div', { className: 'rm ' + m.kind + (m.color ? ' ' + m.color : '') }); Object.assign(d.style, { left: r[0] * 100 + '%', top: r[1] * 100 + '%', width: r[2] * 100 + '%', height: r[3] * 100 + '%' }); p.ml.append(d); }
      if (m.comment || m.question) {
        const r0 = (m.rects || [])[0]; const pin = el('button', { type: 'button', className: 'rpin' + (m.question ? ' q' : ''), textContent: (m.question ? '❓' : '💬') + idx.get(m.id) });
        if (r0) { pin.style.left = Math.min(94, (r0[0] + r0[2]) * 100) + '%'; pin.style.top = r0[1] * 100 + '%'; } else { const k = stack[m.page] = (stack[m.page] || 0) + 1; pin.style.right = '6px'; pin.style.top = (4 + (k - 1) * 30) + 'px'; }
        pin.onclick = () => editMark(m); p.ml.append(pin);
      }
    }
    renderList(idx);
  }
  function renderList(idx) {
    const L = $r('#rlist'); L.innerHTML = ''; $r('#rmarks').textContent = '📋 My remarks (' + R.marks.length + ')';
    if (!R.marks.length) { L.append(el('div', { className: 'rli', textContent: 'You have no remarks on this paper yet. Select some text to highlight it, or use the buttons above.' })); return; }
    const only = $r('#rqonly').checked; const shown = sorted().filter(m => !only || m.question); if (only && !shown.length) L.append(el('div', { className: 'rli', textContent: 'You have not marked any questions on this paper yet.' }));
    for (const m of shown) {
      const row = el('div', { className: 'rli' }); const n = idx.get(m.id);
      row.append(el('div', { textContent: n + '. Page ' + m.page + ' · ' + ({ highlight: 'Highlight', underline: 'Underline', strike: 'Strike', circle: 'Circle', comment: 'Comment' }[m.kind]) + (m.question ? ' · QUESTION' : '') }));
      if (m.quote) row.append(el('div', { className: 'rq', textContent: '“' + m.quote.slice(0, 140) + '”' }));
      if (m.comment) row.append(el('div', { textContent: m.comment }));
      const go = el('button', { type: 'button', textContent: 'Go to' }); go.onclick = () => { setCur(m.page, true); if (innerWidth < 800) $r('#rpanel').classList.remove('show'); };
      const ed = el('button', { type: 'button', textContent: m.comment || m.question ? 'Edit' : 'Add comment' }); ed.onclick = () => editMark(m);
      const dl = el('button', { type: 'button', textContent: 'Delete' }); dl.onclick = () => removeMark(m);
      row.append(go, ed, dl); L.append(row);
    }
  }
  $r('#rqonly').onchange = () => { if (R) drawMarks(); }; $r('#rmarks').onclick = () => $r('#rpanel').classList.toggle('show'); $r('#rpx').onclick = () => $r('#rpanel').classList.remove('show');
  function circleBox(rs) { if (!rs.length) return []; const x0 = Math.min(...rs.map(r => r[0])), y0 = Math.min(...rs.map(r => r[1])), x1 = Math.max(...rs.map(r => r[0] + r[2])), y1 = Math.max(...rs.map(r => r[1] + r[3])); return [[Math.max(0, x0 - 0.006), Math.max(0, y0 - 0.004), Math.min(1, x1 - x0 + 0.012), Math.min(1, y1 - y0 + 0.008)]]; }
  async function addMark(m) { const r = await jpost('/api/board/' + R.id + '/marks', m); R.marks.push({ id: r.id, page: m.page, kind: m.kind, color: m.color || (m.kind === 'highlight' ? 'yellow' : m.kind === 'circle' ? 'red' : null), question: !!m.question, rects: m.rects || [], quote: m.quote || '', comment: m.comment || '' }); drawMarks(); return r.id; }
  async function removeMark(m) { await j('/api/board/marks/' + m.id, { method: 'DELETE' }); R.marks = R.marks.filter(x => x.id !== m.id); drawMarks(); }

  // ----- comment box (typed or spoken) -----
  let popDone = null;
  function ask2(opts) {
    return new Promise(res => {
      $r('#rpquote').textContent = opts.quote ? '“' + opts.quote.slice(0, 160) + '”' : opts.title || ''; $r('#rptext').value = opts.text || ''; $r('#rpq').checked = !!opts.question; $r('#rpop').style.display = 'flex'; $r('#rptext').focus();
      popDone = v => { $r('#rpop').style.display = 'none'; popDone = null; res(v); };
    });
  }
  $r('#rpcancel').onclick = () => popDone && popDone(null);
  $r('#rpsave').onclick = () => popDone && popDone({ text: $r('#rptext').value.trim(), question: $r('#rpq').checked });
  $r('#rpmic').onclick = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition; if (!SR) { toast('Speech input is not available in this browser. Type the comment instead.'); return; }
    if (dictating) { try { dictating.stop(); } catch (e) {} return; }
    const stat = m => { $r('#rpstat').textContent = m; };
    const r = new SR(); dictating = r; r.lang = 'en-AU'; r.interimResults = true; r.continuous = false;
    const ta = $r('#rptext'), base = ta.value ? ta.value + ' ' : ''; let heard = false, failed = false;
    r.onresult = e => { heard = true; ta.value = base + Array.from(e.results).map(x => x[0].transcript).join(' ').trim(); };
    r.onerror = e => { if (e.error !== 'aborted') { failed = true; stat((window.speechErrText ? speechErrText(e.error) : 'Speech input did not work (' + e.error + ').')); } };
    r.onend = () => { dictating = null; $r('#rpmic').textContent = '🎤 Speak'; if (!heard && !failed) stat(window.speechErrText ? speechErrText('no-speech') : 'I did not hear anything.'); else if (heard) stat('Done. Tap the microphone again to add more.'); };
    try { r.start(); $r('#rpmic').textContent = '⏹ Stop'; stat('Listening… speak now.'); } catch (e) { dictating = null; stat('The microphone could not start. Tap it again; if that fails, reload the page.'); }
  };
  async function editMark(m) {
    const v = await ask2({ quote: m.quote, title: 'Page ' + m.page, text: m.comment, question: m.question }); if (!v) return;
    if (!v.text && m.kind === 'comment') { toast('A comment needs some words. Use Delete to remove it.'); return; }
    await jpost('/api/board/marks/' + m.id, { comment: v.text, question: v.question }, 'PATCH'); m.comment = v.text; m.question = v.question; drawMarks();
  }
  async function pageComment(question) {
    const v = await ask2({ title: 'Page ' + R.cur, question }); if (!v || !v.text) return;
    await addMark({ page: R.cur, kind: 'comment', comment: v.text, question: v.question }); toast((v.question ? 'Question' : 'Comment') + ' saved on page ' + R.cur + '.');
  }
  $r('#rcom').onclick = () => pageComment(false); $r('#rqst').onclick = () => pageComment(true);

  // ----- selecting text -----
  function norm1(r, pr) { return [(r.left - pr.left) / pr.width, (r.top - pr.top) / pr.height, r.width / pr.width, r.height / pr.height]; }
  document.addEventListener('selectionchange', () => {
    clearTimeout(selT); selT = setTimeout(() => {
      if (!R || !root.classList.contains('show')) { bar.style.display = 'none'; return; }
      const s = getSelection(); if (!s || s.isCollapsed || !s.rangeCount) { if (!bar.contains(document.activeElement)) { bar.style.display = 'none'; } return; }
      const rg = s.getRangeAt(0); const node = rg.commonAncestorContainer.nodeType === 1 ? rg.commonAncestorContainer : rg.commonAncestorContainer.parentElement; const pg = node && node.closest && node.closest('.rpg'); if (!pg) { bar.style.display = 'none'; return; }
      const pr = pg.getBoundingClientRect(); const rects = Array.from(rg.getClientRects()).filter(r => r.width > 2 && r.height > 2).map(r => norm1(r, pr));
      const quote = s.toString().replace(/\s+/g, ' ').trim(); if (!rects.length || !quote) { bar.style.display = 'none'; return; }
      pending = { page: +pg.dataset.n, rects: rects.slice(0, 60), quote }; const last = rg.getClientRects(); const lr = last[last.length - 1];
      bar.style.display = 'flex'; bar.style.left = Math.max(6, Math.min(innerWidth - 300, lr.left)) + 'px'; bar.style.top = Math.min(innerHeight - 110, lr.bottom + 8) + 'px';
    }, 180);
  });
  let selT = null, sentMode = false;
  bar.addEventListener('pointerdown', e => e.preventDefault());
  bar.addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b || !pending) return; let p = pending; const act = b.dataset.act;
    if (act === 'sentence') { sentMode = !sentMode; b.classList.toggle('on', sentMode); b.setAttribute('aria-pressed', sentMode ? 'true' : 'false'); return; }
    bar.style.display = 'none'; getSelection().removeAllRanges(); pending = null;
    try {
      if (sentMode) { sentMode = false; const sb = bar.querySelector('#rsent'); if (sb) { sb.classList.remove('on'); sb.setAttribute('aria-pressed', 'false'); } const sn = await sentenceAround(p.page, p.quote); const f = sn && await locate(p.page, sn); if (f) p = { page: p.page, rects: f.rects, quote: f.quote }; else toast('Could not find the whole sentence; marked your selection instead.'); }
      if (act === 'highlight') await addMark({ ...p, kind: 'highlight', color: b.dataset.c });
      else if (act === 'circle') await addMark({ ...p, kind: 'circle', color: b.dataset.c });
      else if (act === 'underline' || act === 'strike') await addMark({ ...p, kind: act });
      else { const v = await ask2({ quote: p.quote, question: act === 'question' }); if (!v) return; await addMark({ ...p, kind: 'highlight', color: act === 'question' ? 'orange' : 'yellow', comment: v.text, question: v.question }); }
    } catch (err) { toast(err.message); }
  });

  // ----- finding words on a page (for spoken marks) -----
  const nz = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  async function locate(pageNum, quote) {
    const page = await R.pdf.getPage(pageNum); const vp = page.getViewport({ scale: 1 }); const tc = await page.getTextContent();
    let s = '', map = []; tc.items.forEach((it, ix) => { if (!it.str) return; for (let k = 0; k < it.str.length; k++) { s += it.str[k]; map.push([ix, k]); } s += ' '; map.push([ix, -1]); });
    let ns = '', idx = []; let prevSp = true; for (let i = 0; i < s.length; i++) { const c = nz(s[i]); if (c === ' ') { if (!prevSp) { ns += ' '; idx.push(i); prevSp = true; } } else { ns += c; idx.push(i); prevSp = false; } }
    const nq = nz(quote).replace(/^ +| +$/g, ''); if (nq.length < 2) return null; const at = ns.indexOf(nq); if (at < 0) return null;
    const a = idx[at], b = idx[at + nq.length - 1]; const per = new Map();
    for (let i = a; i <= b; i++) { const [ix, k] = map[i]; if (k < 0) continue; const o = per.get(ix) || [k, k]; o[1] = k; per.set(ix, o); }
    const rects = [];
    for (const [ix, [k0, k1]] of per) {
      const it = tc.items[ix]; const tr = pdfjs.Util.transform(vp.transform, it.transform); const len = it.str.length || 1; const w = it.width * vp.scale; const fh = Math.hypot(tr[2], tr[3]) || it.height;
      // share of the line's width taken by the words before and inside the match, measured in the same font (letters differ in width)
      const cx = locate.cx || (locate.cx = document.createElement('canvas').getContext('2d')); const fam = (tc.styles[it.fontName] || {}).fontFamily || 'sans-serif'; cx.font = '100px ' + fam;
      const full = cx.measureText(it.str).width || len, pre = cx.measureText(it.str.slice(0, k0)).width, mid = cx.measureText(it.str.slice(k0, k1 + 1)).width;
      rects.push([(tr[4] + w * (pre / full)) / vp.width, (tr[5] - fh * 0.92) / vp.height, Math.max(0.004, w * (mid / full) / vp.width), (fh * 1.15) / vp.height]);
    }
    return { rects: rects.slice(0, 60), quote: s.slice(a, b + 1).replace(/\s+/g, ' ').trim() };
  }

  // the whole sentence around some words on a page (text only; locate() then finds where it sits)
  async function sentenceAround(pageNum, quote) {
    const page = await R.pdf.getPage(pageNum); const tc = await page.getTextContent(); const s = tc.items.map(i => i.str).join(' ').replace(/\s+/g, ' ');
    let ns = '', idx = []; for (let i = 0; i < s.length; i++) { const c = s[i].toLowerCase(); if (/[a-z0-9]/.test(c)) { ns += c; idx.push(i); } }
    const nq = String(quote).toLowerCase().replace(/[^a-z0-9]/g, ''); if (nq.length < 2) return null; const at = ns.indexOf(nq); if (at < 0) return null;
    const a = idx[at], b = idx[at + nq.length - 1]; let st = 0, en = s.length;
    const re = /[.?!](?=\s|$)/g; let mm; while ((mm = re.exec(s))) { if (mm.index < a) st = mm.index + 1; else if (mm.index >= b) { en = mm.index + 1; break; } }
    const out = s.slice(st, en).trim(); return out.length >= 3 && out.length <= 700 ? out : null;
  }

  // ----- typed or spoken commands while a paper is open -----
  const KIND = { highlight: 'highlight', colour: 'highlight', color: 'highlight', circle: 'circle', box: 'circle', ring: 'circle', encircle: 'circle', underline: 'underline', strike: 'strike', strikeout: 'strike', strikethrough: 'strike', crossout: 'strike' };
  function findPaper(words) {
    const toks = nz(words).split(' ').filter(w => w.length >= 3 && !['the', 'board', 'paper', 'papers', 'pack', 'for', 'and'].includes(w)); if (!toks.length) return null;
    const MON = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    let best = null, bs = 0; for (const p of papersCache) { const hay = nz(label(p) + ' ' + (p.doc_type || '') + ' ' + (p.month ? MON[+p.month.slice(5, 7) - 1] + ' ' + p.month.slice(0, 4) : '')); const sc = toks.filter(t => hay.includes(t)).length; if (sc > bs) { bs = sc; best = p; } }
    return bs ? best : null;
  }
  async function command(text) {
    let t = nz(text).trim().replace(/^please /, ''); let m;
    if (!papersCache.length) { try { papersCache = (await j('/api/board/papers')).papers; } catch (e) { return null; } }
    if ((m = /^open (.+)$/.exec(t)) && !/^(my|the) (notes|reminders)/.test(m[1])) { const p = findPaper(m[1]); if (!p) return null; if (!p.has_pdf) return 'There is no reading copy of ' + label(p) + ' yet. Ask the administrator to load the PDF again.'; await openPaper(p.id); return 'Opened ' + label(p) + '.'; }
    if (/^(list|read) (the )?board papers$/.test(t)) return papersCache.length ? papersCache.map((p, i) => (i + 1) + ', ' + label(p)).join('. ') : 'No board papers are loaded.';
    if (!R || !root.classList.contains('show')) return null;
    if (/^close (the )?(paper|reader)$/.test(t)) { close(); return 'Closed.'; }
    if ((m = /^(?:go to |turn to |show )?page (\d+|[a-z]+)$/.exec(t)) && num(m[1])) { const n = num(m[1]); if (n < 1 || n > R.pdf.numPages) return 'This paper has ' + R.pdf.numPages + ' pages.'; setCur(n, true); return 'Page ' + n + '.'; }
    if (/^next page$/.test(t)) { setCur(R.cur + 1, true); return 'Page ' + R.cur + '.'; } if (/^(previous|back) page$/.test(t)) { setCur(R.cur - 1, true); return 'Page ' + R.cur + '.'; }
    if ((m = /^(?:add (?:a |an )?)?(comment|question)(?: (?:on|for|at))? page (\d+|[a-z]+)\s*(.*)$/.exec(t)) && num(m[2]) && m[3]) { const n = num(m[2]); if (n < 1 || n > R.pdf.numPages) return 'This paper has ' + R.pdf.numPages + ' pages.'; await addMark({ page: n, kind: 'comment', comment: String(text).replace(/^\s*(?:please\s+)?(?:add (?:a |an )?)?(?:comment|question)(?: (?:on|for|at))? page \S+[\s:,\-]*/i, '').trim() || m[3], question: m[1] === 'question' }); return (m[1] === 'question' ? 'Question' : 'Comment') + ' saved on page ' + n + '.'; }
    if ((m = /^(?:add (?:a |an )?)?(comment|question)\s+(?!on page|for page|at page)(.+)$/.exec(t))) { await addMark({ page: R.cur, kind: 'comment', comment: String(text).replace(/^\s*(?:please\s+)?(?:add (?:a |an )?)?(?:comment|question)[\s:,\-]*/i, '').trim() || m[2], question: m[1] === 'question' }); return (m[1] === 'question' ? 'Question' : 'Comment') + ' saved on page ' + R.cur + '.'; }
    if ((m = /^(highlight|colour|color|encircle|circle|box|ring|underline|strike out|strikeout|strike through|strikethrough|strike|cross out)(?: in)?(?: (yellow|green|amber|orange|red))?\s+(.+?)(?: on page (\d+|[a-z]+))?$/.exec(t))) {
      const kind = KIND[m[1].replace(/ /g, '')] || 'strike'; let quote = m[3], colour = m[2];
      const tail = /^(.*?)(?: in)? (yellow|green|amber|orange|red)$/.exec(quote); if (tail && tail[1]) { quote = tail[1]; colour = colour || tail[2]; }
      const sen = /^(?:the |this )?(?:whole )?sentence(?: (?:containing|with|that says|that has|including|about|starting with|beginning with))?\s+(.+)$/.exec(quote); if (sen) quote = sen[1];
      const pgs = m[4] && num(m[4]) ? [num(m[4])] : [R.cur].concat(Array.from({ length: R.pdf.numPages }, (_, i) => i + 1).filter(n => n !== R.cur));
      for (const n of pgs) { if (n < 1 || n > R.pdf.numPages) return 'This paper has ' + R.pdf.numPages + ' pages.'; let target = quote; if (sen) { const sn = await sentenceAround(n, quote); if (!sn) continue; target = sn; } const f = await locate(n, target); if (f) { await addMark({ page: n, kind, color: colour || (kind === 'highlight' ? 'yellow' : kind === 'circle' ? 'red' : null), rects: f.rects, quote: f.quote }); setCur(n, true); return (kind === 'highlight' ? 'Highlighted' : kind === 'circle' ? 'Circled' : kind === 'underline' ? 'Underlined' : 'Struck out') + (sen ? ' the sentence' : '') + ' on page ' + n + ': ' + f.quote.slice(0, 80) + '.'; } }
      return 'I could not find “' + quote + '” ' + (m[4] ? 'on page ' + num(m[4]) : 'in this paper') + '. Say a few exact words from the page.';
    }
    if ((m = /^(?:list|read)(?: out)?(?: all)? my (questions|comments|marks|remarks|highlights)(?: on this paper)?$/.exec(t))) {
      const ms = sorted(); const idx = new Map(ms.map((x, i) => [x.id, i + 1])); const sel = ms.filter(x => m[1] === 'questions' ? x.question : m[1] === 'comments' ? x.comment : m[1] === 'highlights' ? x.kind === 'highlight' : true);
      return sel.length ? sel.map(x => idx.get(x.id) + ', page ' + x.page + ', ' + (x.question ? 'question, ' : '') + (x.comment || (x.quote ? '“' + x.quote.slice(0, 60) + '”' : x.kind)) + '.').join(' ') : 'You have no ' + m[1] + ' on this paper.';
    }
    if ((m = /^delete (?:my )?(?:question|comment|mark|remark|highlight|underline) (?:number )?(\d+|[a-z]+)$/.exec(t)) && num(m[1])) { const x = sorted()[num(m[1]) - 1]; if (!x) return 'There is no remark number ' + num(m[1]) + '.'; await removeMark(x); return 'Deleted remark ' + num(m[1]) + ' on page ' + x.page + '. The numbers have changed.'; }
    if ((m = /^send my questions(?: to (.+))?$/.exec(t))) { await openSend(m[1]); return pendingSend ? 'Ready to send ' + pendingSend.count + (pendingSend.count === 1 ? ' question' : ' questions') + ' to ' + pendingSend.to + '. Say confirm send, or press Send.' : 'Choose who to send them to.'; }
    if (/^confirm send$/.test(t)) { if (!pendingSend) return 'There is nothing waiting to send. Say send my questions to a name first.'; return await doSend(); }
    return null;
  }

  // ----- sending my questions -----
  async function openSend(whoWords) {
    const people = (await j('/api/board/recipients')).people; const sel = $r('#rsto'); sel.innerHTML = people.map(p => `<option value="${p.id}">${esc2(p.name)}${p.you ? ' (me)' : ''}</option>`).join('');
    $r('#rsend').style.display = 'flex'; $r('#rsprev').textContent = ''; $r('#rsgo').disabled = true; pendingSend = null;
    if (whoWords) { const w = nz(whoWords).trim(); const hit = people.find(p => nz(p.name).includes(w) || w.includes(nz(p.name).split(' ')[0])) || (/^(me|myself)$/.test(w) ? people.find(p => p.you) : null); if (hit) { sel.value = String(hit.id); await preview(); } else toast('I could not find “' + whoWords + '” among the people who can receive them. Choose from the list.'); }
  }
  async function preview() {
    try { const r = await jpost('/api/board/' + R.id + '/questions', { to: +$r('#rsto').value, send: false }); $r('#rsprev').textContent = 'Subject: ' + r.subject + '\n\n' + r.text; $r('#rsgo').disabled = false; pendingSend = { to: r.to, count: r.count, id: +$r('#rsto').value }; }
    catch (e) { $r('#rsprev').textContent = e.message; $r('#rsgo').disabled = true; pendingSend = null; }
  }
  async function doSend() { try { const r = await jpost('/api/board/' + R.id + '/questions', { to: pendingSend.id, send: true }); $r('#rsend').style.display = 'none'; pendingSend = null; const msg = 'Sent ' + r.count + (r.count === 1 ? ' question' : ' questions') + ' to ' + r.to + '.'; toast(msg); return msg; } catch (e) { return e.message; } }
  $r('#rsendbtn').onclick = () => openSend(); $r('#rspreview').onclick = preview; $r('#rsgo').onclick = async () => { const m = await doSend(); toast(m); }; $r('#rscancel').onclick = () => { $r('#rsend').style.display = 'none'; pendingSend = null; };
  $r('#rsto').onchange = () => { $r('#rsgo').disabled = true; pendingSend = null; };

  // ----- header controls -----
  function close() { document.body.classList.remove('reading'); root.classList.remove('show'); bar.style.display = 'none'; $r('#rpanel').classList.remove('show'); $r('#rpop').style.display = 'none'; $r('#rsend').style.display = 'none'; R = null; $r('#rbody').innerHTML = ''; }
  $r('#rclose').onclick = close;
  $r('#rsel2').onchange = e => { if (e.target.value) openPaper(+e.target.value); };
  $r('#rprev').onclick = () => R && setCur(R.cur - 1, true); $r('#rnext').onclick = () => R && setCur(R.cur + 1, true);
  $r('#rzin').onclick = () => { if (R) { R.zoom = Math.min(2.5, R.zoom + 0.2); layout(); } }; $r('#rzout').onclick = () => { if (R) { R.zoom = Math.max(0.6, R.zoom - 0.2); layout(); } };
  window.BoardReader = { open: openList, command, toast, isOpen: () => root.classList.contains('show') && !!R, close };
})();
