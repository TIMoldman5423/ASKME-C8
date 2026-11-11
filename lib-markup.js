// Board paper reading copies and each director's private marks (v1.15).
// * The original PDF is stored as loaded and is never changed. A director's marks are a separate layer, created only when they make one.
// * Marks are private: every query is scoped to the signed-in person. The words (quote and comment) are encrypted; the position is not.
// * Nothing here emails a paper. "Send my questions" emails only the director's own questions, to an active Ask user with board-paper access.
const { q } = require('./db');
const N = require('./lib-notes');
const MAIL = require('./mail');

const KINDS = ['highlight', 'underline', 'strike', 'comment'];
const COLORS = ['yellow', 'green', 'orange', 'red'];
const MAXTXT = 2000;

const pack = (uid, quote, comment) => N.enc(uid, JSON.stringify({ quote: String(quote || '').slice(0, 600), comment: String(comment || '').slice(0, MAXTXT) }), 'mark');
function unpack(uid, s) { try { const o = JSON.parse(N.dec(uid, s, 'mark')); return { quote: o.quote || '', comment: o.comment || '' }; } catch { return { quote: '', comment: '(could not be read)' }; } }

async function paperOf(id) { const r = await q('SELECT id, file_name, title, doc_type, to_char(period,\'YYYY-MM\') AS month, meeting_date, page_count FROM board_docs WHERE id=$1', [id]); return r.rows[0] || null; }
async function papers(uid) {
  const r = await q(`SELECT d.id, d.file_name, d.title, d.doc_type, to_char(d.period,'YYYY-MM') AS month, d.meeting_date, d.page_count, (p.file_name IS NOT NULL) AS has_pdf,
      (SELECT count(*)::int FROM board_marks m WHERE m.user_id=$1 AND m.paper=d.file_name) AS marks
    FROM board_docs d LEFT JOIN board_pdfs p ON p.file_name=d.file_name ORDER BY d.period DESC NULLS LAST, d.file_name`, [uid]);
  return r.rows;
}
function cleanRects(rects) {
  if (!Array.isArray(rects)) return [];
  return rects.slice(0, 80).map(r => Array.isArray(r) ? r.slice(0, 4).map(Number) : null).filter(r => r && r.length === 4 && r.every(Number.isFinite) && r[0] >= -0.05 && r[1] >= -0.05 && r[2] > 0 && r[3] > 0 && r[2] <= 1.1 && r[3] <= 1.1).map(r => r.map(v => Math.round(v * 10000) / 10000));
}
async function listMarks(uid, paper) {
  const r = await q('SELECT id, page, kind, color, question, rects, body_enc, created_at FROM board_marks WHERE user_id=$1 AND paper=$2 ORDER BY page, id', [uid, paper]);
  return r.rows.map(x => ({ id: x.id, page: x.page, kind: x.kind, color: x.color, question: x.question, rects: x.rects, ...unpack(uid, x.body_enc), created_at: x.created_at }));
}
async function addMark(uid, doc, m) {
  if (!KINDS.includes(m.kind)) throw new Error('Unknown kind of mark');
  const page = Math.floor(Number(m.page)); if (!(page >= 1 && page <= (doc.page_count || 9999))) throw new Error('No such page');
  const rects = cleanRects(m.rects); if (m.kind !== 'comment' && !rects.length) throw new Error('No position for that mark');
  const comment = String(m.comment || '').trim(); if (m.kind === 'comment' && !comment) throw new Error('A comment needs some words');
  const color = m.kind === 'highlight' ? (COLORS.includes(m.color) ? m.color : 'yellow') : (COLORS.includes(m.color) ? m.color : null);
  const r = await q('INSERT INTO board_marks(user_id, paper, page, kind, color, question, rects, body_enc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id', [uid, doc.file_name, page, m.kind, color, !!m.question, JSON.stringify(rects), pack(uid, m.quote, comment)]);
  return r.rows[0].id;
}
async function editMark(uid, id, m) {
  const r = await q('SELECT body_enc, question, color FROM board_marks WHERE id=$1 AND user_id=$2', [id, uid]); const x = r.rows[0]; if (!x) return 0;
  const cur = unpack(uid, x.body_enc); const comment = m.comment !== undefined ? String(m.comment).trim().slice(0, MAXTXT) : cur.comment;
  const color = m.color !== undefined ? (COLORS.includes(m.color) ? m.color : x.color) : x.color;
  return (await q('UPDATE board_marks SET body_enc=$3, question=$4, color=$5 WHERE id=$1 AND user_id=$2', [id, uid, pack(uid, cur.quote, comment), m.question !== undefined ? !!m.question : x.question, color])).rowCount;
}
const delMark = (uid, id) => q('DELETE FROM board_marks WHERE id=$1 AND user_id=$2', [id, uid]).then(r => r.rowCount);

