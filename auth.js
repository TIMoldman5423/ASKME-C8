// Signed-cookie auth. Two modes:
//  * Legacy (default): two shared passwords, APP_PASSWORD (ask) and ADMIN_PASSWORD (also uploads weekly data).
//  * Code sign-in (when email or text-message sending is configured, see mail.js / sms.js): each person is a row in app_users and signs in with
//    their email address (or mobile number) plus a 6-digit code sent to it. The shared passwords then stop working.
const crypto = require('crypto');
const SMS = require('./sms'); const MAIL = require('./mail');
const SECRET = process.env.SESSION_SECRET || '';
const b64 = b => Buffer.from(b).toString('base64url');
const sign = p => crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

const channel = () => MAIL.enabled() ? 'email' : (SMS.enabled() ? 'sms' : null);   // how codes are delivered (email wins if both are set up)
const smsMode = () => !!channel();                                                  // 'code sign-in is on' (name kept from the first version)
const sessionHours = () => Math.max(1, Number(process.env.SESSION_HOURS) || 12);   // SMS sessions are short, like a banking app
const maxAgeSeconds = () => (smsMode() ? sessionHours() * 3600 : 30 * 86400);

function make(role, uid) { const ms = smsMode() ? sessionHours() * 36e5 : 30 * 864e5; const o = { r: role, e: Date.now() + ms }; if (uid) o.u = uid; const p = b64(JSON.stringify(o)); return p + '.' + sign(p); }
function read(req) {
  const m = /(?:^|;\s*)c8s=([^;]+)/.exec(req.headers.cookie || ''); if (!m) return null;
  const [p, s] = m[1].split('.'); if (!p || !s || !eq(s, sign(p))) return null;
  try { const o = JSON.parse(Buffer.from(p, 'base64url').toString()); if (!(o.e > Date.now())) return null; if (smsMode() && !o.u) return null; return o; } catch { return null; }   // a pre-SMS cookie is not accepted once SMS is on
}
const login = (pw) => process.env.ADMIN_PASSWORD && eq(pw, process.env.ADMIN_PASSWORD) ? 'admin' : (process.env.APP_PASSWORD && eq(pw, process.env.APP_PASSWORD) ? 'user' : null);

// is this person still allowed in? (checked on every request, cached for 20 seconds so switching someone off bites quickly)
const cache = new Map();
async function userOk(uid, q) {
  const hit = cache.get(uid); if (hit && hit.t > Date.now()) return hit.v;
  const r = await q('SELECT role, active FROM app_users WHERE id=$1', [uid]); const v = r.rows[0] && r.rows[0].active ? r.rows[0].role : null;
  cache.set(uid, { v, t: Date.now() + 20000 }); return v;
}
const forget = uid => cache.delete(uid);
const need = role => async (req, res, next) => {
  try {
    const s = read(req); if (!s) return res.status(401).json({ error: 'login required' });
    let r = s.r;
    if (smsMode()) { r = await userOk(s.u, require('./db').q); if (!r) return res.status(401).json({ error: 'login required' }); }   // role comes from the user's row, not the cookie
    if (role === 'admin' && r !== 'admin') return res.status(401).json({ error: 'login required' });
    req.role = r; req.uid = s.u || null; next();
  } catch (e) { next(e); }
};
const codeHash = (uid, code) => crypto.createHmac('sha256', SECRET).update('code:' + uid + ':' + code).digest('hex');
const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
module.exports = { channel, make, read, login, need, smsMode, maxAgeSeconds, codeHash, newCode, eq, forget, userOk };
