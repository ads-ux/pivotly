// netlify/functions/audit.js
// Receives health-check form submission, runs site audit, emails report to prospect.
// Requires env var: RESEND_API_KEY (get a free one at resend.com)

const https = require('https');

function httpGet(url, timeoutMs = 9000) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) { resolved = true; reject(new Error(`Timeout fetching ${url}`)); }
    }, timeoutMs);
    const req = require(url.startsWith('https') ? 'https' : 'http').get(
      url, { headers: { 'User-Agent': 'OverhauledAI-Auditor/1.0' } },
      (res) => {
        let body = ''; const MAX = 500_000;
        res.on('data', chunk => { if (body.length < MAX) body += chunk; });
        res.on('end', () => { if (!resolved) { resolved = true; clearTimeout(timer); resolve({ status: res.statusCode, headers: res.headers, body }); } });
      }
    );
    req.on('error', err => { if (!resolved) { resolved = true; clearTimeout(timer); reject(err); } });
  });
}

async function httpGetJSON(url, timeoutMs) {
  const res = await httpGet(url, timeoutMs);
  return JSON.parse(res.body);
}

function resendPost(apiKey, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request(
      { hostname: 'api.resend.com', port: 443, path: '/emails', method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => { let d = ''; res.on('data', c => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d })); }
    );
    req.on('error', reject); req.write(body); req.end();
  });
}

async function runAudit(rawUrl) {
  const siteUrl = rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`;
  const result = { url: siteUrl, hostname: '', timestamp: new Date().toISOString(), reachable: false, statusCode: null, isHttps: siteUrl.startsWith('https://'), psi: null, html: null, robots: null, sitemap: null, errors: [] };
  try { result.hostname = new URL(siteUrl).hostname; } catch (_) { result.hostname = siteUrl; }
  try { const page = await httpGet(siteUrl, 8000); result.reachable = true; result.statusCode = page.status; result.html = analyzeHTML(page.body, siteUrl); } catch (err) { result.errors.push(`Could not reach site: ${err.message}`); }
  try {
    const key = process.env.PAGESPEED_API_KEY ? `&key=${process.env.PAGESPEED_API_KEY}` : '';
    const psiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(siteUrl)}&strategy=mobile${key}`;
    const psi = await httpGetJSON(psiUrl, 20000);
    result.psi = parsePSI(psi);
  } catch (err) { result.errors.push(`PageSpeed check failed: ${err.message}`); }
  try { const r = await httpGet(new URL('/robots.txt', siteUrl).href, 5000); result.robots = { present: r.status === 200, content: r.body.slice(0, 500) }; } catch (_) { result.robots = { present: false }; }
  try { const s = await httpGet(new URL('/sitemap.xml', siteUrl).href, 5000); result.sitemap = { present: s.status === 200 }; } catch (_) { result.sitemap = { present: false }; }
  return result;
}