// who may receive questions: active people with board-paper access (admins always have it) who have an email address
async function recipients() {
  const r = await q(`SELECT u.id, u.name, u.email FROM app_users u LEFT JOIN access_classes c ON c.code=u.access_class WHERE u.active AND u.email IS NOT NULL AND (u.role='admin' OR 'board_papers' = ANY(c.areas)) ORDER BY u.name`);
  return r.rows;
}
function questionsEmail(fromName, doc, marks) {
  const qs = marks.filter(m => m.question && (m.comment || m.quote));
  const head = 'Questions from ' + fromName + ' on "' + (doc.title || doc.file_name.replace(/\.pdf$/i, '')) + '"' + (doc.meeting_date ? ' (meeting ' + String(doc.meeting_date).slice(0, 10) + ')' : '') + '\n\n';
  const body = qs.map((m, i) => (i + 1) + '. Page ' + m.page + (m.quote ? ' - "' + m.quote.replace(/\s+/g, ' ').slice(0, 200) + '"' : '') + '\n   ' + (m.comment || '(no comment, marked as a question)')).join('\n\n');
  return { count: qs.length, subject: 'C8 board paper questions from ' + fromName + ': ' + (doc.title || doc.file_name.replace(/\.pdf$/i, '')).slice(0, 80), text: head + body + '\n\nSent from C8 Ask on behalf of ' + fromName + '. The paper itself is not attached; open it in C8 Ask.' };
}

function register(app, A, pool) {
  const area = [A.need('user'), A.allow('board_papers')];
  const me = (req, res, next) => req.uid ? next() : res.status(400).json({ error: 'Marking up needs your own sign-in (email or text code), not the shared password.' });
  const guard = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { console.error('board markup:', e.message); res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong' }); } };
  const docOr404 = async (req) => { const d = await paperOf(Number(req.params.id) || 0); if (!d) { const e = new Error('No such paper'); e.status = 404; throw e; } return d; };

  app.get('/api/board/papers', ...area, me, guard(async (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ papers: await papers(req.uid) }); }));
  app.get('/api/board/:id/pdf', ...area, guard(async (req, res) => {
    const d = await docOr404(req); const r = await q('SELECT pdf FROM board_pdfs WHERE file_name=$1', [d.file_name]);
    if (!r.rows[0]) return res.status(404).json({ error: 'There is no reading copy of this paper yet. Ask the administrator to load the PDF again.' });
    res.set({ 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store, private', 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff' }); res.send(r.rows[0].pdf);
  }));
  app.get('/api/board/:id/marks', ...area, me, guard(async (req, res) => { const d = await docOr404(req); res.set('Cache-Control', 'no-store'); res.json({ paper: { id: d.id, title: d.title, pages: d.page_count }, marks: await listMarks(req.uid, d.file_name) }); }));
  app.post('/api/board/:id/marks', ...area, me, guard(async (req, res) => {
    const d = await docOr404(req); try { res.json({ id: await addMark(req.uid, d, req.body || {}) }); } catch (e) { res.status(400).json({ error: e.message }); }
  }));
  app.patch('/api/board/marks/:mid', ...area, me, guard(async (req, res) => { const n = await editMark(req.uid, Number(req.params.mid) || 0, req.body || {}); res.status(n ? 200 : 404).json({ ok: !!n }); }));
  app.delete('/api/board/marks/:mid', ...area, me, guard(async (req, res) => { const n = await delMark(req.uid, Number(req.params.mid) || 0); res.status(n ? 200 : 404).json({ ok: !!n }); }));
  app.get('/api/board/recipients', ...area, me, guard(async (req, res) => { res.json({ people: (await recipients()).map(x => ({ id: x.id, name: x.name, you: x.id === req.uid })) }); }));
  // preview, then send: the email carries only the director's own questions, never the paper
  app.post('/api/board/:id/questions', ...area, me, guard(async (req, res) => {
    const d = await docOr404(req); const to = Number(req.body?.to) || 0; const who = (await recipients()).find(x => x.id === to);
    if (!who) return res.status(400).json({ error: 'Choose one of the listed people.' });
    const meRow = (await q('SELECT name, email FROM app_users WHERE id=$1', [req.uid])).rows[0];
    const em = questionsEmail(meRow.name, d, await listMarks(req.uid, d.file_name)); if (!em.count) return res.status(400).json({ error: 'You have not marked any questions on this paper yet.' });
    if (req.body?.send !== true) return res.json({ preview: true, to: who.name, subject: em.subject, text: em.text, count: em.count });
    if (!MAIL.enabled()) return res.status(400).json({ error: 'Email is not set up on this server.' });
    await MAIL.send(who.email, em.subject, em.text, meRow.email ? { replyTo: meRow.email } : {}); res.json({ sent: true, to: who.name, count: em.count });
  }));
}
module.exports = { register, listMarks, addMark, recipients, questionsEmail, cleanRects };
