// Dependency-free security middleware: rate limiting + hardening headers.

// ── Sliding-window in-memory rate limiter ──
//
// rateLimit({ windowMs, max, keyFn, methods, name })
//
// The default key is the authenticated user when there is one, and the client
// IP otherwise. An authenticated request already carries a better identity
// than its IP — shared-IP households and offices should not throttle each
// other. IP-keying is still right for unauthenticated routes, where the IP is
// the only identity available and the thing being defended against is someone
// making accounts or guessing passwords.
//
// `methods` restricts a limiter to some verbs, so a route can allow generous
// reads and tight writes without two routers.
function rateLimit({ windowMs = 60e3, max = 60, keyFn, methods, name } = {}) {
  const hits = new Map(); // key -> [timestamps]
  const only = methods ? new Set(methods.map(m => m.toUpperCase())) : null;

  // Periodic cleanup so the map doesn't grow unbounded
  const cleaner = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, arr] of hits) {
      const fresh = arr.filter(t => t > cutoff);
      if (fresh.length) hits.set(k, fresh); else hits.delete(k);
    }
  }, windowMs);
  cleaner.unref();

  const defaultKey = req => (req.customer ? 'u' + req.customer.id : 'ip' + req.ip);

  return (req, res, next) => {
    if (only && !only.has(req.method)) return next();
    const key = keyFn ? keyFn(req) : defaultKey(req);
    const now = Date.now();
    const arr = (hits.get(key) || []).filter(t => t > now - windowMs);

    // Tell the client where it stands instead of making it discover the wall by
    // hitting it. Reset is seconds until the oldest hit in the window ages out.
    const reset = arr.length ? Math.ceil((arr[0] + windowMs - now) / 1000) : 0;
    res.set({
      'X-RateLimit-Limit': String(max),
      'X-RateLimit-Remaining': String(Math.max(0, max - arr.length - 1)),
      'X-RateLimit-Reset': String(reset),
    });

    if (arr.length >= max) {
      res.set('Retry-After', String(Math.max(1, reset)));
      return res.status(429).json({
        error: 'Too many requests — slow down',
        code: 'rate_limited',
        retry_after: Math.max(1, reset),
        scope: name || undefined,
      });
    }
    arr.push(now);
    hits.set(key, arr);
    next();
  };
}

// Product photos live in the Supabase bucket in cloud mode, so its origin has
// to be allowed in img-src or every uploaded image is blocked. Derived from
// the configured URL rather than hard-coded to a project ref.
const SUPABASE_IMG = (() => {
  try {
    const u = new URL(process.env.SUPABASE_URL);
    return u.protocol === 'https:' ? ' ' + u.origin : '';
  } catch { return ''; }
})();

// ── Security headers (helmet-lite) ──
function securityHeaders(req, res, next) {
  // HSTS when the request actually arrived over TLS (directly or via trusted proxy)
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Content-Security-Policy': [
      "default-src 'self'",
      `img-src 'self' data:${SUPABASE_IMG}`,
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
      "script-src 'self' 'unsafe-inline'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  });
  next();
}

// ── Failed-login lockout (per identifier) ──
const failures = new Map(); // identifier -> { count, lockedUntil }
const LOCK_THRESHOLD = 10;
const LOCK_MS = 15 * 60 * 1000;

const loginGuard = {
  check(identifier) {
    const f = failures.get(identifier);
    if (f && f.lockedUntil && f.lockedUntil > Date.now()) {
      return Math.ceil((f.lockedUntil - Date.now()) / 60000); // minutes left
    }
    return 0;
  },
  fail(identifier) {
    const f = failures.get(identifier) || { count: 0, lockedUntil: 0 };
    f.count += 1;
    if (f.count >= LOCK_THRESHOLD) { f.lockedUntil = Date.now() + LOCK_MS; f.count = 0; }
    failures.set(identifier, f);
  },
  clear(identifier) { failures.delete(identifier); },
};

module.exports = { rateLimit, securityHeaders, loginGuard };
