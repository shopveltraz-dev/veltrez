const express = require('express');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const db      = require('../db');
const storage = require('../storage');
const emailSvc = require('../email');
const requireAuth = require('../middleware/auth');
const { requireRole, audit } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

const STATUSES = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'];

router.get('/overview', (_, res) => {
  const revenue = db.prepare(
    "SELECT COALESCE(SUM(total),0) AS s FROM orders WHERE status NOT IN ('cancelled')").get().s;
  res.json({
    orders:    db.prepare('SELECT COUNT(*) AS c FROM orders').get().c,
    pending:   db.prepare("SELECT COUNT(*) AS c FROM orders WHERE status='pending'").get().c,
    products:  db.prepare('SELECT COUNT(*) AS c FROM products').get().c,
    revenue,
    low_stock: db.prepare('SELECT COUNT(*) AS c FROM products WHERE stock<=3 AND hidden=0').get().c,
  });
});

router.get('/orders', (req, res) => {
  const status = STATUSES.includes(req.query.status) ? req.query.status : null;
  const orders = (status
    ? db.prepare('SELECT * FROM orders WHERE status=? ORDER BY id DESC LIMIT 200').all(status)
    : db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 200').all());
  const items = id => db.prepare('SELECT name,size,qty,price FROM order_items WHERE order_id=?').all(id);
  res.json({ orders: orders.map(o => ({ ...o, items: items(o.id) })) });
});

router.patch('/orders/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  const status = String(req.body.status || '');
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Bad status' });

  // Cancelling puts the stock back — the sale never happened
  if (status === 'cancelled' && o.status !== 'cancelled') {
    for (const it of db.prepare('SELECT product_id,qty FROM order_items WHERE order_id=?').all(id)) {
      db.prepare('UPDATE products SET stock=stock+?, sold=MAX(0,sold-?) WHERE id=?')
        .run(it.qty, it.qty, it.product_id);
    }
  }
  db.prepare("UPDATE orders SET status=?, updated_at=datetime('now') WHERE id=?").run(status, id);
  audit(req.customer.id, req.customer.email, 'order.status', `${o.order_number} → ${status}`);

  // The two transitions a customer actually wants to hear about
  if (status === 'shipped' || status === 'confirmed') {
    const nice = status === 'shipped' ? 'is on its way 🚚' : 'is confirmed 💗';
    emailSvc.sendEmail({
      to: o.email,
      subject: `Order ${o.order_number} ${status}`,
      title: `Your order ${nice}`,
      text: `Order ${o.order_number} is now ${status}. Track it any time with your order number + email.`,
      html: `<p>Hi ${o.customer_name}, your order <b>${o.order_number}</b> ${nice}</p>`,
    }).catch(() => {});
  }
  res.json({ ok: true, status });
});

// ── Products ──
router.get('/products', (_, res) => {
  res.json({ products: db.prepare('SELECT * FROM products ORDER BY sort_order, id').all() });
});

const EDITABLE = ['name', 'category', 'price', 'compare_at_price', 'description', 'sizes', 'stock', 'featured', 'hidden', 'sort_order'];
router.patch('/products/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!db.prepare('SELECT id FROM products WHERE id=?').get(id)) {
    return res.status(404).json({ error: 'Product not found' });
  }
  const sets = [], vals = [];
  for (const k of EDITABLE) {
    if (!(k in (req.body || {}))) continue;
    let v = req.body[k];
    if (['price', 'compare_at_price'].includes(k)) { v = v === null || v === '' ? null : Number(v); if (v !== null && !(v >= 0)) continue; }
    if (['stock', 'featured', 'hidden', 'sort_order'].includes(k)) { v = parseInt(v, 10); if (!Number.isFinite(v)) continue; }
    if (['name', 'category', 'description', 'sizes'].includes(k)) v = String(v).slice(0, k === 'description' ? 1000 : 120);
    sets.push(`${k}=?`); vals.push(v);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  db.prepare(`UPDATE products SET ${sets.join(',')} WHERE id=?`).run(...vals, id);
  audit(req.customer.id, req.customer.email, 'product.update', `#${id}: ${sets.join(',')}`);
  res.json({ product: db.prepare('SELECT * FROM products WHERE id=?').get(id) });
});

