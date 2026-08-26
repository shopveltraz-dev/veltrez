const initSqlJs = require('sql.js');
const bcrypt     = require('bcryptjs');
const fs         = require('fs');
const path       = require('path');
const storage    = require('./storage');

const DB_PATH = path.join(__dirname, 'veltrez.sqlite');
let _db;

// ── Persistence ──
// Writes are debounced: sql.js exports the whole DB on save, so saving on every
// INSERT is O(db size) per write. Mark dirty, flush at most every 400ms + on exit.
// With cloud storage configured, each flush also uploads the snapshot so hosts
// with ephemeral disks (Render free tier) keep data across restarts.
let _dirty = false;
let _saveTimer = null;
let _cloudUpload = Promise.resolve();

// Uploading is only safe once we know what is already in the bucket. On an
// ephemeral host the local disk is empty after every deploy, so a failed restore
// leaves us holding a freshly seeded demo DB — flushing that to the bucket would
// overwrite every real order with sample data. Until init() proves the cloud
// state, writes stay local and we shout about it.
let _cloudWritable = false;
let _cloudStatus = 'disabled'; // disabled | ok | missing | unreachable | error

function flush() {
  if (!_dirty || !_db) return;
  _dirty = false;
  const bytes = Buffer.from(_db.export());
  fs.writeFileSync(DB_PATH, bytes);
  if (storage.enabled() && _cloudWritable) {
    _cloudUpload = _cloudUpload.then(() => storage.uploadDb(bytes)).catch(() => {});
  }
}

function save() {
  _dirty = true;
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => { _saveTimer = null; flush(); }, 400);
  if (_saveTimer.unref) _saveTimer.unref();
}

// On shutdown, give the last cloud upload a chance to finish (Render sends
// SIGTERM and allows a grace period before killing the process).
async function shutdown() {
  flush();
  try { await Promise.race([_cloudUpload, new Promise(r => setTimeout(r, 8000))]); } catch {}
  process.exit(0);
}