function analyzeHTML(html, siteUrl) {
  const tag = (re) => (html.match(re) || [])[1];
  const count = (re) => (html.match(re) || []).length;
  const titleRaw = tag(/<title[^>]*>([^<]*)<\/title>/i);
  const descRaw = tag(/meta[^>]+name=["']description["'][^>]*content=["']([^"']*)/i) || tag(/meta[^>]+content=["']([^"']*)[^>]*name=["']description["']/i);
  const forms = (html.match(/<form[^>]*>/gi) || []);
  return {
    hasTitle: !!titleRaw, titleText: (titleRaw || '').trim(), titleLength: (titleRaw || '').trim().length,
    hasMetaDesc: !!descRaw, metaDescText: (descRaw || '').trim(), metaDescLength: (descRaw || '').trim().length,
    h1Count: count(/<h1[^>]*>/gi), imageCount: count(/<img[^>]*>/gi),
    imagesMissingAlt: count(/<img(?![^>]*alt=["'][^"']+["'])[^>]*>/gi),
    hasCanonical: /rel=["']canonical["']/i.test(html), hasOpenGraph: /property=["']og:/i.test(html),
    hasStructuredData: /application\/ld\+json/i.test(html), hasMobileViewport: /name=["']viewport["']/i.test(html),
    formCount: forms.length, postFormCount: forms.filter(f => /method=["']post["']/i.test(f)).length,
    hasContactForm: forms.length > 0,
    hasPhone: /\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/.test(html),
    hasAddress: /\d+\s+\w+\s+(Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Blvd|Boulevard|Lane|Ln)/i.test(html),
    hasGoogleMaps: /google\.com\/maps|maps\.googleapis/i.test(html),
    hasAnalytics: /googletagmanager|gtag\(|_gaq|analytics\.js/i.test(html),
  };
}

function parsePSI(psi) {
  if (!psi.lighthouseResult) return null;
  const cats = psi.lighthouseResult.categories || {};
  const audits = psi.lighthouseResult.audits || {};
  const score = (cat) => cat ? Math.round(cat.score * 100) : null;
  const metricVal = (id) => audits[id]?.displayValue || null;
  const metricNum = (id) => audits[id]?.numericValue || null;
  const opportunities = Object.values(audits).filter(a => a.score !== null && a.score !== undefined && a.score < 0.9 && a.details?.type === 'opportunity').sort((a, b) => (a.score ?? 1) - (b.score ?? 1)).slice(0, 6).map(a => ({ id: a.id, title: a.title, displayValue: a.displayValue }));
  return {
    performanceScore: score(cats.performance), seoScore: score(cats.seo),
    accessibilityScore: score(cats.accessibility), bestPracticesScore: score(cats['best-practices']),
    metrics: { lcp: metricVal('largest-contentful-paint'), fcp: metricVal('first-contentful-paint'), cls: metricVal('cumulative-layout-shift'), tbt: metricVal('total-blocking-time'), si: metricVal('speed-index'), tti: metricVal('interactive'), lcpMs: metricNum('largest-contentful-paint') },
    opportunities, crawlable: audits['is-crawlable']?.score === 1,
    hasTitle: audits['document-title']?.score === 1, hasMetaDesc: audits['meta-description']?.score === 1,
    hasViewport: audits['viewport']?.score === 1, tapTargetsOk: (audits['tap-targets']?.score ?? 1) > 0.8,
  };
}

function buildIssues(audit) {
  const issues = [], wins = [], h = audit.html, p = audit.psi;
  if (!audit.reachable) { issues.push({ severity: 'critical', category: 'Access', text: 'The website could not be reached during the audit.', fix: 'Check that the domain is active and hosting is live.' }); return { issues, wins }; }
  if (!audit.isHttps) { issues.push({ severity: 'critical', category: 'Security', text: 'Site is running on HTTP, not HTTPS.', fix: 'Install an SSL certificate. Google penalises non-HTTPS sites.' }); } else { wins.push('Secure HTTPS connection'); }
  if (h) {
    if (!h.hasTitle || h.titleLength < 10) { issues.push({ severity: 'high', category: 'SEO', text: h.hasTitle ? `Title tag is very short (${h.titleLength} chars).` : 'No title tag found.', fix: 'Add a descriptive title, 50-60 characters.' }); } else if (h.titleLength > 70) { issues.push({ severity: 'medium', category: 'SEO', text: `Title tag is too long (${h.titleLength} chars).`, fix: 'Trim to under 60 characters.' }); } else { wins.push(`Good title tag: "${h.titleText.slice(0, 50)}"`); }
    if (!h.hasMetaDesc) { issues.push({ severity: 'high', category: 'SEO', text: 'No meta description found.', fix: 'Add a meta description (150-160 chars).' }); } else if (h.metaDescLength < 50) { issues.push({ severity: 'medium', category: 'SEO', text: `Meta description is very short (${h.metaDescLength} chars).`, fix: 'Expand to 120-160 characters.' }); } else { wins.push('Meta description is present'); }
    if (h.h1Count === 0) { issues.push({ severity: 'high', category: 'SEO', text: 'No H1 heading found.', fix: 'Every page needs one H1 with your main keyword phrase.' }); } else if (h.h1Count > 1) { issues.push({ severity: 'medium', category: 'SEO', text: `Found ${h.h1Count} H1 tags. Should only be one.`, fix: 'Keep exactly one H1 per page.' }); } else { wins.push('Single H1 heading in place'); }
    if (h.imagesMissingAlt > 0) { issues.push({ severity: 'medium', category: 'SEO / Accessibility', text: `${h.imagesMissingAlt} image${h.imagesMissingAlt > 1 ? 's are' : ' is'} missing alt text.`, fix: 'Add descriptive alt attributes to every image.' }); } else if (h.imageCount > 0) { wins.push('All images have alt text'); }
    if (!h.hasMobileViewport) { issues.push({ severity: 'high', category: 'Mobile', text: 'No mobile viewport meta tag found.', fix: 'Add viewport meta tag to the <head>.' }); } else { wins.push('Mobile viewport configured'); }
    if (!h.hasStructuredData) { issues.push({ severity: 'medium', category: 'SEO / AI', text: 'No structured data (Schema markup) found.', fix: 'Add LocalBusiness schema to help Google and AI tools understand your business.' }); } else { wins.push('Structured data (Schema) detected'); }
    if (!h.hasOpenGraph) { issues.push({ severity: 'low', category: 'Social', text: 'No Open Graph tags found.', fix: 'Add og:title, og:description, and og:image.' }); } else { wins.push('Open Graph tags in place'); }
    if (h.hasContactForm && h.postFormCount === 0) { issues.push({ severity: 'high', category: 'Forms', text: 'Contact form detected but does not appear to use POST method.', fix: 'Ensure form tag includes method="POST".' }); }
  }
  if (audit.robots && !audit.robots.present) { issues.push({ severity: 'low', category: 'SEO', text: 'No robots.txt file found.', fix: 'Create a robots.txt at your root.' }); } else if (audit.robots?.present) { wins.push('robots.txt is in place'); }
  if (audit.sitemap && !audit.sitemap.present) { issues.push({ severity: 'medium', category: 'SEO', text: 'No sitemap.xml found.', fix: 'Generate and submit a sitemap to Google Search Console.' }); } else if (audit.sitemap?.present) { wins.push('sitemap.xml is present'); }
  if (p) {
    if (p.performanceScore !== null) { if (p.performanceScore < 50) { issues.push({ severity: 'critical', category: 'Speed', text: `Mobile performance score is ${p.performanceScore}/100 - Poor range.`, fix: 'Compress images, enable caching, remove unused scripts.' }); } else if (p.performanceScore < 75) { issues.push({ severity: 'high', category: 'Speed', text: `Mobile performance score is ${p.performanceScore}/100 - room to improve.`, fix: 'Look at image sizes, unused JavaScript, and render-blocking resources.' }); } else { wins.push(`Good mobile performance score (${p.performanceScore}/100)`); } }
    if (p.seoScore !== null && p.seoScore < 80) { issues.push({ severity: 'high', category: 'SEO', text: `Google SEO audit score is ${p.seoScore}/100.`, fix: 'Review specific SEO flags.' }); }
    if (!p.crawlable) { issues.push({ severity: 'critical', category: 'SEO', text: 'Page appears to be blocking search engines.', fix: 'Check robots meta tag and robots.txt for noindex rules.' }); }
    if (p.metrics.lcpMs && p.metrics.lcpMs > 4000) { issues.push({ severity: 'high', category: 'Speed', text: `LCP is ${p.metrics.lcp} - Google considers >2.5s poor.`, fix: 'Compress images and use a CDN.' }); }
  }
  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);
  return { issues, wins };
}

const COLORS = { critical: '#ef4444', high: '#f97316', medium: '#f59e0b', low: '#84cc16' };
const LABELS = { critical: '🔴 Critical', high: '🟠 High Priority', medium: '🟡 Worth Fixing', low: '🟢 Nice to Have' };

function gradeFromScore(score) {
  if (score === null || score === undefined) return { grade: '-', color: '#999' };
  if (score >= 90) return { grade: 'A', color: '#22c55e' };
  if (score >= 75) return { grade: 'B', color: '#84cc16' };
  if (score >= 50) return { grade: 'C', color: '#f59e0b' };
  if (score >= 25) return { grade: 'D', color: '#f97316' };
  return { grade: 'F', color: '#ef4444' };
}

function buildReportEmail(name, url, audit) {
  const { issues, wins } = buildIssues(audit);
  const p = audit.psi;
  const perfGrade = gradeFromScore(p?.performanceScore ?? null);
  const seoGrade = gradeFromScore(p?.seoScore ?? null);
  const topIssues = issues.slice(0, 6);
  const top3Fixes = issues.slice(0, 3);
  const hostname = audit.hostname || url;

  const sc = (label, g, s) => `<td style="text-align:center;padding:20px 16px;background:#f8fafb;border-radius:10px;min-width:90px;"><div style="font-size:40px;font-weight:900;color:${g.color};">${g.grade}</div><div style="font-size:11px;font-weight:700;color:#666;text-transform:uppercase;margin-top:6px;">${label}</div>${s !== null ? `<div style="font-size:11px;color:#999;">${s}/100</div>` : ''}</td>`;
  const mb = (label, val) => val ? `<td style="text-align:center;padding:14px 10px;background:#f8fafb;border-radius:8px;"><div style="font-size:18px;font-weight:800;color:#111;">${val}</div><div style="font-size:11px;color:#666;margin-top:3px;">${label}</div></td>` : '';
  const iRows = topIssues.map(i => `<tr><td style="padding:14px 0;border-bottom:1px solid #f0f0f0;"><div style="font-size:11px;font-weight:700;color:${COLORS[i.severity]};text-transform:uppercase;margin-bottom:4px;">${LABELS[i.severity]} - ${i.category}</div><div style="font-size:14px;color:#111;margin-bottom:6px;">${i.text}</div><div style="font-size:13px;color:#555;padding-left:12px;border-left:3px solid #e5e5e5;"><strong>Fix:</strong> ${i.fix}</div></td></tr>`).join('');
  const fRows = top3Fixes.map((f, idx) => `<tr><td style="padding:12px 0;border-bottom:1px solid rgba(132,204,22,.2);"><strong style="color:#166534;">${idx + 1}. ${f.category}</strong><br><span style="font-size:14px;color:#333;">${f.fix}</span></td></tr>`).join('');
  const wList = wins.slice(0, 6).map(w => `<li>${w}</li>`).join('');
  const opps = (p?.opportunities || []).slice(0, 4).map(o => `<li><strong>${o.title}</strong>${o.displayValue ? ` - ${o.displayValue}` : ''}</li>`).join('');
  const llm = `<h2 style="font-size:16px;font-weight:800;color:#111;margin:28px 0 8px;">🤖 AI & LLM Visibility (Perplexity, ChatGPT, Google AI)</h2><p style="font-size:14px;color:#444;margin:0 0 10px;">As people increasingly ask AI instead of Googling, being cited matters. Key signals:</p><table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:14px;">${audit.html?.hasStructuredData ? '✅' : '❌'} <strong>Structured data (Schema.org)</strong> - ${audit.html?.hasStructuredData ? 'Detected.' : 'Missing - the #1 signal AI tools use.'}</td></tr><tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:14px;">${audit.html?.hasTitle && audit.html?.hasMetaDesc ? '✅' : '❌'} <strong>Clear page identity</strong> - ${audit.html?.hasTitle && audit.html?.hasMetaDesc ? 'Title and description in place.' : 'Title or description missing.'}</td></tr><tr><td style="padding:8px 0;font-size:14px;">${audit.html?.hasPhone ? '✅' : '⚠️'} <strong>Local signals (phone/address)</strong> - ${audit.html?.hasPhone ? 'Phone detected.' : 'No phone number found - critical for local search.'}</td></tr></table>`;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;background:#f1f5f9;font-family:-apple-system,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px;"><tr><td><table width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;"><tr><td style="background:#0b1120;padding:28px 36px;text-align:center;"><div style="font-size:22px;font-weight:900;color:#fff;">overhauled.ai</div><div style="font-size:13px;color:#84cc16;margin-top:4px;">Website Health Report - ${hostname}</div></td></tr><tr><td style="padding:36px;"><p style="font-size:16px;color:#1e293b;margin:0 0 8px;">Hi ${name || 'there'},</p><p style="font-size:14px;color:#475569;margin:0 0 24px;">Full audit complete for <strong>${url}</strong>. Here's everything I found.</p>${(p != null && (p.performanceScore !== null || p.seoScore !== null)) ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;"><tr>${p?.performanceScore !== null ? sc('Performance', perfGrade, p.performanceScore) : ''}${p.performanceScore !== null && p.seoScore !== null ? '<td style="width:12px;"></td>' : ''}${p?.seoScore !== null ? sc('SEO', seoGrade, p.seoScore) : ''}${p.accessibilityScore !== null ? '<td style="width:12px;"></td>' : ''}${p?.accessibilityScore !== null ? sc('Accessibility', gradeFromScore(p.accessibilityScore), p.accessibilityScore) : ''}</tr></table>` : ''}${p?.metrics?.lcp ? `<h2 style="font-size:16px;font-weight:800;color:#111;margin:0 0 8px;">⚡ Speed (Mobile)</h2><table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;"><tr>${mb('LCP', p.metrics.lcp)}${mb('FCP', p.metrics.fcp)}${mb('CLS', p.metrics.cls)}${mb('Speed Index', p.metrics.si)}</tr></table>` : ''}${topIssues.length > 0 ? `<h2 style="font-size:16px;font-weight:800;color:#111;margin:0 0 8px;">🔍 Issues Found (${topIssues.length})</h2><table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">${iRows}</table>` : '<p style="color:#22c55e;font-weight:700;">✅ No major issues found.</p>'}${top3Fixes.length > 0 ? `<div style="background:#f0fdf4;border:2px solid #84cc16;border-radius:12px;padding:20px;margin-bottom:28px;"><h2 style="color:#14532d;font-size:16px;margin:0 0 12px;">🛠 The 3 Things Worth Fixing First</h2><table width="100%" cellpadding="0" cellspacing="0">${fRows}</table></div>` : ''}${opps ? `<h2 style="font-size:16px;font-weight:800;color:#111;margin:0 0 8px;">🚀 Speed Opportunities</h2><ul style="font-size:14px;color:#333;padding-left:18px;margin:0 0 24px;">${opps}</ul>` : ''}${llm}${wList ? `<h2 style="font-size:16px;font-weight:800;color:#111;margin:24px 0 8px;">✅ What's Already Working</h2><ul style="font-size:14px;color:#444;padding-left:18px;margin:0 0 24px;line-height:1.8;">${wList}</ul>` : ''}<div style="background:#0b1120;border-radius:12px;padding:28px;text-align:center;margin-top:8px;"><p style="color:#84cc16;font-weight:700;font-size:13px;margin:0 0 6px;text-transform:uppercase;">Want these fixed?</p><p style="color:#fff;font-size:16px;font-weight:700;margin:0 0 18px;">Book a free 30-min call and I'll walk through exactly what to fix.</p><a href="https://calendly.com/ads-rtu/vrume-quick-connect" style="background:#84cc16;color:#0b1120;font-weight:800;font-size:15px;padding:14px 32px;border-radius:999px;text-decoration:none;display:inline-block;">Book Free Call</a></div><p style="font-size:12px;color:#94a3b8;margin:24px 0 0;text-align:center;">By Mark at <a href="https://overhauled.ai" style="color:#84cc16;">overhauled.ai</a> - Guelph, ON - <a href="mailto:hello@overhauled.ai" style="color:#84cc16;">hello@overhauled.ai</a></p></td></tr></table></td></tr></table></body></html>`;
}

function buildNotifyEmail(name, email, phone, url, audit) {
  const { issues } = buildIssues(audit); const p = audit.psi;
  return `<h2>New health check submitted</h2><p><strong>Site:</strong> ${url}<br><strong>Name:</strong> ${name}<br><strong>Email:</strong> ${email}<br><strong>Phone:</strong> ${phone || '(not provided)'}</p><p><strong>Performance:</strong> ${p?.performanceScore ?? 'N/A'}/100<br><strong>SEO:</strong> ${p?.seoScore ?? 'N/A'}/100<br><strong>Issues:</strong> ${issues.length}</p><ol>${issues.slice(0,5).map(i=>`<li>[${i.severity.toUpperCase()}] ${i.category}: ${i.text}</li>`).join('')}</ol>`;
}

async function sendEmail(apiKey, to, subject, html, from = 'Mark @ Overhauled.ai <hello@overhauled.ai>') {
  if (!apiKey) { console.log(`[email skipped] To: ${to}`); return; }
  const result = await resendPost(apiKey, { from, to: [to], subject, html });
  console.log(`Email to ${to}: ${result.status}`); return result;
}

exports.handler = async function (event) {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  let rawUrl = '', email = '', name = 'there', phone = '', botField = '';
  try { const params = new URLSearchParams(event.body); rawUrl = (params.get('url') || params.get('website') || '').trim(); email = (params.get('email') || '').trim(); name = (params.get('name') || 'there').trim(); phone = (params.get('phone') || '').trim(); botField = params.get('bot-field') || ''; } catch (err) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Bad request' }) }; }
  if (botField) return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  if (!rawUrl || !email) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing url or email' }) };
  const apiKey = process.env.RESEND_API_KEY;
  console.log(`[audit] Starting: ${rawUrl} | ${email} | ${name}`);
  let audit;
  try { audit = await runAudit(rawUrl); } catch (err) { console.error('[audit] Fatal:', err); await sendEmail(apiKey, 'hello@overhauled.ai', `[Audit Failed] ${rawUrl}`, `<p>Failed for ${rawUrl}. By: ${name} <${email}>. Error: ${err.message}</p>`).catch(()=>{}); return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) }; }
  const hostname = audit.hostname || rawUrl;
  await Promise.allSettled([
    sendEmail(apiKey, email, `Your Overhauled.ai Site Report - ${hostname}`, buildReportEmail(name, rawUrl, audit)),
    sendEmail(apiKey, 'hello@overhauled.ai', `[New Audit] ${hostname} - ${name} <${email}>`, buildNotifyEmail(name, email, phone, rawUrl, audit)),
  ]);
  console.log('[audit] Complete');
  return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
};
