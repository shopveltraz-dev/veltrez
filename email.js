// Email service. Provider via EMAIL_PROVIDER env: "dev" (default, logs to console)
// or "smtp" (SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM).
const nodemailer = require('nodemailer');

let _transport = null;
function transport() {
  if (!_transport) {
    _transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_PORT === '465',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return _transport;
}

// Soft-pink VELTREZ-branded wrapper
function wrap(title, bodyHtml) {
  return `<!doctype html><body style="margin:0;background:#fdf1ee;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #f3d4da;border-radius:14px;overflow:hidden;">
    <div style="padding:26px 32px;border-bottom:1px solid #f6e2e6;background:#fff6f4;">
      <span style="color:#b5122f;font-size:24px;letter-spacing:3px;font-weight:bold;font-style:italic;">VELTREZ&nbsp;&#10022;</span>
    </div>
    <div style="padding:32px;color:#4a3a40;font-size:14px;line-height:1.8;">
      <h2 style="color:#b5122f;margin:0 0 18px;font-size:20px;">${title}</h2>
      ${bodyHtml}
    </div>
    <div style="padding:20px 32px;border-top:1px solid #f6e2e6;color:#b08d96;font-size:11px;">
      VELTREZ · for girls who looked cute anyway · Jerusalem
    </div>
  </div></body>`;
}

// sendEmail({ to, subject, title, html, text })
async function sendEmail({ to, subject, title, html, text }) {
  if (!to) return { sent: false, reason: 'no address' };
  const provider = process.env.EMAIL_PROVIDER || 'dev';

  if (provider === 'smtp') {
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER)
      throw new Error('SMTP env vars missing');
    await transport().sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to, subject,
      text: text || '',
      html: wrap(title || subject, html || `<p>${text || ''}</p>`),
    });
    return { sent: true };
  }

  // dev mode: log only
  console.log(`\n📧 [DEV EMAIL] to ${to} — "${subject}"\n   ${(text || '').slice(0, 160)}\n`);
  return { sent: true, dev: true };
}

module.exports = { sendEmail };
