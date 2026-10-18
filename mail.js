// Sends the sign-in code by email. Configure with env:
//   SMTP_USER, SMTP_PASS            e.g. a Gmail address + a Google "app password" (SMTP_HOST defaults to smtp.gmail.com, port 465)
//   SMTP_HOST, SMTP_PORT            only if not Gmail, e.g. smtp.office365.com / 587
//   MAIL_FROM                       optional, e.g. "C8 Ask <you@gmail.com>" (defaults to SMTP_USER)
//   EMAIL_PROVIDER=console          TEST ONLY: prints the code in the server log instead of emailing it
const sent = [];   // test hook
const provider = () => process.env.EMAIL_PROVIDER === 'console' ? 'console' : (process.env.SMTP_USER && process.env.SMTP_PASS ? 'smtp' : null);
const enabled = () => !!provider();
function normaliseEmail(s) { const e = String(s || '').trim().toLowerCase(); return e.length <= 254 && /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/.test(e) ? e : null; }
const mask = e => { const [u, d] = String(e).split('@'); return (u || '').slice(0, 1) + '***@' + (d || ''); };
let tx; const transport = () => tx ||= require('nodemailer').createTransport({ host: process.env.SMTP_HOST || 'smtp.gmail.com', port: Number(process.env.SMTP_PORT) || 465, secure: (Number(process.env.SMTP_PORT) || 465) === 465, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
async function send(to, subject, text) {
  const p = provider();
  if (p === 'console') { sent.push({ to, subject, text }); console.log(`[mail:console] to ${mask(to)}: ${text.split('\n')[0]}`); return; }
  if (p === 'smtp') { await transport().sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text }); return; }
  throw new Error('Email is not configured');
}
module.exports = { enabled, normaliseEmail, mask, send, sent };
