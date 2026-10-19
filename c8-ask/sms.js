// Sends the sign-in code by text message. Provider is chosen by env:
//   Twilio:  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM (a Twilio number or an approved sender name)
//   console: SMS_PROVIDER=console  -- TEST ONLY. Prints the code in the server log instead of texting it.
const sent = [];   // test hook: every message "sent" by the console provider

const provider = () => process.env.SMS_PROVIDER === 'console' ? 'console' : (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM ? 'twilio' : null);
const enabled = () => !!provider();

// Accepts 0412 345 678, +61 412 345 678, 61412345678 -> +61412345678. Returns null when it does not look like a mobile number.
function normaliseMobile(s) {
  let d = String(s || '').trim().replace(/[\s().-]/g, '');
  if (d.startsWith('00')) d = '+' + d.slice(2);
  if (d.startsWith('+')) d = '+' + d.slice(1).replace(/\D/g, '');
  else { d = d.replace(/\D/g, ''); if (d.startsWith('0')) d = '+61' + d.slice(1); else if (d.startsWith('61')) d = '+' + d; else return null; }
  if (d.startsWith('+61') && !/^\+614\d{8}$/.test(d)) return null;      // Australian mobiles only start 04
  return /^\+\d{8,15}$/.test(d) ? d : null;
}
const mask = m => String(m).slice(0, 3) + ' *** *** ' + String(m).slice(-3);

async function send(to, body) {
  const p = provider();
  if (p === 'console') { sent.push({ to, body }); console.log(`[sms:console] to ${mask(to)}: ${body}`); return; }
  if (p === 'twilio') {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { authorization: 'Basic ' + Buffer.from(sid + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: process.env.TWILIO_FROM, Body: body }),
    });
    if (!r.ok) throw new Error('SMS provider refused the message (' + r.status + ')');
    return;
  }
  throw new Error('SMS is not configured');
}
module.exports = { enabled, normaliseMobile, mask, send, sent };
