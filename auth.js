// Minimal signed-cookie auth. Two passwords: APP_PASSWORD (ask) and ADMIN_PASSWORD (also uploads weekly data).
const crypto = require('crypto');
const SECRET = process.env.SESSION_SECRET || '';
const b64 = b => Buffer.from(b).toString('base64url');
const sign = p => crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function make(role, days = 30) { const p = b64(JSON.stringify({ r: role, e: Date.now() + days * 864e5 })); return p + '.' + sign(p); }
function read(req) {
  const m = /(?:^|;\s*)c8s=([^;]+)/.exec(req.headers.cookie || ''); if (!m) return null;
  const [p, s] = m[1].split('.'); if (!p || !s || !eq(s, sign(p))) return null;
  try { const o = JSON.parse(Buffer.from(p, 'base64url').toString()); return o.e > Date.now() ? o : null; } catch { return null; }
}
const login = (pw) => process.env.ADMIN_PASSWORD && eq(pw, process.env.ADMIN_PASSWORD) ? 'admin' : (process.env.APP_PASSWORD && eq(pw, process.env.APP_PASSWORD) ? 'user' : null);
const need = role => (req, res, next) => { const s = read(req); if (!s || (role === 'admin' && s.r !== 'admin')) return res.status(401).json({ error: 'login required' }); req.role = s.r; next(); };
module.exports = { make, read, login, need };
