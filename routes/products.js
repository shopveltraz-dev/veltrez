const express = require('express');
const db      = require('../db');
const requireAuth = require('../middleware/auth');
const { audit }   = require('../middleware/auth');
const { rateLimit } = require('../middleware/security');

const router = express.Router();

const shape = p => ({
  id: p.id, slug: p.slug, name: p.name, category: p.category,
  price: p.price, compare_at_price: p.compare_at_price,
  description: p.description, image_url: p.image_url,
  sizes: String(p.sizes || '').split(',').map(s => s.trim()).filter(Boolean),
  stock: p.stock, featured: !!p.featured,
  rating: p.rating ? Math.round(p.rating * 10) / 10 : null,
  review_count: p.review_count || 0,
});

const RATING_SQL = `
  (SELECT AVG(rating) FROM reviews r WHERE r.product_id=p.id AND r.approved=1) AS rating,
  (SELECT COUNT(*)    FROM reviews r WHERE r.product_id=p.id AND r.approved=1) AS review_count`;

const firstName = n => String(n || '').trim().split(/\s+/)[0] || 'VELTREZ girl';
const shapeReview = r => ({
  id: r.id, rating: r.rating, text: r.text, created_at: r.created_at,
  name: firstName(r.name), product_slug: r.slug, product_name: r.product_name,
});

// Public catalog — hidden products are the owner's drafts, not for sale yet
router.get('/', (req, res) => {
  const products = db.prepare(
    `SELECT p.*, ${RATING_SQL} FROM products p WHERE hidden=0 ORDER BY sort_order, id`).all();
  res.json({ products: products.map(shape) });
});

// Latest approved reviews across the shop (homepage strip)
router.get('/reviews/latest', (req, res) => {
  const rows = db.prepare(`
    SELECT r.*, c.name, p.slug, p.name AS product_name
    FROM reviews r JOIN customers c ON c.id=r.customer_id JOIN products p ON p.id=r.product_id
    WHERE r.approved=1 AND p.hidden=0 AND r.text <> ''
    ORDER BY r.id DESC LIMIT 12`).all();
  res.json({ reviews: rows.map(shapeReview) });
});

router.get('/:slug', (req, res) => {
  const p = db.prepare(`SELECT p.*, ${RATING_SQL} FROM products p WHERE slug=? AND hidden=0`)
    .get(String(req.params.slug).slice(0, 80));
  if (!p) return res.status(404).json({ error: 'Product not found' });
  const images = [p.image_url].concat(
    db.prepare('SELECT url FROM product_images WHERE product_id=? ORDER BY sort_order, id')
      .all(p.id).map(i => i.url)).filter(Boolean);
  res.json({ product: { ...shape(p), images } });
});

router.get('/:slug/reviews', (req, res) => {
  const p = db.prepare('SELECT id FROM products WHERE slug=? AND hidden=0')
    .get(String(req.params.slug).slice(0, 80));
  if (!p) return res.status(404).json({ error: 'Product not found' });
  const rows = db.prepare(`
    SELECT r.*, c.name FROM reviews r JOIN customers c ON c.id=r.customer_id
    WHERE r.product_id=? AND r.approved=1 ORDER BY r.id DESC LIMIT 100`).all(p.id);
  res.json({ reviews: rows.map(shapeReview) });
});

// Post (or update) your review — one per customer per product
router.post('/:slug/reviews',
  requireAuth,
  rateLimit({ windowMs: 60e3, max: 6, keyFn: req => 'rev' + req.customer.id, name: 'review' }),
  (req, res) => {
    const p = db.prepare('SELECT id, name FROM products WHERE slug=? AND hidden=0')
      .get(String(req.params.slug).slice(0, 80));
    if (!p) return res.status(404).json({ error: 'Product not found' });
    const rating = Number(req.body.rating);
    const text   = String(req.body.text || '').trim().slice(0, 500);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be 1–5 stars' });
    }
    db.prepare(`
      INSERT INTO reviews (product_id, customer_id, rating, text, approved)
      VALUES (?,?,?,?,1)
      ON CONFLICT(product_id, customer_id) DO UPDATE SET
        rating=excluded.rating, text=excluded.text, approved=1, created_at=datetime('now')`)
      .run(p.id, req.customer.id, rating, text);
    audit(req.customer.id, req.customer.email, 'review.post', `${p.name} ${rating}★`);
    res.status(201).json({ ok: true });
  });

module.exports = router;
