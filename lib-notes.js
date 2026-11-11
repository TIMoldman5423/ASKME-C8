// Personal notes, to-dos and reminders (v1.14).
// * Private to the person who made them: every query is scoped by user id, and no admin screen reads them.
// * The text is encrypted at rest (AES-256-GCM, key from NOTES_KEY, tied to the user id so a copied row cannot be read as someone else's).
//   The due time and the kind are kept in the clear so reminders can be found; the words are not.
// * Notes never go to Claude and are never written to the questions log.
// * Typed or spoken: "note ...", "to do ...", "remind me to ... tomorrow at 3pm", "list my notes", "delete note 3", "mark 2 done".
const crypto = require('crypto');
const { q } = require('./db');
const MAIL = require('./mail');

const TZ = 'Australia/Melbourne';
const MAX_LEN = 500;

// ---------- encryption ----------
let KEY;
function key() {
  if (KEY) return KEY;
  const src = process.env.NOTES_KEY || process.env.SESSION_SECRET || '';
  if (!src) throw new Error('NOTES_KEY is not set');
  if (!process.env.NOTES_KEY) console.error('NOTES_KEY is not set: notes are encrypted with a key derived from SESSION_SECRET, so changing SESSION_SECRET would make them unreadable. Set NOTES_KEY in Railway and keep a copy of it.');
  KEY = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(src), Buffer.from('c8-ask-notes'), Buffer.from('notes-v1'), 32));
  return KEY;
}
function enc(uid, text) {
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key(), iv); c.setAAD(Buffer.from('note:' + uid));
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return 'v1.' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}
function dec(uid, s) {
  try {
    const b = Buffer.from(String(s).replace(/^v1\./, ''), 'base64url'); const d = crypto.createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12));
    d.setAAD(Buffer.from('note:' + uid)); d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch { return '(could not be read)'; }
}

// ---------- Melbourne time helpers ----------
const FMT = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
function parts(d) { const o = {}; for (const p of FMT.formatToParts(d)) o[p.type] = p.value; return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday) }; }
function melb(y, m, d, h, mi) {   // a Melbourne wall-clock time as a real instant
  let t = Date.UTC(y, m - 1, d, h, mi);
  for (let i = 0; i < 3; i++) { const p = parts(new Date(t)); const off = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - t; t = Date.UTC(y, m - 1, d, h, mi) - off; }
  return new Date(t);
}
const addDays = (p, n) => { const x = new Date(Date.UTC(p.y, p.m - 1, p.d + n)); return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate() }; };
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

