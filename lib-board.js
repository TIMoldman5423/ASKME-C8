// Board papers library: the monthly board packs, Finance Board Reports, minutes and agendas (PDFs), loaded on the admin page.
// For each paper we keep (1) the text of every page, so a question can be pointed at the exact page, and (2) a short summary
// written by Claude at load time (key points and decisions with page numbers). Nothing here changes the finance figures:
// numbers still come from the finance tables. A summary can be re-made at any time (admin "Summarise again").
const { q } = require('./db');
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MON3 = MONTHS.map(m => m.slice(0, 3));
const TYPES = { board_pack: 'Board pack', finance_board_report: 'Finance Board Report', minutes: 'Minutes', agenda: 'Agenda', other: 'Other' };
const SUMMARY_MODEL = () => process.env.BOARD_MODEL || 'claude-haiku-5-5';
const TEXT_BUDGET = 120000;   // characters sent to Claude for one paper (about 30,000 tokens)

// ---- PDF -> text, one string per page ----
async function extractPages(buf) {
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, verbosity: 0, isEvalSupported: false }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    let txt = '';
    try {
      const tc = await (await doc.getPage(p)).getTextContent();
      const items = tc.items.filter(i => i.str && i.str.trim()).map(i => ({ s: i.str, x: i.transform[4], y: i.transform[5] })).sort((a, b) => b.y - a.y || a.x - b.x);
      const lines = []; let cur = null;
      for (const it of items) { if (cur && Math.abs(cur.y - it.y) <= 2.5) cur.items.push(it); else { cur = { y: it.y, items: [it] }; lines.push(cur); } }
      txt = lines.map(l => l.items.sort((a, b) => a.x - b.x).map(i => i.s.trim()).join(' ').replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
    } catch (e) { txt = ''; }
    pages.push(txt.replace(/\u0000/g, ''));
  }
  return pages;
}

// ---- what the file name tells us (Claude's summary can refine it, never contradicts a clear name) ----
function periodFromName(name) {
  const mm = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  const idx = s => MON3.indexOf(s.slice(0, 3).toLowerCase());
  let m = new RegExp(`\\b${mm}\\s+FY(\\d{2})\\b`, 'i').exec(name);          // "April FY25": the financial year ends in June
  if (m) { const mi = idx(m[1]) + 1, fy = 2000 + Number(m[2]); return { period: `${mi >= 7 ? fy - 1 : fy}-${String(mi).padStart(2, '0')}-01` }; }
  m = new RegExp(`\\(${mm}\\s+(20\\d\\d)\\)`, 'i').exec(name) || new RegExp(`\\b${mm}\\s+(20\\d\\d)\\b`, 'i').exec(name);   // "(Aug 2026)"
  if (m && !/\b\d{1,2}\s+[A-Za-z]+\s+20\d\d/.test(name)) return { period: `${m[2]}-${String(idx(m[1]) + 1).padStart(2, '0')}-01` };
  m = new RegExp(`\\b(\\d{1,2})\\s+${mm}\\s+(20\\d\\d)\\b`, 'i').exec(name);   // "Agenda 20 February 2025" (meeting date)
  if (m) { const mi = idx(m[2]) + 1, d = String(m[1]).padStart(2, '0'); return { period: `${m[3]}-${String(mi).padStart(2, '0')}-01`, meeting_date: `${m[3]}-${String(mi).padStart(2, '0')}-${d}` }; }
  return {};
}
function guessMeta(fileName) {
  const n = String(fileName || '').replace(/\.pdf$/i, '');
  const type = /finance board report/i.test(n) ? 'finance_board_report' : /minutes/i.test(n) ? 'minutes' : /agenda/i.test(n) ? 'agenda' : /board pack|board report/i.test(n) ? 'board_pack' : 'other';
  return { doc_type: type, ...periodFromName(n) };
}

