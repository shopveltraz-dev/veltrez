require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const compression = require('compression');
const path        = require('path');
const fs          = require('fs');
const crypto      = require('crypto');
const { rateLimit, securityHeaders } = require('./middleware/security');

if (!process.env.JWT_SECRET || /change_in_production/.test(process.env.JWT_SECRET)) {
  console.warn('⚠️  Weak/default JWT_SECRET — generating a random one for this run.');
  console.warn('    Set a strong JWT_SECRET in .env (sessions reset on every restart until you do).');
  process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
}

async function main() {
  const db = await require('./db').init();
  console.log('✅ Database ready');

  // Recover the admin login if its one-time password was lost. No-op unless
  // ADMIN_RESET is set, and no-op again for a value already used.
  require('./admin-reset').run();

  const app = express();
  app.disable('x-powered-by');

  // CORS: same-origin by default; allow extra origins via CORS_ORIGINS (comma-separated)
  const allowed = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin || allowed.includes(origin) || /^https?:\/\/localhost(:\d+)?$/.test(origin)) return cb(null, true);
      cb(null, false);
    },
  }));

  app.use(compression());
  app.use(securityHeaders);

  // Small JSON bodies everywhere except the image-upload endpoint (base64 photos)
  const jsonSmall = express.json({ limit: '20kb' });
  const jsonBig   = express.json({ limit: '8mb' });
  app.use((req, res, next) => (/\/upload$/.test(req.path) ? jsonBig : jsonSmall)(req, res, next));

  // Global ceiling, always keyed by IP because it runs before any route
  // authenticates. A backstop against one machine hammering the API, not a
  // per-user budget — the per-route limiters do that.
  app.use('/api', rateLimit({ windowMs: 60e3, max: 400, keyFn: req => req.ip, name: 'global' }));

  const escHtml = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // ── Asset versioning ──
  // HTML is served no-cache so a deploy is visible immediately; the scripts it
  // loads are cached for a week. ?v=__ASSETV__ is stamped from the files' own
  // contents so shipping a change invalidates automatically.
  const VERSIONED_ASSETS = ['shop.js', 'style.css'];
  const assetVersion = (() => {
    const h = crypto.createHash('sha1');
    for (const f of VERSIONED_ASSETS) {
      try { h.update(fs.readFileSync(path.join(__dirname, 'public', f))); }
      catch { /* asset may not exist in every deploy */ }
    }
    return h.digest('hex').slice(0, 8);
  })();
  const stampAssets = html => html.split('__ASSETV__').join(assetVersion);

  // ── SEO: product pages ──
  // WhatsApp/Instagram/Google crawlers don't run JS, so a shared product link
  // is a blank card unless the Open Graph tags are in the HTML before any
  // script runs. Injected server-side, same pattern as the landing page.
  app.get('/product.html', (req, res, next) => {
    try {
      const slug = String(req.query.p || '').slice(0, 80);
      const p = slug ? db.prepare('SELECT * FROM products WHERE slug=? AND hidden=0').get(slug) : null;
      let html = fs.readFileSync(path.join(__dirname, 'public', 'product.html'), 'utf8');
      if (!p) {
        return res.status(404).type('html').set('X-Robots-Tag', 'noindex')
          .send(stampAssets(html.replace(/<title>[^<]*<\/title>/, '<title>Not found — VELTREZ</title>')));
      }
      const base  = `${req.protocol}://${req.get('host')}`;
      const url   = `${base}/product.html?p=${encodeURIComponent(p.slug)}`;
      const title = `${escHtml(p.name)} — VELTREZ`;
      const desc  = escHtml(String(p.description || '').slice(0, 200));
      let img = p.image_url || '';
      if (img.startsWith('/')) img = base + img;
      const metas = [
        `<meta name="description" content="${desc}">`,
        `<meta property="og:type" content="product">`,
        `<meta property="og:title" content="${title}">`,
        `<meta property="og:description" content="${desc}">`,
        ...(img ? [`<meta property="og:image" content="${escHtml(img)}">`,
                   `<meta name="twitter:card" content="summary_large_image">`] : []),
        `<meta property="og:url" content="${url}">`,
        `<link rel="canonical" href="${url}">`,
        // Product markup is what gets price + availability into the search result
        `<script type="application/ld+json">${JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'Product',
          name: p.name,
          ...(img ? { image: img } : {}),
          description: p.description || undefined,
          brand: { '@type': 'Brand', name: 'VELTREZ' },
          offers: {
            '@type': 'Offer', url, priceCurrency: 'ILS', price: p.price,
            availability: p.stock > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
          },
        })}</script>`,
      ];
      html = html.replace(/<title>[^<]*<\/title>/, `<title>${title}</title>\n  ${metas.join('\n  ')}`);
      res.type('html').set('Cache-Control', 'no-cache').send(stampAssets(html));
    } catch (e) { next(); }
  });

  // The landing page's canonical URL has to name the host the visitor actually
  // arrived on, so a custom domain later needs no edit here or in the HTML.
  app.get(['/', '/index.html'], (req, res, next) => {
    try {
      const base = `${req.protocol}://${req.get('host')}`;
      let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
      const ld = {
        '@context': 'https://schema.org',
        '@graph': [
          { '@type': 'Organization', '@id': `${base}/#org`, name: 'VELTREZ', url: base },
          { '@type': 'WebSite', '@id': `${base}/#site`, url: base, name: 'VELTREZ',
            publisher: { '@id': `${base}/#org` }, inLanguage: 'en' },
        ],
      };
      const head = [
        `<link rel="canonical" href="${base}/">`,
        `<meta property="og:url" content="${base}/">`,
        `<script type="application/ld+json">${JSON.stringify(ld)}</script>`,
      ].join('\n  ');
      html = html.replace('</head>', `  ${head}\n</head>`);
      res.type('html').set('Cache-Control', 'no-cache').send(stampAssets(html));
    } catch (e) { next(); }
  });

  // robots.txt + dynamic sitemap from live product slugs
  app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /admin.html\nSitemap: ${req.protocol}://${req.get('host')}/sitemap.xml\n`);
  });
  app.get('/sitemap.xml', (req, res) => {
    const base = `${req.protocol}://${req.get('host')}`;
    const urls = [`${base}/`]
      .concat(db.prepare('SELECT slug FROM products WHERE hidden=0').all()
        .map(p => `${base}/product.html?p=${encodeURIComponent(p.slug)}`));
    res.type('application/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      urls.map(u => `  <url><loc>${escHtml(u)}</loc></url>`).join('\n') + '\n</urlset>');
  });

  // Serve .html through the stamper; everything else straight off disk.
  app.get(/\.html$|^\/$/, (req, res, next) => {
    const name = req.path === '/' ? 'index.html' : path.basename(req.path);
    if (!/^[\w.-]+\.html$/.test(name)) return next();
    const file = path.join(__dirname, 'public', name);
    fs.readFile(file, 'utf8', (err, html) => {
      if (err) return next();
      res.set('Cache-Control', 'no-cache').type('html').send(stampAssets(html));
    });
  });

  app.use(express.static(path.join(__dirname, 'public'), {
    etag: true,
    setHeaders(res, filePath) {
      if (/\.html$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
      else if (/[\\/]uploads[\\/]/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=86400');
      else res.setHeader('Cache-Control', 'public, max-age=604800');
    },
  }));

  // API routes
  app.use('/api/auth',     require('./routes/auth'));
  app.use('/api/products', require('./routes/products'));
  app.use('/api/orders',   require('./routes/orders'));
  app.use('/api/admin',    require('./routes/admin'));

  // Liveness only — render.yaml points healthCheckPath here, so a non-200
  // makes Render tear the service down. Storage being unreachable is exactly
  // when the site must stay up, so dependency state is reported in the body
  // and never in the status code. /api/keepalive is the endpoint that fails
  // loudly for alerting.
  app.get('/api/health', (_, res) => {
    const cloud = db.cloudStatus();
    const degraded = cloud.status === 'unreachable' || cloud.status === 'error';
    const mail = process.env.EMAIL_PROVIDER || 'dev';
    res.status(200).json({
      status: degraded ? 'degraded' : 'ok',
      cloud,
      email: { provider: mail, delivers: mail !== 'dev' },
      ts: new Date().toISOString(),
    });
  });

  // Keep-alive: hit by a scheduled job so Supabase never sits idle long enough
  // to be paused. Optionally gated by KEEPALIVE_TOKEN — the endpoint makes an
  // outbound request, so it should not be a free lever for anyone who finds it.
  app.get('/api/keepalive', async (req, res) => {
    const want = process.env.KEEPALIVE_TOKEN;
    if (want && req.get('x-keepalive-token') !== want) return res.status(404).json({ error: 'Not found' });
    const storage = require('./storage');
    const result = await storage.ping();
    res.status(result.ok ? 200 : 503).json({ supabase: result, ts: new Date().toISOString() });
  });

  // Public stats for landing-page counters
  app.get('/api/stats', (_, res) => {
    res.json({
      products: db.prepare('SELECT COUNT(*) AS c FROM products WHERE hidden=0').get().c,
      orders:   db.prepare("SELECT COUNT(*) AS c FROM orders WHERE status NOT IN ('cancelled')").get().c,
    });
  });

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((err, req, res, next) => {
    console.error(err);
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Payload too large' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    res.status(500).json({ error: 'Internal server error' }); // no stack leakage
  });

  // ── Daily DB backup: backups/veltrez-YYYY-MM-DD.sqlite, keep last 14 ──
  function backupDB() {
    try {
      db.flush(); // make sure pending writes hit disk before copying
      const dir = path.join(__dirname, 'backups');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir);
      const stamp = new Date().toISOString().slice(0, 10);
      const dest = path.join(dir, `veltrez-${stamp}.sqlite`);
      fs.copyFileSync(path.join(__dirname, 'veltrez.sqlite'), dest);
      const old = fs.readdirSync(dir).filter(f => f.endsWith('.sqlite')).sort();
      while (old.length > 14) fs.unlinkSync(path.join(dir, old.shift()));
      console.log(`💾 Backup: ${dest}`);
    } catch (e) { console.error('Backup failed:', e.message); }
  }
  backupDB();
  setInterval(backupDB, 24 * 3600e3).unref();

  // ── Supabase keep-warm ──
  // Supabase pauses a free project after ~7 days of inactivity, and this app
  // only touches storage on boot and on writes — a quiet week is enough to lose
  // the project's DNS and crash-loop the service. This refreshes the clock
  // whenever the instance is awake. It is only half a guard: Render's free tier
  // spins down when idle, and a sleeping instance runs no timers. The external
  // GitHub Actions pinger against /api/keepalive is what closes the gap.
  {
    const storageKA = require('./storage');
    if (storageKA.enabled()) {
      const every = Number(process.env.KEEPALIVE_INTERVAL_MS || 12 * 3600e3);
      setInterval(() => {
        storageKA.ping()
          .then(r => { if (!r.ok) console.warn('keep-warm: Supabase unreachable —', r.reason || r.status); })
          .catch(() => {});
      }, every).unref();
    }
  }

  const PORT = process.env.PORT || 8095;

  // Render (and most PaaS) put a reverse proxy in front — without trust proxy the
  // rate limiter keys every client to the proxy's IP and throttles everyone at once.
  if (process.env.TRUST_PROXY || process.env.RENDER) app.set('trust proxy', 1);

  app.listen(PORT, () => {
    console.log(`\n🛍️   VELTREZ shop running on http://localhost:${PORT}`);
    console.log(`🏠  Storefront: http://localhost:${PORT}/`);
    console.log(`🗂   Admin panel: http://localhost:${PORT}/admin.html`);
    console.log(`📧  Email mode: ${process.env.EMAIL_PROVIDER || 'dev (emails print here in console)'}\n`);
  });
}

main().catch(err => { console.error('Startup error:', err); process.exit(1); });