// pulls a due date/time out of the words; returns { text (the words left over), due (Date|null) }
function dueFrom(text, now = new Date()) {
  let t = ' ' + text + ' '; const np = parts(now); let day = null, hm = null, rel = null;
  const cut = re => { const m = re.exec(t); if (m) t = t.replace(re, ' '); return m; };
  let m;
  if ((m = cut(/\s(?:in|after)\s+(\d+|an?|one|two|three|four|five|six|ten|fifteen|twenty|thirty)\s+(minutes?|mins?|hours?|hrs?|days?)(?=[\s.,!?]|$)/i))) {
    const n = /^an?$/i.test(m[1]) ? 1 : (NUM[m[1].toLowerCase()] || ({ fifteen: 15, twenty: 20, thirty: 30 })[m[1].toLowerCase()] || +m[1]); const u = m[2][0].toLowerCase();
    rel = new Date(now.getTime() + n * (u === 'm' ? 60e3 : u === 'h' ? 3600e3 : 86400e3));
  }
  if (!rel) {
    if ((m = cut(/\s(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)(?=[\s.,!?]|$)/i)) || (m = cut(/\sat\s+(\d{1,2})(?::(\d{2}))?(?=[\s.,!?]|$)/i))) {
      let h = +m[1]; const mi = +(m[2] || 0); const ap = (m[3] || '').toLowerCase()[0];
      if (ap === 'p' && h < 12) h += 12; if (ap === 'a' && h === 12) h = 0; if (!ap && h >= 1 && h <= 6) h += 12;   // "at 3" means 3pm
      if (h <= 23 && mi <= 59) hm = [h, mi];
    } else if (cut(/\s(?:at\s+)?(?:noon|midday)(?=[\s.,!?]|$)/i)) hm = [12, 0];
    else if (cut(/\s(?:this\s+)?(?:in the\s+)?morning(?=[\s.,!?]|$)/i)) hm = [9, 0];
    else if (cut(/\s(?:this\s+)?(?:in the\s+)?afternoon(?=[\s.,!?]|$)/i)) hm = [15, 0];
    else if (cut(/\s(?:this\s+)?(?:in the\s+)?evening(?=[\s.,!?]|$)/i)) hm = [18, 0];
    if (cut(/\stonight(?=[\s.,!?]|$)/i)) { day = addDays(np, 0); hm = hm || [18, 0]; }
    else if (cut(/\stomorrow(?=[\s.,!?]|$)/i)) day = addDays(np, 1);
    else if (cut(/\s(?:later\s+)?today(?=[\s.,!?]|$)/i)) day = addDays(np, 0);
    else if ((m = cut(new RegExp('\\s(?:on\\s+|this\\s+|next\\s+)?(' + DAYS.join('|') + ')(?=[\\s.,!?]|$)', 'i')))) {
      let k = (DAYS.indexOf(m[1].toLowerCase()) - np.wd + 7) % 7; if (k === 0) k = 7; if (/next\s+\w+$/i.test(m[0].trim())) k = k < 7 ? k + 7 : k; day = addDays(np, k);
    } else if ((m = cut(new RegExp('\\s(?:on\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(' + MONTHS.map(x => x.slice(0, 3) + '\\w*').join('|') + ')(?=[\\s.,!?]|$)', 'i')))) {
      const mo = MONTHS.findIndex(x => x.startsWith(m[2].slice(0, 3).toLowerCase())) + 1; day = { y: np.y, m: mo, d: +m[1] }; if (melb(day.y, day.m, day.d, 23, 59) < now) day.y++;
    } else if ((m = cut(/\s(?:on\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?=[\s.,!?]|$)/i))) {
      let y = m[3] ? +m[3] : np.y; if (y < 100) y += 2000; day = { y, m: +m[2], d: +m[1] }; if (!m[3] && melb(day.y, day.m, day.d, 23, 59) < now) day.y++;
    }
  }
  let due = rel;
  if (!due && (day || hm)) {
    if (!day) { day = { y: np.y, m: np.m, d: np.d }; if (melb(day.y, day.m, day.d, hm[0], hm[1]) <= now) day = addDays(np, 1); }
    due = melb(day.y, day.m, day.d, ...(hm || [9, 0]));
  }
  if (due && Number.isNaN(due.getTime())) due = null;
  const left = t.replace(/\s+(?:at|on|by|for)\s*$/i, ' ').replace(/\s{2,}/g, ' ').replace(/^\s+|[\s,;]+$/g, '');
  return { text: due ? left : text.trim(), due };
}