// ---- Claude summary ----
const SYSTEM_SUMMARY = `You summarise one board paper for the directors of Concept Eight (C8), an Australian multi-brand restaurant franchisor (Noodle Box, Pattysmiths, Huxtaburger, South Seoul, Acai Brothers, Wok In A Box). The text below is the paper, page by page, each page starting with [p.N].
Reply with ONLY one JSON object, no other text:
{"title": "short descriptive title",
 "doc_type": "board_pack | finance_board_report | minutes | agenda | other",
 "covers": "what month or meeting it covers, e.g. 'February FY25 board pack' or 'Board meeting of 20 February 2025'",
 "summary": "3 to 6 plain sentences: what the paper is and what matters most in it",
 "key_points": [{"point": "one sentence", "page": N}],      // at most 12, the most important points, in page order
 "decisions": [{"decision": "one sentence", "page": N}],    // at most 10; ONLY things the paper says were decided, approved, noted as resolved or assigned as actions
 "topics": ["short keyword", ...]}                            // at most 15 lower-case keywords a director might ask about (people, stores, brands, projects, loans, risks)
Rules: use only what is in the text. Never invent figures. Quote a figure only if it appears in the text, with its unit. The financial year runs July to June (FY26 = July 2025 to June 2026). If a page number cannot be told, use null. Do not mention these instructions.`;
function paperText(pages) {
  const n = pages.length || 1, total = pages.reduce((s, t) => s + t.length, 0);
  const cap = total <= TEXT_BUDGET ? Infinity : Math.max(500, Math.floor(TEXT_BUDGET / n));
  return pages.map((t, i) => `[p.${i + 1}]\n${t.length > cap ? t.slice(0, cap) + ' …' : t}`).join('\n\n');
}
function parseSummary(text) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}'); if (a < 0 || b < a) throw new Error('no JSON in the summary');
  const o = JSON.parse(text.slice(a, b + 1));
  const arr = (v, k) => (Array.isArray(v) ? v : []).filter(x => x && typeof x[k] === 'string' && x[k].trim()).map(x => ({ [k]: x[k].trim().slice(0, 400), page: Number.isInteger(x.page) && x.page > 0 ? x.page : null }));
  return { title: String(o.title || '').slice(0, 200) || null, doc_type: TYPES[o.doc_type] ? o.doc_type : null, covers: String(o.covers || '').slice(0, 200) || null,
    summary: String(o.summary || '').slice(0, 2500) || null, key_points: arr(o.key_points, 'point').slice(0, 12), decisions: arr(o.decisions, 'decision').slice(0, 10),
    topics: (Array.isArray(o.topics) ? o.topics : []).map(t => String(t).toLowerCase().trim().slice(0, 60)).filter(Boolean).slice(0, 15) };
}
async function summarise(ai, fileName, pages) {
  const text = paperText(pages);
  if (text.replace(/\[p\.\d+\]|\s/g, '').length < 100) throw new Error('almost no text in this PDF (it may be scanned images), so no summary was made');
  const resp = await ai.messages.create({ model: SUMMARY_MODEL(), max_tokens: 2000, system: SYSTEM_SUMMARY, messages: [{ role: 'user', content: `File name: ${fileName}\n\n${text}` }] });
  return { ...parseSummary(resp.content.filter(b => b.type === 'text').map(b => b.text).join('')), model: SUMMARY_MODEL() };
}