router.post('/products', (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 120);
  const price = Number(b.price);
  if (!name || !(price >= 0)) return res.status(400).json({ error: 'Name and price required' });
  const slug = (String(b.slug || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
    || 'product') + '-' + crypto.randomBytes(2).toString('hex');
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO products (slug,name,category,price,description,sizes,stock,hidden)
    VALUES (?,?,?,?,?,?,?,1)`)
    .run(slug, name, String(b.category || 'baby-tees').slice(0, 60), price,
      String(b.description || '').slice(0, 1000), String(b.sizes || 'XS,S,M,L').slice(0, 120),
      parseInt(b.stock, 10) || 0);
  audit(req.customer.id, req.customer.email, 'product.create', slug);
  res.status(201).json({ product: db.prepare('SELECT * FROM products WHERE id=?').get(lastInsertRowid) });
});

// Image upload (base64 JSON, path ends in /upload so server.js allows a big body).
// Cloud mode stores in the public Supabase bucket; otherwise local uploads dir
// (which an ephemeral host wipes on deploy).
router.post('/products/:id/upload', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(id);
  if (!p) return res.status(404).json({ error: 'Product not found' });

  const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/.exec(String(req.body.data || ''));
  if (!m) return res.status(400).json({ error: 'Expected a base64 PNG/JPEG/WebP data URL' });
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 5 * 1024 * 1024) return res.status(413).json({ error: 'Image too large (5MB max)' });

  const key = `p${id}-${crypto.randomBytes(9).toString('hex')}.${ext}`;
  let url;
  if (storage.enabled() && await storage.upload(`products/${key}`, buf, `image/${m[1]}`)) {
    url = storage.publicUrl(`products/${key}`);
  } else {
    const dir = path.join(__dirname, '..', 'public', 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, key), buf);
    url = `/uploads/${key}`;
  }

  if (req.body.as === 'main') {
    db.prepare('UPDATE products SET image_url=? WHERE id=?').run(url, id);
  } else {
    db.prepare('INSERT INTO product_images (product_id,url) VALUES (?,?)').run(id, url);
  }
  audit(req.customer.id, req.customer.email, 'product.image', `#${id} ${req.body.as === 'main' ? 'main' : 'gallery'}`);
  res.json({ url });
});

// Registered customers. Password column is exposed ONLY while
// PLAINTEXT_PASSWORDS=1 (dev testing) — hashed values are never returned.
router.get('/customers', (_, res) => {
  const plain = process.env.PLAINTEXT_PASSWORDS === '1';
  const rows = db.prepare(`SELECT id,name,email,phone,role,password_hash,created_at FROM customers ORDER BY id DESC`).all();
  res.json({ customers: rows.map(c => ({
    id: c.id, name: c.name, email: c.email, phone: c.phone, role: c.role, created_at: c.created_at,
    password: plain && !String(c.password_hash).startsWith('$2') ? c.password_hash : null,
  })) });
});

// Everything about one customer: profile, orders (+items), reviews, activity
router.get('/customers/:id/profile', (req, res) => {
  const c = db.prepare('SELECT id,name,email,phone,role,password_hash,created_at FROM customers WHERE id=?')
    .get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Customer not found' });
  const plain = process.env.PLAINTEXT_PASSWORDS === '1';
  const orders = db.prepare('SELECT * FROM orders WHERE email=? ORDER BY id DESC').all(c.email);
  const itemsQ = db.prepare('SELECT name,size,qty,price FROM order_items WHERE order_id=?');
  res.json({
    customer: {
      id: c.id, name: c.name, email: c.email, phone: c.phone, role: c.role, created_at: c.created_at,
      password: plain && !String(c.password_hash).startsWith('$2') ? c.password_hash : null,
    },
    orders: orders.map(o => ({ ...o, items: itemsQ.all(o.id) })),
    reviews: db.prepare(`SELECT r.id, r.rating, r.text, r.approved, r.created_at, p.name AS product, p.slug
      FROM reviews r JOIN products p ON p.id=r.product_id WHERE r.customer_id=? ORDER BY r.id DESC`).all(c.id),
    activity: db.prepare('SELECT ts, action, detail FROM audit_log WHERE actor_id=? ORDER BY id DESC LIMIT 50').all(c.id),
    totals: {
      orders: orders.length,
      spent: orders.filter(o => o.status !== 'cancelled').reduce((s, o) => s + o.total, 0),
    },
  });
});

// Reviews moderation
router.get('/reviews', (_, res) => {
  const rows = db.prepare(`
    SELECT r.*, c.name AS customer, c.email, p.name AS product, p.slug
    FROM reviews r JOIN customers c ON c.id=r.customer_id JOIN products p ON p.id=r.product_id
    ORDER BY r.id DESC LIMIT 500`).all();
  res.json({ reviews: rows });
});
router.patch('/reviews/:id', (req, res) => {
  const id = Number(req.params.id);
  const approved = req.body.approved ? 1 : 0;
  const r = db.prepare('UPDATE reviews SET approved=? WHERE id=?').run(approved, id);
  if (!r.changes) return res.status(404).json({ error: 'Review not found' });
  audit(req.customer.id, req.customer.email, 'review.moderate', `#${id} approved=${approved}`);
  res.json({ ok: true });
});
router.delete('/reviews/:id', (req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare('DELETE FROM reviews WHERE id=?').run(id);
  if (!r.changes) return res.status(404).json({ error: 'Review not found' });
  audit(req.customer.id, req.customer.email, 'review.delete', `#${id}`);
  res.json({ ok: true });
});

router.get('/audit', (_, res) => {
  res.json({ log: db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100').all() });
});

module.exports = router;
