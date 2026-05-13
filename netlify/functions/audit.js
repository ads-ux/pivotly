// netlify/functions/audit.js
// Receives health-check form submission, runs site audit, emails report to prospect.
// Requires env var: RESEND_API_KEY (get a free one at resend.com)

const https = require('https');

// ─── HTTP helpers ────────────────────────────────────────────────────────────

function httpGet(url, timeoutMs = 9000) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) { resolved = true; reject(new Error(`Timeout fetching ${url}`)); }
    }, timeoutMs);

    const req = require(url.startsWith('https') ? 'https' : 'http').get(
      url,
      { headers: { 'User-Agent': 'OverhauledAI-Auditor/1.0' } },
      (res) => {
        let body = '';
        const MAX = 500_000; // 500 KB cap
        res.on('data', chunk => { if (body.length < MAX) body += chunk; });
        res.on('end', () => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            resolve({ status: res.statusCode, headers: res.headers, body });
          }
        });
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

// ─── Audit engine ────────────────────────────────────────────────────────────

async function runAudit(rawUrl) {
  const siteUrl = rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`;
  const result = {
    url: siteUrl,
    hostname: '',
    timestamp: new Date().toISOString(),
    reachable: false,
    statusCode: null,
    isHttps: siteUrl.startsWith('https://'),
    psi: null,
    html: null,
    robots: null,
    sitemap: null,
    errors: [],
  };

  try { result.hostname = new URL(siteUrl).hostname; } catch (_) { result.hostname = siteUrl; }

  // 1. Fetch HTML
  try {
    const page = await httpGet(siteUrl, 8000);
    result.reachable = true;
    result.statusCode = page.status;
    result.html = analyzeHTML(page.body, siteUrl);
  } catch (err) {
    result.errors.push(`Could not reach site: ${err.message}`);
  }

  // 2. PageSpeed Insights (mobile) — with 20 s timeout (function max ~26 s)
  try {
    const key = process.env.PAGESPEED_API_KEY ? `&key=${process.env.PAGESPEED_API_KEY}` : '';
    const psiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(siteUrl)}&strategy=mobile${key}`;
    const psi = await httpGetJSON(psiUrl, 20000);
    result.psi = parsePSI(psi);
  } catch (err) {
    result.errors.push(`PageSpeed check failed: ${err.message}`);
  }

  // 3. robots.txt
  try {
    const r = await httpGet(new URL('/robots.txt', siteUrl).href, 5000);
    result.robots = { present: r.status === 200, content: r.body.slice(0, 500) };
  } catch (_) {
    result.robots = { present: false };
  }

  // 4. sitemap.xml
  try {
    const s = await httpGet(new URL('/sitemap.xml', siteUrl).href, 5000);
    result.sitemap = { present: s.status === 200 };
  } catch (_) {
    result.sitemap = { present: false };
  }

  return result;
}

