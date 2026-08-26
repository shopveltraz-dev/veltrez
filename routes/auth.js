// Customer + admin auth. Registration creates a 'customer' role account.
//
// PLAINTEXT_PASSWORDS=1 (dev only!) stores new passwords unhashed so they
// can be inspected in the DB while testing. Login still works for both:
// a stored value starting with "$2" is treated as a bcrypt hash.
const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const db      = require('../db');
const requireAuth = require('../middleware/auth');
const { audit }   = require('../middleware/auth');
const { rateLimit, loginGuard } = require('../middleware/security');

const router = express.Router();
const PLAIN = process.env.PLAINTEXT_PASSWORDS === '1';

function storePassword(pw) {
  return PLAIN ? pw : bcrypt.hashSync(pw, 12);
}
function checkPassword(pw, stored) {
  if (!stored) return false;
  return stored.startsWith('$2') ? bcrypt.compareSync(pw, stored) : pw === stored;
}
function sign(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '12h' });
}
function pub(user) {
  return { id: user.id, name: user.name, email: user.email, phone: user.phone || '', role: user.role };
}

router.post('/register',
  rateLimit({ windowMs: 60e3, max: 5, keyFn: req => 'ip' + req.ip, name: 'register' }),
  (req, res) => {
    const name     = String(req.body.name || '').trim().slice(0, 80);
    const email    = String(req.body.email || '').trim().toLowerCase();
    const phone    = String(req.body.phone || '').trim().slice(0, 30);
    const password = String(req.body.password || '');
    // Every failed attempt is audited (never the password) so "I signed up but
    // it's not there" can be answered from the admin audit log alone.
    const fail = (code, msg) => {
      audit(null, email || null, 'auth.register_failed', `${msg} (name="${name}", phone="${phone}")`);
      return res.status(code).json({ error: msg });
    };
    if (!name) return fail(400, 'Name required');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(400, 'Valid email required');
    if (!/^\+?[\d\s().-]{7,}$/.test(phone)) return fail(400, 'Valid phone number required');
    if (password.length < 6) return fail(400, 'Password must be at least 6 characters');
    if (req.body.password_confirm !== undefined && String(req.body.password_confirm) !== password) {
      return fail(400, 'Passwords do not match');
    }
    if (db.prepare('SELECT id FROM customers WHERE email=?').get(email)) {
      return fail(409, 'An account with this email already exists');
    }
    const info = db.prepare('INSERT INTO customers (name,email,password_hash,phone,role) VALUES (?,?,?,?,?)')
      .run(name, email, storePassword(password), phone, 'customer');
    const user = db.prepare('SELECT * FROM customers WHERE id=?').get(info.lastInsertRowid);
    audit(user.id, user.email, 'auth.register', null);
    res.status(201).json({ token: sign(user), user: pub(user) });
  });

router.post('/login',
  rateLimit({ windowMs: 60e3, max: 10, keyFn: req => 'ip' + req.ip, name: 'login' }),
  (req, res) => {
    const email    = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const lockedMin = loginGuard.check(email);
    if (lockedMin) return res.status(429).json({ error: `Too many failed attempts — try again in ${lockedMin} min` });

    const user = db.prepare('SELECT * FROM customers WHERE email=?').get(email);
    if (!user || !checkPassword(password, user.password_hash)) {
      loginGuard.fail(email);
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    loginGuard.clear(email);
    audit(user.id, user.email, 'auth.login', null);
    res.json({ token: sign(user), user: pub(user) });
  });

// Current user (token check + fresh profile)
router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM customers WHERE id=?').get(req.customer.id);
  if (!user) return res.status(401).json({ error: 'Account not found' });
  res.json({ user: pub(user) });
});

// Own order history, matched by account email
router.get('/orders', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM customers WHERE id=?').get(req.customer.id);
  if (!user) return res.status(401).json({ error: 'Account not found' });
  const orders = db.prepare('SELECT * FROM orders WHERE email=? ORDER BY id DESC LIMIT 50').all(user.email);
  const itemsQ = db.prepare('SELECT name,size,qty,price FROM order_items WHERE order_id=?');
  res.json({ orders: orders.map(o => ({ ...o, items: itemsQ.all(o.id) })) });
});

// Change own password
router.post('/password', requireAuth, (req, res) => {
  const { current, next } = req.body || {};
  if (!current || !next || String(next).length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  const user = db.prepare('SELECT * FROM customers WHERE id=?').get(req.customer.id);
  if (!user || !checkPassword(String(current), user.password_hash)) {
    return res.status(401).json({ error: 'Current password is wrong' });
  }
  db.prepare('UPDATE customers SET password_hash=? WHERE id=?').run(storePassword(String(next)), user.id);
  audit(user.id, user.email, 'auth.password_change', null);
  res.json({ ok: true });
});

module.exports = router;