process.on('exit', flush);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── Helper: mimic better-sqlite3 API ──
function get(sql, params = []) {
  const stmt = _db.prepare(sql);
  if (params.length) stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function all(sql, params = []) {
  const stmt = _db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function run(sql, params = []) {
  _db.run(sql, params);
  const changes = _db.getRowsModified();
  const row = get('SELECT last_insert_rowid() AS id');
  save();
  return { lastInsertRowid: row ? row.id : null, changes };
}

function exec(sql) {
  _db.run(sql);
  save();
}

// Mimic better-sqlite3's prepare() chain
function prepare(sql) {
  return {
    get:  (...args) => get(sql,  args.flat()),
    all:  (...args) => all(sql,  args.flat()),
    run:  (...args) => run(sql,  args.flat()),
  };
}

function hasColumn(table, col) {
  return all(`PRAGMA table_info(${table})`).some(c => c.name === col);
}

// ── Schema ──
function migrate() {
  _db.run(`
    CREATE TABLE IF NOT EXISTS products (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      slug             TEXT NOT NULL UNIQUE,
      name             TEXT NOT NULL,
      category         TEXT NOT NULL DEFAULT 'baby-tees',
      price            REAL NOT NULL,
      compare_at_price REAL,
      description      TEXT,
      image_url        TEXT,
      sizes            TEXT DEFAULT 'XS,S,M,L',
      stock            INTEGER DEFAULT 25,
      sold             INTEGER DEFAULT 0,
      featured         INTEGER DEFAULT 0,
      hidden           INTEGER DEFAULT 0,
      sort_order       INTEGER,
      created_at       DATETIME DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS product_images (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      url        TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS customers (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      phone         TEXT,
      role          TEXT DEFAULT 'customer',
      created_at    DATETIME DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS orders (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number   TEXT NOT NULL UNIQUE,
      customer_name  TEXT NOT NULL,
      email          TEXT NOT NULL,
      phone          TEXT,
      address        TEXT NOT NULL,
      city           TEXT NOT NULL,
      notes          TEXT,
      subtotal       REAL NOT NULL,
      shipping       REAL NOT NULL DEFAULT 0,
      total          REAL NOT NULL,
      payment_method TEXT NOT NULL DEFAULT 'cash',   -- cash | bit | card
      status         TEXT NOT NULL DEFAULT 'pending', -- pending | confirmed | shipped | delivered | cancelled
      created_at     DATETIME DEFAULT (datetime('now')),
      updated_at     DATETIME
    );
    CREATE TABLE IF NOT EXISTS order_items (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id   INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      name       TEXT NOT NULL,
      size       TEXT,
      qty        INTEGER NOT NULL DEFAULT 1,
      price      REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id  INTEGER NOT NULL,
      customer_id INTEGER NOT NULL,
      rating      INTEGER NOT NULL,
      text        TEXT NOT NULL DEFAULT '',
      approved    INTEGER NOT NULL DEFAULT 1,
      created_at  DATETIME DEFAULT (datetime('now')),
      UNIQUE (product_id, customer_id)
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_prod ON reviews (product_id, approved, id DESC);
    CREATE TABLE IF NOT EXISTS audit_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts         DATETIME DEFAULT (datetime('now')),
      actor_id   INTEGER,
      actor      TEXT,
      action     TEXT NOT NULL,
      detail     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_products_cat   ON products (hidden, category, sort_order);
    CREATE INDEX IF NOT EXISTS idx_pimages_prod   ON product_images (product_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_orders_status  ON orders (status, id DESC);
    CREATE INDEX IF NOT EXISTS idx_oitems_order   ON order_items (order_id);
  `);
}

// ── Seed ──
// One row per drop: [slug, name, category, price, featured, description, alts]
const CATALOG = [
  ['rhinestone-baby-tee', 'Rhinestone Baby Tee', 'baby-tees', 129, 1,
    'Cream baby tee with blush ringer trim and the VELTREZ signature hand-set in pink rhinestones. The one that started everything.', 0],
  ['sweet-girls-tee', 'Sweet Girls Baby Tee', 'baby-tees', 119, 1,
    'Sweet girls get what they want. Soft-washed cotton baby tee with the Sweet Girls graphic and sparkle detail.', 1],
  ['screenshotted-baby-tee', 'Screenshotted Baby Tee', 'baby-tees', 119, 0,
    'You know they screenshotted it. Fitted baby tee, printed front graphic, VELTREZ hem label.', 0],
  ['not-spoiled-baby-tee', 'Not Spoiled Baby Tee', 'baby-tees', 119, 0,
    'Not spoiled — just loved. Cropped fit, ribbed collar, buttery-soft cotton.', 0],
  ['pretty-girls-receipts-tee', 'Pretty Girls Keep Receipts Tee', 'baby-tees', 119, 0,
    'Pretty girls keep receipts. Classic VELTREZ baby tee with front graphic.', 0],
  ['cute-enough-ringer-tee', 'Cute Enough Ringer Tee', 'baby-tees', 119, 0,
    'Cute enough to get away with it. Contrast ringer trim, cropped cut.', 0],
  ['i-love-me-tee', 'I ♥ Me Tee', 'baby-tees', 109, 0,
    'The healthiest relationship you’ll ever be in. Heart graphic baby tee.', 0],
  ['i-love-attention-tee', 'I ♥ Attention Tee', 'baby-tees', 109, 0,
    'And attention loves you back. Heart graphic baby tee, soft-washed cotton.', 0],
  ['i-love-drama-long-sleeve', 'I ♥ Drama Long Sleeve', 'long-sleeves', 149, 0,
    'Watching it, never in it. Fitted long sleeve with heart graphic.', 0],
  ['good-girls-instincts-tee', 'Good Girls Instincts Tee', 'baby-tees', 119, 0,
    'Good girls trust their instincts. Signature graphic on a soft baby tee.', 0],
  ['outfit-change-butter-top', 'Outfit Change Butter Top', 'tanks-tops', 129, 0,
    'Third outfit change of the day. Butter-yellow fitted top.', 0],
  ['running-late-blue-top', 'Running Late Blue Top', 'tanks-tops', 129, 1,
    'Running late but I looked cute. Baby-blue ruched v-neck, 3/4 sleeve.', 0],
  ['closet-full-lilac-top', 'Closet Full Lilac Top', 'tanks-tops', 129, 0,
    'Closet full, nothing to wear. Lilac fitted top with printed graphic.', 0],
  ['too-dressed-up-tee', 'Too Dressed Up Tee', 'baby-tees', 119, 1,
    'There’s no such thing as too dressed up. Signature graphic baby tee.', 2],
  ['dreaming-of-me-set', 'Dreaming of Me Pajama Set', 'sets', 179, 1,
    'Dreaming of me? Pink candy-stripe cami + shorts set with cream lace trim, satin bow and the embroidered V✦. The sleepover fit.', 0],
];

function seed() {
  if (get('SELECT COUNT(*) AS c FROM products').c === 0) {
    CATALOG.forEach(([slug, name, category, price, featured, description, altCount], i) => {
      const { lastInsertRowid: pid } = run(
        `INSERT INTO products (slug,name,category,price,description,image_url,featured,sort_order)
         VALUES (?,?,?,?,?,?,?,?)`,
        [slug, name, category, price, description, `/img/products/${slug}.jpg`, featured, i]);
      for (let a = 0; a < altCount; a++) {
        run('INSERT INTO product_images (product_id,url,sort_order) VALUES (?,?,?)',
          [pid, `/img/products/${slug}-${a + 2}.jpg`, a]);
      }
    });
    console.log(`✅ Catalog seeded (${CATALOG.length} products)`);
  }

  // Shop admin account (first run only) — random password printed once
  if (!get(`SELECT id FROM customers WHERE role='admin'`)) {
    const crypto = require('crypto');
    const pw = crypto.randomBytes(9).toString('base64url');
    run('INSERT INTO customers (name,email,password_hash,role) VALUES (?,?,?,?)',
      ['Shop Admin', 'admin@veltrez.local', bcrypt.hashSync(pw, 12), 'admin']);
    console.log('\n🔑 ADMIN ACCOUNT CREATED');
    console.log('   email:    admin@veltrez.local');
    console.log(`   password: ${pw}`);
    console.log('   Shown ONCE — save it, then change it from the admin panel.\n');
  }

  save();
}

// ── Public init ──
async function init() {
  const SQL = await initSqlJs();
  let bytes = null;
  if (storage.enabled()) {
    // Cloud mode: the bucket snapshot is the source of truth (local disk may
    // be brand new after a redeploy). Fall back to local file on first boot.
    //
    // This whole block runs on a hard budget. Booting is the only thing standing
    // between a request and app.listen(), so a degraded restore must cost the
    // site a stale snapshot, never its availability. Individual calls are also
    // timed out inside storage.js; this is the belt to that pair of braces.
    const BUDGET_MS = Number(process.env.DB_RESTORE_TIMEOUT_MS || 20000);
    const restore = (async () => {
      await storage.ensureBuckets();
      return storage.fetchDb();
    })();
    const res = await Promise.race([
      restore.catch(e => ({ status: 'error', bytes: null, err: e.message })),
      new Promise(r => setTimeout(() => r({ status: 'unreachable', bytes: null }), BUDGET_MS).unref?.()),
    ]);
    bytes = res.bytes;
    // Guard against a corrupt/foreign snapshot — must carry the SQLite magic
    if (bytes && !bytes.slice(0, 16).equals(Buffer.from('SQLite format 3\0'))) {
      console.error('⚠️  Cloud DB snapshot is not a valid SQLite file — ignoring it');
      bytes = null;
    }
    // Only take ownership of the bucket when we know what is in it: a snapshot
    // we successfully read, or a bucket that provably holds none yet.
    _cloudWritable = res.status === 'ok' || res.status === 'missing';
    _cloudStatus   = res.status;

    if (res.status === 'ok') console.log('☁️  Database restored from cloud storage');
    else if (res.status === 'missing') console.log('☁️  No cloud snapshot yet — this boot will create it');
    else {
      console.error('');
      console.error(`🚨  CLOUD STORAGE UNREACHABLE (${res.status}${res.err ? ': ' + res.err : ''}).`);
      console.error('    Booting from local disk. Cloud writes are DISABLED so the bucket');
      console.error('    snapshot is not overwritten with this process\'s data.');
      console.error('    Fix Supabase (a free project auto-pauses after ~7 days idle), then redeploy.');
      console.error('');
    }
  }
  if (!bytes && fs.existsSync(DB_PATH)) bytes = fs.readFileSync(DB_PATH);
  _db = bytes ? new SQL.Database(bytes) : new SQL.Database();
  migrate();
  seed();
  return module.exports;
}

module.exports = {
  init, prepare, get, all, run: (sql, params) => run(sql, params), exec, flush,
  pragma: () => {},
  // Surfaced by /api/health so an outage is visible without reading deploy logs.
  cloudStatus: () => ({ status: _cloudStatus, writable: _cloudWritable }),
};