function analyzeHTML(html, siteUrl) {
  const tag = (re) => (html.match(re) || [])[1];
  const count = (re) => (html.match(re) || []).length;

  const titleRaw = tag(/<title[^>]*>([^<]*)<\/title>/i);
  const descRaw = tag(/meta[^>]+name=["']description["'][^>]*content=["']([^"']*)/i)
    || tag(/meta[^>]+content=["']([^"']*)[^>]*name=["']description["']/i);
  const h1s = count(/<h1[^>]*>/gi);
  const images = count(/<img[^>]*>/gi);
  const imagesNoAlt = count(/<img(?![^>]*alt=["'][^"']+["'])[^>]*>/gi);
  const forms = (html.match(/<form[^>]*>/gi) || []);
  const postForms = forms.filter(f => /method=["']post["']/i.test(f)).length;

  return {
    hasTitle: !!titleRaw,
    titleText: (titleRaw || '').trim(),
    titleLength: (titleRaw || '').trim().length,
    hasMetaDesc: !!descRaw,
    metaDescText: (descRaw || '').trim(),
    metaDescLength: (descRaw || '').trim().length,
    h1Count: h1s,
    imageCount: images,
    imagesMissingAlt: imagesNoAlt,
    hasCanonical: /rel=["']canonical["']/i.test(html),
    hasOpenGraph: /property=["']og:/i.test(html),
    hasStructuredData: /application\/ld\+json/i.test(html),
    hasMobileViewport: /name=["']viewport["']/i.test(html),
    formCount: forms.length,
    postFormCount: postForms,
    hasContactForm: forms.length > 0,
    hasPhone: /\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/.test(html),
    hasAddress: /\d+\s+\w+\s+(Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Blvd|Boulevard|Lane|Ln)/i.test(html),
    hasGoogleMaps: /google\.com\/maps|maps\.googleapis/i.test(html),
    hasAnalytics: /googletagmanager|gtag\(|_gaq|analytics\.js|gtm\.js/i.test(html),
    isWordPress: /wp-content|wp-includes/i.test(html),
    isShopify: /cdn\.shopify\.com/i.test(html),
  };
}

function parsePSI(psi) {
  if (!psi.lighthouseResult) return null;
  const cats = psi.lighthouseResult.categories || {};
  const audits = psi.lighthouseResult.audits || {};

  const score = (cat) => cat ? Math.round(cat.score * 100) : null;

  const metricVal = (id) => audits[id]?.displayValue || null;
  const metricNum = (id) => audits[id]?.numericValue || null;

  // Opportunities: passed = 1, failed < 1
  const opportunities = Object.values(audits)
    .filter(a => a.score !== null && a.score !== undefined && a.score < 0.9 && a.details?.type === 'opportunity')
    .sort((a, b) => (a.score ?? 1) - (b.score ?? 1))
    .slice(0, 6)
    .map(a => ({ id: a.id, title: a.title, displayValue: a.displayValue }));

  const diagnostics = Object.values(audits)
    .filter(a => a.score !== null && a.score !== undefined && a.score < 0.9 && a.details?.type !== 'opportunity' && a.title)
    .filter(a => [
      'render-blocking-resources', 'uses-optimized-images', 'uses-text-compression',
      'uses-responsive-images', 'efficient-animated-content', 'unused-javascript',
      'unused-css-rules', 'image-alt', 'document-title', 'meta-description',
      'is-crawlable', 'link-text', 'tap-targets', 'viewport',
    ].includes(a.id))
    .sort((a, b) => (a.score ?? 1) - (b.score ?? 1))
    .slice(0, 6)
    .map(a => ({ id: a.id, title: a.title, score: a.score }));

  return {
    performanceScore: score(cats.performance),
    seoScore: score(cats.seo),
    accessibilityScore: score(cats.accessibility),
    bestPracticesScore: score(cats['best-practices']),
    metrics: {
      lcp: metricVal('largest-contentful-paint'),
      fcp: metricVal('first-contentful-paint'),
      cls: metricVal('cumulative-layout-shift'),
      tbt: metricVal('total-blocking-time'),
      si: metricVal('speed-index'),
      tti: metricVal('interactive'),
      lcpMs: metricNum('largest-contentful-paint'),
    },
    opportunities,
    diagnostics,
    crawlable: audits['is-crawlable']?.score === 1,
    hasTitle: audits['document-title']?.score === 1,
    hasMetaDesc: audits['meta-description']?.score === 1,
    hasViewport: audits['viewport']?.score === 1,
    tapTargetsOk: (audits['tap-targets']?.score ?? 1) > 0.8,
  };
}

// ─── Issue generation (plain English) ────────────────────────────────────────

function buildIssues(audit) {
  const issues = []; // { severity, category, text, fix }
  const wins = [];
  const h = audit.html;
  const p = audit.psi;

  // Reachability
  if (!audit.reachable) {
    issues.push({ severity: 'critical', category: 'Access', text: "Your website couldn't be reached during the audit.", fix: "Check that your domain is active and your hosting is running. If visitors can't reach your site, every minute it's down is lost business." });
    return { issues, wins };
  }

  // HTTPS
  if (!audit.isHttps) {
    issues.push({ severity: 'critical', category: 'Security', text: 'Your site shows a "Not Secure" warning in browsers.', fix: "Install an SSL certificate — it's usually free through your hosting provider. Until you do, visitors see a scary security warning before they even see your content. Most will leave immediately." });
  } else {
    wins.push('Your site has a security certificate — visitors see the padlock ✓');
  }

  if (h) {
    // Title
    if (!h.hasTitle || h.titleLength < 10) {
      issues.push({ severity: 'high', category: 'Google Visibility', text: h.hasTitle ? 'Your page headline in Google is too short to be useful.' : "Your site has no headline in Google search results — Google makes one up, and it's usually wrong.", fix: "Write a title like \"Plumber in Guelph | Joe's Plumbing — 24/7 Emergency Service\" (50–60 characters). This is the first thing people see in Google — make it count." });
    } else if (h.titleLength > 70) {
      issues.push({ severity: 'medium', category: 'Google Visibility', text: 'Your Google headline is too long — it gets cut off in search results, so people can\'t read the full thing.', fix: 'Trim your title to under 60 characters. Lead with your most important keywords and your location if you\'re a local business.' });
    } else {
      wins.push(`Your page title shows up well in Google search results ✓`);
    }

    // Meta description
    if (!h.hasMetaDesc) {
      issues.push({ severity: 'high', category: 'Google Visibility', text: "When your site shows up in Google, there's no description — so Google grabs random text from your page, which often looks terrible and confuses people.", fix: "Write a 1–2 sentence description (150–160 chars) that explains what you do and why someone should click. Example: \"Guelph's most trusted family plumber since 1998. Available 24/7 for emergency callouts. Call today for a free quote.\"" });
    } else if (h.metaDescLength < 50) {
      issues.push({ severity: 'medium', category: 'Google Visibility', text: "Your Google description is very short — you're not giving people a good reason to click on your site over a competitor.", fix: 'Expand your description to 120–160 characters. Include what you do, who you serve, and a clear call to action.' });
    } else {
      wins.push('You have a Google description set up ✓');
    }

    // H1
    if (h.h1Count === 0) {
      issues.push({ severity: 'high', category: 'Page Structure', text: 'Your page has no main headline — both visitors and Google need this to understand what your page is about.', fix: 'Add one clear headline to your page. Make it describe what you do and where — like "Trusted Plumber Serving Guelph & Waterloo Region". Your web developer can add this in minutes.' });
    } else if (h.h1Count > 1) {
      issues.push({ severity: 'medium', category: 'Page Structure', text: `Your page has ${h.h1Count} main headlines — there should only be one. Google gets confused about which one represents the page.`, fix: 'Keep exactly one main headline per page. Turn the extras into sub-headings instead.' });
    } else {
      wins.push('Your page has one clear main headline ✓');
    }

    // Images
    if (h.imagesMissingAlt > 0) {
      issues.push({ severity: 'medium', category: 'Accessibility & SEO', text: `${h.imagesMissingAlt} of your images have no description. Google can't actually "see" images — it relies on these text descriptions to understand what they show.`, fix: 'Add a short description to every image (called "alt text"). For a photo of your team, write something like "The Smith Plumbing team outside our Guelph office". It also helps visually impaired visitors using screen readers.' });
    } else if (h.imageCount > 0) {
      wins.push('All your images have descriptions that Google can read ✓');
    }

    // Mobile viewport
    if (!h.hasMobileViewport) {
      issues.push({ severity: 'high', category: 'Mobile', text: "Your site is probably broken on phones — pages load zoomed out and tiny, making it impossible to read without pinching and zooming.", fix: "This is a one-line fix your web developer needs to add to the page header. Over 60% of web traffic is on phones — if your site doesn't work on mobile, you're losing the majority of your visitors." });
    } else {
      wins.push('Your site is set up for mobile visitors ✓');
    }

    // Structured data
    if (!h.hasStructuredData) {
      issues.push({ severity: 'medium', category: 'AI & Local Search', text: "Your business details aren't in a format that Google's AI or local search can understand — you're likely missing out on \"near me\" searches and AI-generated recommendations.", fix: 'Add "Schema markup" to your site — a bit of code that tells Google (and AI tools like ChatGPT and Perplexity) your business name, address, phone, hours, and what you do. This is how you get featured in AI search results.' });
    } else {
      wins.push('Your site has Schema markup for AI and local search ✓');
    }

    // Open Graph
    if (!h.hasOpenGraph) {
      issues.push({ severity: 'low', category: 'Social Media', text: "When someone shares your website link on Facebook, LinkedIn, or in a text message, it shows up with no image and no description — just a bare link that nobody clicks.", fix: 'Add Open Graph tags (a few lines of code) to control what image and description shows when your site is shared. Costs nothing, makes a big difference to how professional you look online.' });
    } else {
      wins.push('Your site shows a proper preview when shared on social media ✓');
    }

    // Contact form check
    if (h.hasContactForm && h.postFormCount === 0) {
      issues.push({ severity: 'high', category: 'Contact Form', text: "You have a contact form, but it may not be sending messages correctly — visitors who fill it out might think they've contacted you, but you never receive it.", fix: 'Test your contact form right now by filling it out yourself and checking if the email arrives. If not, your web developer needs to fix the form configuration.' });
    }
  }

  // robots.txt
  if (audit.robots && !audit.robots.present) {
    issues.push({ severity: 'low', category: 'Technical', text: 'A small technical file that helps Google navigate your site is missing.', fix: "Create a robots.txt file — it's a simple text file that your developer or web host can add quickly. At minimum it should point Google to your sitemap." });
  } else if (audit.robots?.present) {
    wins.push("Google has the navigation guide it needs (robots.txt) ✓");
  }

  // sitemap.xml
  if (audit.sitemap && !audit.sitemap.present) {
    issues.push({ severity: 'medium', category: 'Technical', text: "Google doesn't have a map of your site pages — some of your pages may never be discovered or shown in search results.", fix: "Generate a sitemap (most website platforms do this automatically or with a free plugin) and submit it to Google Search Console. This tells Google about every page on your site." });
  } else if (audit.sitemap?.present) {
    wins.push('Google has a map of all your site pages (sitemap.xml) ✓');
  }

  // Performance
  if (p) {
    if (p.performanceScore !== null) {
      if (p.performanceScore < 50) {
        issues.push({ severity: 'critical', category: 'Page Speed', text: `Your site loads very slowly on phones (score: ${p.performanceScore}/100). Most visitors give up and leave before it finishes loading — you're losing real customers every single day.`, fix: "Speed is the highest-ROI fix you can make. Common causes: images that are too large, too many scripts, cheap hosting. A developer can often cut load time in half in just a few hours." });
      } else if (p.performanceScore < 75) {
        issues.push({ severity: 'high', category: 'Page Speed', text: `Your site is slower than it should be on mobile (score: ${p.performanceScore}/100) — some visitors are leaving before it fully loads.`, fix: 'Start by compressing your images (the quickest win), then ask your developer about lazy loading and removing unused scripts.' });
      } else {
        wins.push(`Your site loads at a good speed on mobile (score: ${p.performanceScore}/100) ✓`);
      }
    }

    if (p.seoScore !== null && p.seoScore < 80) {
      issues.push({ severity: 'high', category: 'Google Ranking', text: `Google's own SEO audit flagged problems with your site (score: ${p.seoScore}/100). This is directly affecting where you show up in search results.`, fix: 'Review the specific issues listed in this report. Each one you fix is a step up in Google rankings.' });
    }

    if (!p.crawlable) {
      issues.push({ severity: 'critical', category: 'Google Visibility', text: "Your site is accidentally telling Google NOT to show it in search results — this is like putting a permanent \"Closed\" sign in your window.", fix: 'Check your page\'s robots meta tag and your robots.txt file for "noindex" or "Disallow: /" — remove them immediately. This is urgent and needs fixing today.' });
    }

    if (p.metrics.lcpMs && p.metrics.lcpMs > 4000) {
      issues.push({ severity: 'high', category: 'Page Speed', text: `The main content on your page takes ${p.metrics.lcp} to appear on screen. Google considers anything over 2.5 seconds "poor" — and so do most visitors.`, fix: "Your biggest image or content block is loading too slowly. Compress images, use a content delivery network (CDN), and consider upgrading from cheap shared hosting." });
    }
  }

  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);

  return { issues, wins };
}

// ─── Business opportunities ───────────────────────────────────────────────────

function buildBusinessInsights(audit) {
  const tips = [];
  const h = audit.html;
  const p = audit.psi;

  if (h && !h.hasContactForm && !h.hasPhone) {
    tips.push({ icon: '📞', title: "Make it easy for people to reach you", body: "Your site has no visible contact form or phone number. People who can't easily reach you don't wait — they call your competitor instead. Add your phone number to the top of every page and include a simple contact form. This is often the single biggest conversion improvement a local business can make." });
  } else if (h && !h.hasPhone) {
    tips.push({ icon: '📱', title: "Put your phone number front and centre", body: "Many buyers — especially for higher-value or urgent purchases — want to call before committing. If your number isn't visible at the very top of your page, you're losing those calls to someone who made it easier." });
  }

  if (h && !h.hasAddress) {
    tips.push({ icon: '📍', title: "Show where you're located", body: "People trust local businesses more when they can see a real address. A visible address also signals to Google that you're a legitimate local business, which helps you show up in map searches and 'near me' results — where a huge portion of buying decisions happen for service businesses." });
  }

  if (h && !h.hasAnalytics) {
    tips.push({ icon: '📊', title: "Install website analytics — it's free", body: "Right now you have no way to know how many people visit your site, where they come from, or what they do before leaving. Google Analytics is free and takes about 15 minutes to set up. This data changes how you make every marketing decision — you'll wonder how you managed without it." });
  }

  if (h && !h.hasGoogleMaps) {
    tips.push({ icon: '🗺️', title: "Embed a Google Map on your contact page", body: "Adding a Google Map makes it easier for customers to find you physically, and it signals to Google that you're a verified local business. It takes about 2 minutes to add and quietly boosts your local search rankings." });
  }

  if (p && p.performanceScore !== null && p.performanceScore < 60) {
    tips.push({ icon: '💸', title: "Slow sites cost you real money", body: "Google's research shows that for every 1 second your site takes to load, you lose approximately 7% of potential conversions. If your site takes 5 seconds on mobile, you could be losing up to 35% of the customers who found you — before they even see what you offer. Speed fixes often pay for themselves within weeks." });
  }

  if (h && h.isWordPress) {
    tips.push({ icon: '🔒', title: "Keep your WordPress site updated", body: "WordPress is the world's most targeted platform for hackers — almost always through outdated plugins and themes. Check that your plugins, themes, and WordPress core are all up to date. If you're not sure who manages this, it's worth finding out. A hacked site can disappear from Google overnight." });
  }

  if (h && !h.hasStructuredData) {
    tips.push({ icon: '🤖', title: "Get found when people ask AI assistants", body: "When someone asks ChatGPT, Siri, or Google's AI 'find me a [your service] near [city]', sites with Schema markup are far more likely to be recommended. Adding this code is a one-time task — your developer can do it in an hour — and the benefits compound over time as AI search grows." });
  }

  tips.push({ icon: '⭐', title: "Are customer reviews visible on your site?", body: "Reviews are the #1 trust signal for new customers who've never heard of you. If you have Google reviews or testimonials, make sure they're prominently displayed on your homepage — not buried on a separate page. If you don't have reviews yet, start asking happy customers this week. Even 5 genuine reviews can significantly improve how many visitors convert into enquiries." });

  tips.push({ icon: '🎯', title: "Is your 'one thing' obvious within 3 seconds?", body: "When someone lands on your site for the first time, they should instantly understand: what you do, who you help, and what to do next. If they have to scroll or read carefully to figure it out, you're losing them. Try showing your homepage to a friend who's never seen it and ask them what you do — their answer will tell you everything." });

  return tips.slice(0, 6);
}

// ─── Email template ───────────────────────────────────────────────────────────

function buildReportEmail(name, url, audit) {
  const { issues, wins } = buildIssues(audit);
  const businessTips = buildBusinessInsights(audit);
  const p = audit.psi;
  const h = audit.html;
  const hostname = audit.hostname || url;
  const firstName = (name && name !== 'there') ? name.split(' ')[0] : 'there';

  const criticalCount = issues.filter(i => i.severity === 'critical').length;
  const highCount = issues.filter(i => i.severity === 'high').length;
  const top3Fixes = issues.slice(0, 3);

  // Plain-English summary
  let summaryText = '';
  if (criticalCount > 0) {
    summaryText = `I found ${criticalCount} critical problem${criticalCount > 1 ? 's' : ''} that ${criticalCount > 1 ? 'are' : 'is'} likely costing you customers right now. There ${issues.length !== 1 ? 'are' : 'is'} ${issues.length} issue${issues.length !== 1 ? 's' : ''} in total — the most urgent ones are at the top of the list below.`;
  } else if (highCount > 0) {
    summaryText = `No critical problems — but I found ${highCount} important issue${highCount > 1 ? 's' : ''} that ${highCount > 1 ? 'are' : 'is'} likely holding back your search rankings and the number of enquiries you get. The good news: most are straightforward fixes.`;
  } else if (issues.length > 0) {
    summaryText = `Your site is in decent shape — no major problems. I found ${issues.length} smaller thing${issues.length !== 1 ? 's' : ''} worth improving, plus some business opportunities below that could help you get more leads from the traffic you already have.`;
  } else {
    summaryText = "Your site is in great shape — no significant issues found. I've included some business tips and growth ideas below that might still be useful.";
  }

  // Plain-English readouts
  let speedReadout = '⚪ Speed score unavailable this run';
  if (p && p.performanceScore !== null) {
    if (p.performanceScore >= 75) speedReadout = `🟢 Loads quickly on phones (${p.performanceScore}/100) — good`;
    else if (p.performanceScore >= 50) speedReadout = `🟡 A bit slow on phones (${p.performanceScore}/100) — room to improve`;
    else speedReadout = `🔴 Very slow on phones (${p.performanceScore}/100) — visitors are leaving`;
  }

  let seoReadout = '⚪ SEO score unavailable this run';
  if (p && p.seoScore !== null) {
    if (p.seoScore >= 80) seoReadout = `🟢 Google can read and understand your site well (${p.seoScore}/100)`;
    else if (p.seoScore >= 60) seoReadout = `🟡 Some issues affecting how Google ranks you (${p.seoScore}/100)`;
    else seoReadout = `🔴 Google is struggling to understand your site (${p.seoScore}/100)`;
  }

  const mobileReadout = h?.hasMobileViewport
    ? '🟢 Works properly on phones and tablets'
    : '🔴 Likely broken on phones — needs fixing urgently';

  const httpsReadout = audit.isHttps
    ? '🟢 Secure — visitors see a padlock, not a warning'
    : '🔴 Not secure — browsers are showing visitors a "Not Secure" warning';

  // Colour coding
  const SEV_COLOR = { critical: '#ef4444', high: '#f97316', medium: '#f59e0b', low: '#84cc16' };
  const SEV_LABEL = { critical: '🔴 Urgent', high: '🟠 Important', medium: '🟡 Worth Fixing', low: '🟢 Minor' };

  const issueRows = issues.map(i => `
    <tr>
      <td style="padding:18px 0;border-bottom:1px solid #f0f0f0;">
        <div style="font-size:11px;font-weight:700;color:${SEV_COLOR[i.severity]};text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px;">${SEV_LABEL[i.severity]} · ${i.category}</div>
        <div style="font-size:15px;color:#111;font-weight:600;margin-bottom:10px;line-height:1.4;">${i.text}</div>
        <div style="font-size:13px;color:#444;background:#f8f9fa;padding:12px 14px;border-radius:8px;border-left:3px solid ${SEV_COLOR[i.severity]};line-height:1.6;"><strong>What to do:</strong> ${i.fix}</div>
      </td>
    </tr>`).join('');

  const fixRows = top3Fixes.map((f, idx) => `
    <tr>
      <td style="padding:14px 0;border-bottom:1px solid rgba(132,204,22,.25);">
        <table cellpadding="0" cellspacing="0"><tr>
          <td style="vertical-align:top;padding-right:14px;">
            <div style="width:28px;height:28px;background:#84cc16;border-radius:50%;text-align:center;line-height:28px;font-weight:900;color:#0b1120;font-size:14px;">${idx + 1}</div>
          </td>
          <td style="vertical-align:top;">
            <strong style="color:#14532d;font-size:15px;display:block;margin-bottom:4px;">${f.category}</strong>
            <span style="font-size:14px;color:#333;line-height:1.5;">${f.fix}</span>
          </td>
        </tr></table>
      </td>
    </tr>`).join('');

  const tipRows = businessTips.map(t => `
    <tr>
      <td style="padding:18px 0;border-bottom:1px solid #f0f0f0;">
        <div style="font-size:15px;font-weight:700;color:#0b1120;margin-bottom:8px;">${t.icon} ${t.title}</div>
        <div style="font-size:14px;color:#444;line-height:1.65;">${t.body}</div>
      </td>
    </tr>`).join('');

  const winRows = wins.slice(0, 8).map(w => `
    <tr><td style="padding:9px 0;border-bottom:1px solid #f0f0f0;font-size:14px;color:#333;">${w}</td></tr>`).join('');

  // Speed metrics in plain English
  let metricsSection = '';
  if (p?.metrics?.lcp || p?.metrics?.fcp) {
    const lcpFlag = p.metrics.lcpMs ? (p.metrics.lcpMs > 4000 ? '🔴 ' : p.metrics.lcpMs > 2500 ? '🟡 ' : '🟢 ') : '';
    metricsSection = `
    <h2 style="font-size:17px;font-weight:800;color:#111;margin:32px 0 6px;">⚡ How Fast Does Your Site Feel?</h2>
    <p style="font-size:14px;color:#64748b;margin:0 0 16px;">Measured on a phone with a typical connection — the way most of your visitors experience your site.</p>
    <table width="100%" cellpadding="8" cellspacing="4" style="margin-bottom:8px;">
      <tr>
        ${p.metrics.lcp ? `<td style="text-align:center;padding:14px 10px;background:#f8fafb;border-radius:8px;">
          <div style="font-size:19px;font-weight:800;color:#111;">${lcpFlag}${p.metrics.lcp}</div>
          <div style="font-size:12px;color:#555;margin-top:5px;">How long until the main content appears</div>
          <div style="font-size:11px;color:#999;margin-top:2px;">Good = under 2.5 seconds</div>
        </td>` : ''}
        ${p.metrics.fcp ? `<td style="text-align:center;padding:14px 10px;background:#f8fafb;border-radius:8px;">
          <div style="font-size:19px;font-weight:800;color:#111;">${p.metrics.fcp}</div>
          <div style="font-size:12px;color:#555;margin-top:5px;">How long until anything appears at all</div>
          <div style="font-size:11px;color:#999;margin-top:2px;">Good = under 1.8 seconds</div>
        </td>` : ''}
        ${p.metrics.cls ? `<td style="text-align:center;padding:14px 10px;background:#f8fafb;border-radius:8px;">
          <div style="font-size:19px;font-weight:800;color:#111;">${p.metrics.cls}</div>
          <div style="font-size:12px;color:#555;margin-top:5px;">How much things jump around while loading</div>
          <div style="font-size:11px;color:#999;margin-top:2px;">Good = under 0.1</div>
        </td>` : ''}
      </tr>
    </table>
    <p style="font-size:12px;color:#94a3b8;margin:4px 0 28px;">The "things jumping around" score matters because if your page moves while someone's trying to click something, it creates a frustrating experience — and Google penalises it.</p>`;
  }

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px;">
<tr><td>
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,.08);">

  <!-- Header -->
  <tr><td style="background:#0b1120;padding:28px 36px;text-align:center;">
    <div style="font-size:22px;font-weight:900;color:#fff;letter-spacing:-.02em;">overhauled.ai</div>
    <div style="font-size:13px;color:#84cc16;margin-top:4px;font-weight:600;">Website Health Report</div>
    <div style="font-size:12px;color:#64748b;margin-top:6px;">${hostname}</div>
  </td></tr>

  <!-- Body -->
  <tr><td style="padding:36px 36px 32px;">

    <p style="font-size:17px;color:#1e293b;margin:0 0 6px;font-weight:600;">Hi ${firstName},</p>
    <p style="font-size:15px;color:#475569;margin:0 0 24px;line-height:1.6;">I've finished the full audit on <strong>${url}</strong>. Everything below is written in plain English — no tech jargon, just an honest picture of what's working, what isn't, and what to do about it.</p>

    <!-- Plain English Summary -->
    <div style="background:#f8fafc;border-radius:12px;padding:20px 24px;margin-bottom:28px;border-left:4px solid #84cc16;">
      <p style="font-size:12px;font-weight:700;color:#64748b;margin:0 0 8px;text-transform:uppercase;letter-spacing:.06em;">The short version</p>
      <p style="font-size:15px;color:#1e293b;margin:0;line-height:1.65;">${summaryText}</p>
    </div>

    <!-- Quick Readout -->
    <h2 style="font-size:17px;font-weight:800;color:#111;margin:0 0 12px;">📋 Your Site at a Glance</h2>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
      <tr><td style="padding:11px 0;border-bottom:1px solid #f0f0f0;font-size:14px;color:#333;">${speedReadout}</td></tr>
      <tr><td style="padding:11px 0;border-bottom:1px solid #f0f0f0;font-size:14px;color:#333;">${seoReadout}</td></tr>
      <tr><td style="padding:11px 0;border-bottom:1px solid #f0f0f0;font-size:14px;color:#333;">${mobileReadout}</td></tr>
      <tr><td style="padding:11px 0;font-size:14px;color:#333;">${httpsReadout}</td></tr>
    </table>

    ${metricsSection}

    ${issues.length > 0 ? `
    <!-- Issues -->
    <h2 style="font-size:17px;font-weight:800;color:#111;margin:0 0 4px;">🔍 What I Found (${issues.length} issue${issues.length !== 1 ? 's' : ''})</h2>
    <p style="font-size:13px;color:#64748b;margin:0 0 16px;">Each one has a plain-English explanation of the problem and exactly what to do about it.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
      ${issueRows}
    </table>` : `
    <div style="background:#f0fdf4;border-radius:10px;padding:18px 20px;margin-bottom:28px;">
      <p style="font-size:15px;color:#166534;font-weight:700;margin:0;">✅ No significant issues found — your site is in solid shape.</p>
    </div>`}

    ${top3Fixes.length > 0 ? `
    <!-- Top 3 Fixes -->
    <div style="background:#f0fdf4;border:2px solid #84cc16;border-radius:12px;padding:24px;margin-bottom:28px;">
      <h2 style="font-size:17px;font-weight:800;color:#14532d;margin:0 0 4px;">🛠 If You Only Do 3 Things, Do These</h2>
      <p style="font-size:13px;color:#4d7c0f;margin:0 0 16px;">Based on what I found, these will have the biggest impact on your business.</p>
      <table width="100%" cellpadding="0" cellspacing="0">
        ${fixRows}
      </table>
    </div>` : ''}

    <!-- Business Opportunities -->
    <h2 style="font-size:17px;font-weight:800;color:#111;margin:0 0 4px;">💡 Business Opportunities I Spotted</h2>
    <p style="font-size:13px;color:#64748b;margin:0 0 16px;">These aren't broken things — they're opportunities to get more customers from the visitors you're already getting. Some take minutes to fix, others are bigger projects, but all of them are worth thinking about.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
      ${tipRows}
    </table>

    ${wins.length > 0 ? `
    <!-- What's working -->
    <h2 style="font-size:17px;font-weight:800;color:#111;margin:0 0 8px;">✅ What You're Already Doing Right</h2>
    <p style="font-size:13px;color:#64748b;margin:0 0 12px;">These are things your site is already handling well — worth keeping as you make changes.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
      ${winRows}
    </table>` : ''}

    <!-- CTA -->
    <div style="background:#0b1120;border-radius:12px;padding:32px;text-align:center;margin-top:8px;">
      <p style="color:#84cc16;font-weight:700;font-size:12px;margin:0 0 8px;text-transform:uppercase;letter-spacing:.08em;">Want these fixed without the headaches?</p>
      <p style="color:#fff;font-size:17px;font-weight:700;margin:0 0 8px;line-height:1.5;">Book a free 30-minute call and I'll walk you through exactly what's costing you leads and what it would take to fix it.</p>
      <p style="color:#94a3b8;font-size:14px;margin:0 0 22px;line-height:1.5;">No jargon. No pressure. Just a straight conversation about your site and your business.</p>
      <a href="https://calendly.com/ads-rtu/vrume-quick-connect" style="display:inline-block;background:#84cc16;color:#0b1120;font-weight:800;font-size:15px;padding:14px 32px;border-radius:999px;text-decoration:none;">Book Your Free Call →</a>
    </div>

    <p style="font-size:12px;color:#94a3b8;margin:24px 0 0;text-align:center;line-height:1.8;">
      Report prepared by Mark at <a href="https://overhauled.ai" style="color:#84cc16;">overhauled.ai</a> · Guelph, ON<br>
      <a href="mailto:hello@overhauled.ai" style="color:#84cc16;">hello@overhauled.ai</a>
    </p>

  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

function buildNotifyEmail(name, email, phone, url, audit) {
  const { issues } = buildIssues(audit);
  const p = audit.psi;
  return `<h2>New health check submitted</h2>
<p><strong>Site:</strong> ${url}<br>
<strong>Name:</strong> ${name}<br>
<strong>Email:</strong> ${email}<br>
<strong>Phone:</strong> ${phone || '(not provided)'}</p>
<p><strong>Performance:</strong> ${p?.performanceScore ?? 'N/A'}/100<br>
<strong>SEO:</strong> ${p?.seoScore ?? 'N/A'}/100<br>
<strong>Issues found:</strong> ${issues.length} (${issues.filter(i => i.severity === 'critical').length} critical, ${issues.filter(i => i.severity === 'high').length} high)</p>
<h3>Top issues:</h3>
<ol>${issues.slice(0, 5).map(i => `<li>[${i.severity.toUpperCase()}] ${i.category}: ${i.text}</li>`).join('')}</ol>`;
}

// ─── Email sender ─────────────────────────────────────────────────────────────

async function sendEmail(apiKey, to, subject, html, from = 'Mark @ Overhauled.ai <hello@overhauled.ai>') {
  if (!apiKey) { console.log(`[email skipped — no RESEND_API_KEY] To: ${to}`); return; }
  const result = await resendPost(apiKey, { from, to: [to], subject, html });
  console.log(`Email to ${to}: ${result.status} ${result.body}`);
  return result;
}

// ─── HubSpot Forms API ───────────────────────────────────────────────────────
// Submits each free-report lead to HubSpot via the public Forms API.
// No API key required — the form endpoint is unauthenticated.
// Form: "Overhauled.ai - Free Report Request"
// Portal ID: 243026444  |  Form GUID: a4ba9cbf-c543-4e81-be3f-ebe3cd1abd69

const HUBSPOT_PORTAL_ID = '243026444';
const HUBSPOT_FORM_GUID = 'a4ba9cbf-c543-4e81-be3f-ebe3cd1abd69';

async function addToHubSpot(email, website, name) {
  try {
    const firstName = (name && name !== 'there') ? name.split(' ')[0] : '';
    const lastName  = (name && name !== 'there' && name.split(' ').length > 1) ? name.split(' ').slice(1).join(' ') : '';

    const fields = [
      { objectTypeId: '0-1', name: 'email',   value: email },
      { objectTypeId: '0-1', name: 'website', value: website.startsWith('http') ? website : `https://${website}` },
    ];
    if (firstName) fields.push({ objectTypeId: '0-1', name: 'firstname', value: firstName });
    if (lastName)  fields.push({ objectTypeId: '0-1', name: 'lastname',  value: lastName  });

    const payload = JSON.stringify({
      fields,
      context: { pageUri: 'https://overhauled.ai', pageName: 'Overhauled.ai Free Report' },
    });

    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.hsforms.com',
        port: 443,
        path: `/submissions/v3/integration/submit/${HUBSPOT_PORTAL_ID}/${HUBSPOT_FORM_GUID}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      }, (res) => {
        let d = '';
        res.on('data', c => (d += c));
        res.on('end', () => {
          console.log(`[hubspot] Form submit ${res.statusCode} — ${email}`);
          resolve({ status: res.statusCode, body: d });
        });
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  } catch (err) {
    // Never block the audit report over a HubSpot failure
    console.error('[hubspot] Error:', err.message);
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

exports.handler = async function (event) {
  // CORS preflight
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

  let rawUrl = '', email = '', name = 'there', phone = '', botField = '';
  try {
    const params = new URLSearchParams(event.body);
    rawUrl   = (params.get('url') || params.get('website') || '').trim();
    email    = (params.get('email') || '').trim();
    name     = (params.get('name') || 'there').trim();
    phone    = (params.get('phone') || '').trim();
    botField = params.get('bot-field') || '';
  } catch (err) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Bad request' }) };
  }

  // Honeypot
  if (botField) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  if (!rawUrl || !email) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing url or email' }) };
  }

  const apiKey   = process.env.RESEND_API_KEY;

  console.log(`[audit] Starting: ${rawUrl} | ${email} | ${name}`);

  let audit;
  try {
    audit = await runAudit(rawUrl);
  } catch (err) {
    console.error('[audit] Fatal error:', err);
    // Notify Mark even if audit failed
    await sendEmail(apiKey, 'hello@overhauled.ai',
      `[New Health Check — Audit Failed] ${rawUrl}`,
      `<p>Audit failed for ${rawUrl}. Submitted by: ${name} &lt;${email}&gt;, phone: ${phone}</p><p>Error: ${err.message}</p>`
    ).catch(() => {});
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  const hostname = audit.hostname || rawUrl;
  const reportHtml = buildReportEmail(name, rawUrl, audit);

  // Send emails + add to HubSpot in parallel; never block on any single failure
  await Promise.allSettled([
    sendEmail(apiKey, email, `Your Overhauled.ai Site Report — ${hostname}`, reportHtml),
    sendEmail(
      apiKey,
      'hello@overhauled.ai',
      `[New Audit] ${hostname} · ${name} <${email}>`,
      buildNotifyEmail(name, email, phone, rawUrl, audit)
    ),
    addToHubSpot(email, rawUrl, name),
  ]);

  console.log('[audit] Complete');
  return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
};