// ---------- understanding what was typed or said ----------
const norm = s => String(s || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9'#\/:.,@ -]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[.,!?;:]+$/, '');
const KIND_WORD = '(notes?|to ?do(?:e?s)?|to-dos?|todos?|reminders?|to do list|list|items?)';
const CAPTURE = [
  [/^(?:please )?(?:remind me(?: to| that| about| of)?|set (?:a )?reminder(?: to| for| that)?|reminder[:,]?|remember to|don't let me forget(?: to)?|dont let me forget(?: to)?)\s+(.+)$/, 'reminder'],
  [/^(?:please )?(?:to ?do|to-do|todo)[:,]?\s+(.+)$/, 'todo'],
  [/^(?:please )?(?:add (?:a |an )?(?:to ?do|to-do|task|item)(?: to my list)?|add (?:this |that )?to my (?:to ?do |to-do )?list|put (?:this |that )?on my (?:to ?do |to-do )?list)[:,]?\s*(?:to |that )?(.+)$/, 'todo'],
  [/^(?:please )?(?:(?:make|take|add|save|write|jot down|keep|store)(?: me)?(?: a)? (?:quick )?note(?: to self)?(?: that| to)?|note to self|note|jot down|save a note|save this)[:,]?\s+(.+)$/, 'note'],
];
function numberOf(s) { s = String(s || '').trim(); if (/^\d+$/.test(s)) return +s; if (NUM[s]) return NUM[s]; if (/last/.test(s)) return 'last'; if (/first/.test(s)) return 1; return null; }
function command(text) {
  const n = norm(text);
  let m;
  if ((m = /^(?:please )?(?:confirm|yes) (?:delete|clear|remove) all(?: of)?(?: my)?(?: notes| reminders| to ?dos| items| to-dos)?$/.exec(n))) return { op: 'delete_all_confirmed' };
  if (/^(?:please )?(?:delete|clear|remove|erase) (?:all|every)(?: of)?(?: my)?(?: notes| reminders| to ?dos| items| to-dos)$/.test(n)) return { op: 'delete_all' };
  if (/^(?:please )?(?:delete|clear|remove|erase) (?:my )?(?:done|completed|finished|ticked)(?: notes| items| reminders| to ?dos| to-dos)?$/.test(n)) return { op: 'clear_done' };
  if ((m = /^(?:please )?(?:delete|remove|erase|cancel|scrap) (?:my )?(?:note|reminder|to ?do|item|task)?\s*(?:number |no\.? |#)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|(?:the )?last(?: one)?|(?:the )?first(?: one)?)(?: note| one| item| reminder)?$/.exec(n))) return { op: 'delete', n: numberOf(m[1]) };
  if ((m = /^(?:please )?(?:delete|remove|erase) (?:the )?(?:last|latest|newest) (?:note|reminder|to ?do|item|one)$/.exec(n))) return { op: 'delete', n: 'last' };
  if ((m = /^(?:please )?(?:mark|tick|check)(?: off)?\s*(?:note |item |reminder |to ?do |task )?(?:number |no\.? |#)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten|(?:the )?last(?: one)?|(?:the )?first(?: one)?)(?: note| one| item| reminder)?(?: as)?(?: done| complete| completed| finished)?$/.exec(n))) return { op: 'done', n: numberOf(m[1]) };
  if ((m = /^(?:please )?(?:read|list|show|play|replay|play back|read out|read back|what are|what's|whats|what is)(?: me| out| back)?(?: all)?(?: of)?(?: my)? ?(open |due |overdue |done )?(?:notes?|to ?do'?s?|to-dos?|todos?|reminders?|to do list|list|items|tasks)(?: back| out| again)?$/.exec(n)) || (m = /^(?:do i have any|have i got any|any)(?: open| due)? (?:notes?|to ?dos?|reminders?|tasks)(?: due| today)?$/.exec(n))) return { op: 'list', filter: (m[1] || '').trim() };
  return null;
}
function capture(text, mode) {
  const raw = String(text || '').trim().replace(/^["'\s]+|["'\s]+$/g, ''); const n = raw.replace(/\s+/g, ' ');
  const low = n.toLowerCase().replace(/[‘’]/g, "'");
  for (const [re, kind] of CAPTURE) { const m = re.exec(low); if (m) { const body = n.slice(n.length - m[1].length); return { kind, body }; } }
  if (mode === 'note') return { kind: 'note', body: n };
  return null;
}
const looksLikeNoteIntent = (text, mode) => mode === 'note' || !!command(text) || !!capture(text, mode);

// ---------- storage ----------
async function listFor(uid) {
  const r = await q('SELECT id, kind, body_enc, remind_at, done, created_at FROM user_notes WHERE user_id=$1 ORDER BY done ASC, remind_at ASC NULLS LAST, created_at ASC, id ASC', [uid]);
  return r.rows.map((x, i) => ({ n: i + 1, id: x.id, kind: x.kind, text: dec(uid, x.body_enc), remind_at: x.remind_at, done: x.done, created_at: x.created_at }));
}
async function add(uid, kind, body, due) {
  const text = String(body || '').trim().slice(0, MAX_LEN); if (!text) throw new Error('Nothing to save');
  const r = await q('INSERT INTO user_notes(user_id, kind, body_enc, remind_at) VALUES ($1,$2,$3,$4) RETURNING id', [uid, kind, enc(uid, text), due || null]);
  return { id: r.rows[0].id, text };
}
const setDone = (uid, id, done) => q('UPDATE user_notes SET done=$3, alerted_at=CASE WHEN $3 THEN COALESCE(alerted_at, now()) ELSE NULL END WHERE id=$1 AND user_id=$2', [id, uid, !!done]).then(r => r.rowCount);
const remove = (uid, id) => q('DELETE FROM user_notes WHERE id=$1 AND user_id=$2', [id, uid]).then(r => r.rowCount);

const when = (d, now = new Date()) => {
  const p = parts(d), t = parts(now); const days = Math.round((Date.UTC(p.y, p.m - 1, p.d) - Date.UTC(t.y, t.m - 1, t.d)) / 864e5);
  const hh = p.h % 12 || 12, ap = p.h < 12 ? 'am' : 'pm', time = hh + (p.mi ? ':' + String(p.mi).padStart(2, '0') : '') + ' ' + ap;
  const day = days === 0 ? 'today' : days === 1 ? 'tomorrow' : days === -1 ? 'yesterday' : days > 1 && days < 7 ? DAYS[p.wd][0].toUpperCase() + DAYS[p.wd].slice(1) : p.d + ' ' + MONTHS[p.m - 1][0].toUpperCase() + MONTHS[p.m - 1].slice(1, 3);
  return day + ' at ' + time;
};
const kindWord = k => k === 'reminder' ? 'reminder' : k === 'todo' ? 'to do' : 'note';
function readOut(items, filter, now = new Date()) {
  let xs = items; if (filter === 'done') xs = items.filter(x => x.done); else if (filter === 'due' || filter === 'overdue') xs = items.filter(x => !x.done && x.remind_at && new Date(x.remind_at) <= new Date(now.getTime() + (filter === 'due' ? 24 * 36e5 : 0))); else if (filter === 'open') xs = items.filter(x => !x.done);
  if (!xs.length) return filter === 'done' ? 'You have no finished items.' : filter ? 'You have nothing ' + filter + '.' : 'You have no notes.';
  const open = items.filter(x => !x.done).length;
  const lines = xs.slice(0, 20).map(x => x.n + ', ' + kindWord(x.kind) + ', ' + x.text + (x.remind_at ? ', ' + (new Date(x.remind_at) < now && !x.done ? 'was due ' : 'due ') + when(new Date(x.remind_at), now) : '') + (x.done ? ', done' : '') + '.');
  return (filter ? '' : 'You have ' + open + ' open ' + (open === 1 ? 'item' : 'items') + (items.length > open ? ' and ' + (items.length - open) + ' done' : '') + '. ') + lines.join(' ') + (xs.length > 20 ? ' And ' + (xs.length - 20) + ' more, see the Notes window.' : '');
}
const pick = (items, n) => n === 'last' ? items[items.length - 1] : items.find(x => x.n === n);

// the one entry point used by /api/ask: returns { answer } if this was about notes, else null
async function intercept(uid, email, text, mode, now = new Date()) {
  const cmd = command(text);
  if (cmd) {
    const items = await listFor(uid);
    if (cmd.op === 'list') return { answer: readOut(items, cmd.filter, now) };
    if (cmd.op === 'delete') { const it = pick(items, cmd.n); if (!it) return { answer: items.length ? 'There is no note number ' + cmd.n + '. You have ' + items.length + '.' : 'You have no notes.' }; await remove(uid, it.id); return { answer: 'Deleted note ' + it.n + ': ' + it.text + '. The numbers have changed, so say list my notes to hear them again.' }; }
    if (cmd.op === 'done') { const it = pick(items, cmd.n); if (!it) return { answer: 'There is no note number ' + cmd.n + '.' }; await setDone(uid, it.id, true); return { answer: 'Marked note ' + it.n + ' done: ' + it.text + '.' }; }
    if (cmd.op === 'clear_done') { const r = await q('DELETE FROM user_notes WHERE user_id=$1 AND done', [uid]); return { answer: r.rowCount ? 'Cleared ' + r.rowCount + ' finished ' + (r.rowCount === 1 ? 'item' : 'items') + '.' : 'There are no finished items to clear.' }; }
    if (cmd.op === 'delete_all') return { answer: 'That would delete all ' + items.length + ' of your notes. Say or type "confirm delete all" to go ahead.' };
    if (cmd.op === 'delete_all_confirmed') { const r = await q('DELETE FROM user_notes WHERE user_id=$1', [uid]); return { answer: 'Deleted ' + r.rowCount + ' ' + (r.rowCount === 1 ? 'note' : 'notes') + '.' }; }
  }
  const cap = capture(text, mode); if (!cap) return null;
  const { text: body0, due: due0 } = dueFrom(cap.body, now); let body = body0, due = due0, extra = '';
  if (due && due <= now) { due = null; extra = ' That time has already passed, so I saved it without a reminder time.'; }
  if (!body) body = cap.body;
  const kind = due ? 'reminder' : cap.kind;
  const saved = await add(uid, kind, body, due);
  const how = due ? (email && MAIL.enabled() ? ' I will email you ' + when(due, now) + '.' : ' It is due ' + when(due, now) + '; I will show it when you open Ask.') : '';
  return { answer: 'Saved ' + kindWord(kind) + ': ' + saved.text + '.' + how + extra };
}

// ---------- email alerts (run every minute) ----------
async function runAlerts(now = new Date()) {
  if (!MAIL.enabled()) return 0;
  const r = await q(`UPDATE user_notes n SET alerted_at=$1::timestamptz FROM app_users u WHERE u.id=n.user_id AND u.active AND u.email IS NOT NULL AND n.remind_at IS NOT NULL AND n.remind_at<=$1::timestamptz AND NOT n.done AND n.alerted_at IS NULL AND n.remind_at > $1::timestamptz - interval '2 days'
    RETURNING n.id, n.user_id, n.body_enc, n.remind_at, u.email`, [now]);
  let sent = 0;
  for (const x of r.rows) {
    try { await MAIL.send(x.email, 'C8 Ask reminder', 'Reminder: ' + dec(x.user_id, x.body_enc) + '\n\nDue ' + when(new Date(x.remind_at), now) + '. Sent by your C8 Ask notes. Open C8 Ask to mark it done.'); sent++; }
    catch (e) { console.error('reminder email failed:', e.message); await q('UPDATE user_notes SET alerted_at=NULL WHERE id=$1', [x.id]).catch(() => {}); }
  }
  return sent;
}
async function dueFor(uid, now = new Date()) {
  const items = await listFor(uid); return items.filter(x => !x.done && x.remind_at && new Date(x.remind_at) <= now);
}
function startAlerts() { const t = setInterval(() => runAlerts().catch(e => console.error('reminder check failed:', e.message)), 60000); if (t.unref) t.unref(); }

module.exports = { enc, dec, dueFrom, command, capture, looksLikeNoteIntent, intercept, listFor, add, setDone, remove, runAlerts, dueFor, startAlerts, when, parts, melb };
