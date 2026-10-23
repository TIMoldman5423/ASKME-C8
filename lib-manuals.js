// Manuals library: the operations, food safety, HR and equipment manuals, loaded once from manuals.json (see scripts/vector-to-manuals.py).
// Each manual is kept as the text of every page so an answer can name the manual and page.
const { q } = require('./db');

async function loadFile(c, body) {
  const docs = body && Array.isArray(body.manuals) ? body.manuals : null;
  if (!docs || !docs.length) throw new Error('Not a manuals file (expected {"manuals":[{"title":…,"pages":{"1":"text"}}]})');
  let manuals = 0, pages = 0; const skipped = [];
  for (const d of docs) {
    const title = String(d.title || '').trim().slice(0, 200); const entries = Object.entries(d.pages || {}).map(([p, t]) => [Number(p), String(t || '').replace(/\u0000/g, '').trim()]).filter(([p, t]) => Number.isInteger(p) && p > 0 && t);
    if (!title || !entries.length) { skipped.push(title || '(no title)'); continue; }
    const r = await c.query(`INSERT INTO manual_docs(title, page_count) VALUES ($1,$2) ON CONFLICT (title) DO UPDATE SET page_count=$2, loaded_at=now() RETURNING id`, [title, Math.max(...entries.map(e => e[0]))]);
    const id = r.rows[0].id; await c.query('DELETE FROM manual_pages WHERE doc_id=$1', [id]);
    for (const [p, t] of entries) await c.query('INSERT INTO manual_pages(doc_id,page,txt) VALUES ($1,$2,$3)', [id, p, t]);
    manuals++; pages += entries.length;
  }
  return { manuals, pages, skipped };
}

async function tool({ action = 'list', query, doc_id, page, limit }) {
  const n = Math.max(1, Math.min(15, Number(limit) || 8));
  const held = (await q('SELECT count(*) n FROM manual_docs')).rows[0];
  if (!Number(held.n)) return { error: 'No manuals have been loaded yet.' };
  if (action === 'list') {
    const r = await q('SELECT id, title, page_count FROM manual_docs ORDER BY title'); return { manuals: r.rows, note: 'Use "search" to find where something is covered, then "page" to read a whole page.' };
  }
  if (action === 'page') {
    const r = await q('SELECT d.title, p.page, p.txt FROM manual_pages p JOIN manual_docs d ON d.id=p.doc_id WHERE p.doc_id=$1 AND p.page=$2', [Number(doc_id) || 0, Number(page) || 0]);
    if (!r.rowCount) return { error: 'No such manual page. Use list or search first.' }; return { manual: r.rows[0].title, page: r.rows[0].page, text: r.rows[0].txt };
  }
  if (action === 'search') {
    const text = String(query || '').trim().slice(0, 200); if (!text) return { error: 'query is required for search' };
    const run = (tq) => q(`SELECT d.id doc_id, d.title, p.page, ts_headline('english', p.txt, websearch_to_tsquery('english',$1), 'MaxFragments=2,MaxWords=45,MinWords=15,FragmentDelimiter= … ') snippet,
        ts_rank(to_tsvector('english', p.txt), websearch_to_tsquery('english',$1)) rank
      FROM manual_pages p JOIN manual_docs d ON d.id=p.doc_id WHERE to_tsvector('english', p.txt) @@ websearch_to_tsquery('english',$1) ORDER BY rank DESC LIMIT $2`, [tq, n]);
    let r = await run(text);   // all the words must appear; if nothing does, any of the words will do
    if (!r.rowCount) { const words = text.toLowerCase().match(/[a-z0-9]{3,}/g) || []; if (words.length > 1) r = await run(words.join(' or ')); }
    return { matching_pages: r.rows.map(({ rank, ...x }) => x), note: r.rowCount ? 'Snippets are quoted from the manual. Name the manual and page. Use "page" with doc_id and page to read the whole page before answering anything detailed.' : 'Nothing matched. Try other words (synonyms, the equipment or form name).' };
  }
  return { error: 'unknown action' };
}
async function adminList(c) { return (await c.query('SELECT id, title, page_count, loaded_at FROM manual_docs ORDER BY title')).rows; }
module.exports = { loadFile, tool, adminList };
