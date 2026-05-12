// netlify/functions/contact.js
// Receives contact form submissions and emails them to hello@overhauled.ai
// Requires env var: RESEND_API_KEY

const https = require('https');

function resendPost(apiKey, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request(
      {
        hostname: 'api.resend.com',
        port: 443,
        path: '/emails',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let d = '';
        res.on('data', c => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sendEmail(apiKey, to, subject, html, from = 'Overhauled.ai Contact <hello@overhauled.ai>') {
  if (!apiKey) {
    console.log(`[email skipped — no RESEND_API_KEY] To: ${to} | Subject: ${subject}`);
    return;
  }
  const result = await resendPost(apiKey, { from, to: [to], subject, html });
  console.log(`Email to ${to}: ${result.status}`);
  return result;
}

function buildNotificationEmail(name, email, subject, message) {
  const subjectLabel = subject || '(not specified)';
  const escaped = (str) => str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px;">
<tr><td>
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);">
  <tr><td style="background:#0b1120;padding:24px 32px;">
    <div style="font-size:18px;font-weight:900;color:#fff;letter-spacing:-.02em;">overhauled.ai</div>
    <div style="font-size:12px;color:#84cc16;margin-top:3px;font-weight:600;">New Contact Form Submission</div>
  </td></tr>
  <tr><td style="padding:28px 32px;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #f0f0f0;">
          <span style="font-size:12px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;">Name</span><br>
          <span style="font-size:15px;color:#1e293b;font-weight:600;">${escaped(name)}</span>
        </td>
      </tr>
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #f0f0f0;">
          <span style="font-size:12px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;">Email</span><br>
          <span style="font-size:15px;color:#1e293b;font-weight:600;"><a href="mailto:${escaped(email)}" style="color:#84cc16;">${escaped(email)}</a></span>
        </td>
      </tr>
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #f0f0f0;">
          <span style="font-size:12px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;">Topic</span><br>
          <span style="font-size:15px;color:#1e293b;font-weight:600;">${escaped(subjectLabel)}</span>
        </td>
      </tr>
      <tr>
        <td style="padding:14px 0;">
          <span style="font-size:12px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;">Message</span><br>
          <div style="font-size:15px;color:#334155;line-height:1.65;margin-top:8px;background:#f8fafc;padding:16px;border-radius:10px;border-left:3px solid #84cc16;white-space:pre-wrap;">${escaped(message)}</div>
        </td>
      </tr>
    </table>
    <div style="margin-top:24px;">
      <a href="mailto:${escaped(email)}" style="display:inline-block;background:#84cc16;color:#0b1120;font-weight:800;font-size:14px;padding:12px 24px;border-radius:999px;text-decoration:none;">Reply to ${escaped(name)} →</a>
    </div>
  </td></tr>
  <tr><td style="padding:16px 32px;background:#f8fafc;text-align:center;">
    <span style="font-size:12px;color:#94a3b8;">Submitted via overhauled.ai/contact</span>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let name = '', email = '', subject = '', message = '', botField = '';
  try {
    const params = new URLSearchParams(event.body);
    name      = (params.get('name') || '').trim();
    email     = (params.get('email') || '').trim();
    subject   = (params.get('subject') || '').trim();
    message   = (params.get('message') || '').trim();
    botField  = params.get('bot-field') || '';
  } catch (err) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Bad request' }) };
  }

  // Honeypot — silent success for bots
  if (botField) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  if (!name || !email || !message) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields' }) };
  }

  const apiKey = process.env.RESEND_API_KEY;
  const subjectLine = subject
    ? `[Contact] ${subject} — ${name}`
    : `[Contact] New message from ${name}`;

  console.log(`[contact] New submission: ${name} <${email}> | ${subject || 'no topic'}`);

  try {
    await sendEmail(
      apiKey,
      'hello@overhauled.ai',
      subjectLine,
      buildNotificationEmail(name, email, subject, message)
    );
  } catch (err) {
    console.error('[contact] Send error:', err.message);
    // Return 200 anyway — don't expose errors to the client
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
};