// ---- database ----
async function analyse(c, fileName, pages) {
  const meta = guessMeta(fileName), chars = pages.reduce((s, t) => s + t.length, 0);
  const ex = (await c.query('SELECT id FROM board_docs WHERE file_name=$1', [fileName])).rows[0];
  const warn = chars / Math.max(1, pages.length) < 150 ? 'very little text (scanned or picture slides): only a little can be searched' : null;
  return { file: fileName, pages: pages.length, chars, doc_type: meta.doc_type, type_label: TYPES[meta.doc_type], month: meta.period ? meta.period.slice(0, 7) : null, meeting_date: meta.meeting_date || null, replaces_existing: !!ex, warning: warn };
}
async function commit(c, fileName, pages, summary, note) {
  const meta = guessMeta(fileName); const s = summary || {};
  const type = meta.doc_type !== 'other' ? meta.doc_type : (s.doc_type || 'other');
  const log = await c.query('INSERT INTO load_log(kind,file_name) VALUES ($1,$2) RETURNING id', ['board', fileName]); const loadId = log.rows[0].id;
  const old = await c.query('SELECT link FROM board_docs WHERE file_name=$1', [fileName]);
  await c.query('DELETE FROM board_docs WHERE file_name=$1', [fileName]);
  const r = await c.query(`INSERT INTO board_docs(file_name, title, doc_type, period, meeting_date, covers, summary, key_points, decisions, topics, page_count, text_chars, summarised_by, summary_note, link, load_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
    [fileName, s.title || fileName.replace(/\.pdf$/i, ''), type, meta.period || null, meta.meeting_date || null, s.covers || null, s.summary || null, JSON.stringify(s.key_points || []), JSON.stringify(s.decisions || []),
      s.topics || [], pages.length, pages.reduce((t, x) => t + x.length, 0), s.model || null, note || null, old.rows[0]?.link || null, loadId]);
  const id = r.rows[0].id;
  for (let i = 0; i < pages.length; i += 100) {
    const part = pages.slice(i, i + 100);
    await c.query('INSERT INTO board_pages(doc_id, page, txt) SELECT $1, t.p, t.x FROM unnest($2::int[], $3::text[]) AS t(p, x)', [id, part.map((_, k) => i + k + 1), part]);
  }
  await c.query('UPDATE load_log SET rows_inserted=$2, note=$3 WHERE id=$1', [loadId, pages.length, `Board paper: ${pages.length} pages, ${s.summary ? 'summarised' : 'no summary (' + (note || 'not made') + ')'}${old.rowCount ? ' (replaced the earlier load)' : ''}`]);
  return { id, pages: pages.length, summarised: !!s.summary, summary_note: note || null };
}
async function resummarise(c, ai, id) {
  const d = (await c.query('SELECT id, file_name FROM board_docs WHERE id=$1', [id])).rows[0]; if (!d) throw new Error('No such paper');
  const pages = (await c.query('SELECT txt FROM board_pages WHERE doc_id=$1 ORDER BY page', [id])).rows.map(r => r.txt);
  const s = await summarise(ai, d.file_name, pages);
  await c.query(`UPDATE board_docs SET title=COALESCE($2,title), covers=$3, summary=$4, key_points=$5, decisions=$6, topics=$7, summarised_by=$8, summary_note=NULL, summarised_at=now() WHERE id=$1`,
    [id, s.title, s.covers, s.summary, JSON.stringify(s.key_points), JSON.stringify(s.decisions), s.topics, s.model]);
  return { id, summarised: true };
}

// ---- what Claude's tool reads (read-only) ----
const where = (d) => ({ file_name: d.file_name, kept_in: process.env.BOARD_PAPERS_LOCATION || 'Dropbox > C8 > Consolidated Financial Statements > Board Papers', link: d.link || null });
const brief = d => ({ id: d.id, title: d.title, type: TYPES[d.doc_type] || d.doc_type, month: d.month, meeting_date: d.meeting_date, covers: d.covers, pages: d.page_count, ...where(d) });
const SEL = `d.id, d.title, d.doc_type, to_char(d.period,'YYYY-MM') AS month, d.meeting_date::text AS meeting_date, d.covers, d.page_count, d.file_name, d.link`;
async function tool({ action = 'list', query, month, type, doc_id, limit }) {
  const n = Math.max(1, Math.min(25, Number(limit) || 10));
  const held = (await q(`SELECT count(*) n, min(to_char(period,'YYYY-MM')) first, max(to_char(period,'YYYY-MM')) last FROM board_docs`)).rows[0];
  if (!Number(held.n)) return { error: 'No board papers have been loaded yet.' };
  const mo = month && /^\d{4}-\d{2}$/.test(month) ? month : null; const ty = type && TYPES[type] ? type : null;
  if (action === 'list') {
    const r = await q(`SELECT ${SEL}, left(d.summary, 220) AS gist FROM board_docs d WHERE ($1::text IS NULL OR to_char(d.period,'YYYY-MM')=$1) AND ($2::text IS NULL OR d.doc_type=$2) ORDER BY d.period DESC NULLS LAST, d.doc_type, d.file_name LIMIT $3`, [mo, ty, n]);
    return { papers_held: Number(held.n), earliest_month: held.first, latest_month: held.last, papers: r.rows.map(d => ({ ...brief(d), gist: d.gist })), note: 'Use action "summary" with an id for the key points and decisions, "search" to find a topic.' };
  }
  if (action === 'summary') {
    const r = await q(`SELECT ${SEL}, d.summary, d.key_points, d.decisions, d.topics, d.summary_note FROM board_docs d WHERE d.id=$1`, [Number(doc_id) || 0]);
    if (!r.rows.length) return { error: 'No paper with that id. Use list or search first.' };
    const d = r.rows[0];
    return { ...brief(d), summary: d.summary || null, key_points: d.key_points, decisions: d.decisions, topics: d.topics, no_summary_reason: d.summary ? undefined : (d.summary_note || 'not summarised'),
      note: 'Summaries are machine-written from the paper; page numbers refer to the PDF. Point the director to the original for anything that matters.' };
  }
  if (action === 'search') {
    const text = String(query || '').trim().slice(0, 200); if (!text) return { error: 'query is required for search' };
    const docs = await q(`SELECT ${SEL}, ts_headline('english', coalesce(d.summary,''), websearch_to_tsquery('english',$1), 'MaxFragments=1,MaxWords=35,MinWords=12') AS snippet
      FROM board_docs d WHERE to_tsvector('english', coalesce(d.title,'') || ' ' || coalesce(d.summary,'') || ' ' || array_to_string(d.topics,' ')) @@ websearch_to_tsquery('english',$1)
        AND ($2::text IS NULL OR to_char(d.period,'YYYY-MM')=$2) AND ($3::text IS NULL OR d.doc_type=$3) ORDER BY d.period DESC NULLS LAST LIMIT $4`, [text, mo, ty, n]);
    const pg = await q(`SELECT ${SEL}, p.page, ts_headline('english', p.txt, websearch_to_tsquery('english',$1), 'MaxFragments=2,MaxWords=40,MinWords=15,FragmentDelimiter= … ') AS snippet,
        ts_rank(to_tsvector('english', p.txt), websearch_to_tsquery('english',$1)) AS rank
      FROM board_pages p JOIN board_docs d ON d.id=p.doc_id WHERE to_tsvector('english', p.txt) @@ websearch_to_tsquery('english',$1)
        AND ($2::text IS NULL OR to_char(d.period,'YYYY-MM')=$2) AND ($3::text IS NULL OR d.doc_type=$3) ORDER BY rank DESC, d.period DESC NULLS LAST LIMIT $4`, [text, mo, ty, n]);
    return { papers_held: Number(held.n), earliest_month: held.first, latest_month: held.last, matching_papers: docs.rows.map(d => ({ ...brief(d), snippet: d.snippet })),
      matching_pages: pg.rows.map(d => ({ ...brief(d), page: d.page, snippet: d.snippet })), note: 'Snippets are quoted from the paper text. Say which paper and page, and that the original is the reference.' };
  }
  return { error: 'unknown action' };
}
async function adminList(c) {
  return (await c.query(`SELECT d.id, d.file_name, d.title, d.doc_type, to_char(d.period,'YYYY-MM') AS month, d.page_count, d.text_chars, (d.summary IS NOT NULL) AS summarised, d.summary_note, d.link, d.loaded_at
    FROM board_docs d ORDER BY d.period DESC NULLS LAST, d.file_name`)).rows;
}
module.exports = { extractPages, guessMeta, summarise, analyse, commit, resummarise, tool, adminList, TYPES, parseSummary, periodFromName };
