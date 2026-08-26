// Optional cloud persistence via Supabase Storage (plain REST, no SDK).
// Purpose: free hosts like Render wipe the local disk on every restart/deploy,
// so the SQLite snapshot and uploaded images must live somewhere durable.
// When SUPABASE_URL + SUPABASE_SERVICE_KEY are set, db.js restores/saves the
// DB snapshot here and the upload route stores images here (served from the
// bucket's public URL). Without those env vars every function is a no-op and
// the app behaves exactly as before (local disk only).
const BUCKET   = process.env.SUPABASE_BUCKET || 'veltrez';
const URL_BASE = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY      = process.env.SUPABASE_SERVICE_KEY || '';

function enabled() { return !!(URL_BASE && KEY); }

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${KEY}`, apikey: KEY, ...extra };
}

// Every call here is a network hop to a third party we do not control. A free
// Supabase project auto-pauses after a week of inactivity and then accepts the
// TCP connection but never answers — an un-timed fetch hangs forever. Since
// db.init() awaits these before app.listen(), that hang takes the whole site
// down. Nothing in this module may ever block indefinitely.
const READ_TIMEOUT_MS  = Number(process.env.STORAGE_TIMEOUT_MS || 8000);
const WRITE_TIMEOUT_MS = Number(process.env.STORAGE_WRITE_TIMEOUT_MS || 30000);

async function sfetch(url, opts = {}, timeoutMs = READ_TIMEOUT_MS) {
  try {
    return await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const why = e.name === 'TimeoutError' || e.name === 'AbortError'
      ? `timed out after ${timeoutMs}ms`
      : e.message;
    console.error(`storage: ${opts.method || 'GET'} ${url.replace(URL_BASE, '')} failed: ${why}`);
    return null;
  }
}

// Two buckets: a public one for product images (served directly from its
// public URL) and a private one for the DB snapshot — public bucket objects
// ARE readable by anyone, so the database must never live in one.
const DB_BUCKET = BUCKET + '-private';

async function ensureBuckets() {
  if (!enabled()) return;
  for (const [id, isPublic] of [[BUCKET, true], [DB_BUCKET, false]]) {
    const head = await sfetch(`${URL_BASE}/storage/v1/bucket/${id}`, { headers: authHeaders() });
    if (head && head.ok) continue;
    const r = await sfetch(`${URL_BASE}/storage/v1/bucket`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ id, name: id, public: isPublic }),
    });
    if (r && !r.ok && r.status !== 409) {
      console.error(`storage: creating bucket ${id} failed: ${r.status} ${await r.text().catch(() => '')}`);
    }
  }
}

async function download(key, bucket = BUCKET) {
  if (!enabled()) return null;
  const r = await sfetch(`${URL_BASE}/storage/v1/object/${bucket}/${key}`, { headers: authHeaders() });
  if (!r || !r.ok) return null;
  try { return Buffer.from(await r.arrayBuffer()); } catch { return null; }
}

async function upload(key, buf, contentType, bucket = BUCKET) {
  if (!enabled()) return false;
  const r = await sfetch(`${URL_BASE}/storage/v1/object/${bucket}/${key}`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': contentType || 'application/octet-stream', 'x-upsert': 'true' }),
    body: buf,
  }, WRITE_TIMEOUT_MS);
  if (r && !r.ok) console.error(`storage: upload ${key} failed: ${r.status} ${await r.text().catch(() => '')}`);
  return !!(r && r.ok);
}

async function remove(key, bucket = BUCKET) {
  if (!enabled()) return false;
  const r = await sfetch(`${URL_BASE}/storage/v1/object/${bucket}/${key}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  return !!(r && r.ok);
}

function publicUrl(key) {
  return `${URL_BASE}/storage/v1/object/public/${BUCKET}/${key}`;
}

// DB snapshot helpers (private bucket)
const DB_KEY = 'db/veltrez.sqlite';
const uploadDb   = (buf) => upload(DB_KEY, buf, 'application/octet-stream', DB_BUCKET);

// Unlike download(), this distinguishes "the bucket has no snapshot yet" from
// "we could not reach the bucket". db.js needs that difference: the first is a
// safe first boot it may write to, the second means the bucket may hold live
// data we must not clobber.
async function fetchDb() {
  if (!enabled()) return { status: 'disabled', bytes: null };
  const r = await sfetch(`${URL_BASE}/storage/v1/object/${DB_BUCKET}/${DB_KEY}`, { headers: authHeaders() });
  if (!r) return { status: 'unreachable', bytes: null };
  // Supabase answers a missing object with 404, and 400 {"error":"not_found"}
  if (r.status === 404 || r.status === 400) return { status: 'missing', bytes: null };
  if (!r.ok) return { status: 'error', code: r.status, bytes: null };
  try { return { status: 'ok', bytes: Buffer.from(await r.arrayBuffer()) }; }
  catch { return { status: 'error', bytes: null }; }
}

// A deliberate, cheap round trip to Supabase. Supabase pauses a free project
// after ~7 days of *its own* inactivity, and this app only talks to storage on
// boot and on writes — so a quiet week of browsing is enough to get the project
// paused, which takes the whole site down with it. Something has to touch
// Supabase on a schedule; see /api/keepalive.
async function ping() {
  if (!enabled()) return { ok: false, reason: 'storage disabled' };
  const r = await sfetch(`${URL_BASE}/storage/v1/bucket/${BUCKET}`, { headers: authHeaders() });
  if (!r) return { ok: false, reason: 'unreachable' };
  return { ok: r.ok, status: r.status };
}

module.exports = { enabled, ensureBuckets, download, upload, remove, publicUrl, fetchDb, uploadDb, ping };
