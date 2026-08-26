const express = require('express');
const crypto  = require('crypto');
const db      = require('../db');
const emailSvc = require('../email');
const { rateLimit } = require('../middleware/security');

const router = express.Router();

// Flat-rate shipping, free above the threshold. Kept server-side so the cart
// UI can never talk itself into a cheaper total than the shop charges.
const SHIPPING_FLAT = Number(process.env.SHIPPING_FLAT || 25);
const FREE_SHIP_OVER = Number(process.env.FREE_SHIP_OVER || 250);
const PAYMENT_METHODS = ['cash', 'bit', 'card'];

const orderNumber = () => 'VZ-' + crypto.randomBytes(4).toString('hex').toUpperCase();

// Guest checkout. Prices and availability are re-read from the DB — the client
// only names products, sizes and quantities; totals it sends are ignored.
router.post('/',
  rateLimit({ windowMs: 60e3, max: 8, keyFn: req => 'ip' + req.ip, name: 'checkout' }),
  (req, res) => {
    if (process.env.SHOP_OPEN !== '1') {
      return res.status(503).json({ error: 'Coming soon — the shop is not taking orders yet 🎀' });
    }
    const b = req.body || {};
    const name    = String(b.name || '').trim().slice(0, 80);
    const email   = String(b.email || '').trim().toLowerCase().slice(0, 120);
    const phone   = String(b.phone || '').trim().slice(0, 30);
    const address = String(b.address || '').trim().slice(0, 200);
    const city    = String(b.city || '').trim().slice(0, 80);
    const notes   = String(b.notes || '').trim().slice(0, 500);
    const payment = PAYMENT_METHODS.includes(b.payment_method) ? b.payment_method : 'cash';
    const items   = Array.isArray(b.items) ? b.items.slice(0, 30) : [];

    if (!name) return res.status(400).json({ error: 'Name is required' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Valid email required' });
    if (!/^\+?[\d\s().-]{7,}$/.test(phone)) return res.status(400).json({ error: 'Valid phone number required' });
    if (!items.length) return res.status(400).json({ error: 'Cart is empty' });

    // Resolve every line against the live catalog
    const lines = [];
    for (const it of items) {
      const qty = Math.max(1, Math.min(10, parseInt(it.qty, 10) || 1));
      const p = db.prepare('SELECT * FROM products WHERE id=? AND hidden=0').get(parseInt(it.id, 10) || 0);
      if (!p) return res.status(400).json({ error: 'A product in your cart is no longer available' });
      const sizes = String(p.sizes || '').split(',').map(s => s.trim());
      const size = sizes.includes(String(it.size)) ? String(it.size) : sizes[0] || null;
      if (p.stock < qty) return res.status(409).json({ error: `Not enough stock for ${p.name} (only ${p.stock} left)` });
      lines.push({ product: p, size, qty });
    }

    const subtotal = lines.reduce((s, l) => s + l.product.price * l.qty, 0);
    const shipping = subtotal >= FREE_SHIP_OVER ? 0 : SHIPPING_FLAT;
    const total    = subtotal + shipping;

    // Unique order number — regenerate on the astronomically unlikely collision
    let num = orderNumber();
    while (db.prepare('SELECT id FROM orders WHERE order_number=?').get(num)) num = orderNumber();

    const { lastInsertRowid: orderId } = db.prepare(`
      INSERT INTO orders (order_number,customer_name,email,phone,address,city,notes,
                          subtotal,shipping,total,payment_method)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(num, name, email, phone, address, city, notes, subtotal, shipping, total, payment);

    for (const l of lines) {
      db.prepare('INSERT INTO order_items (order_id,product_id,name,size,qty,price) VALUES (?,?,?,?,?,?)')
        .run(orderId, l.product.id, l.product.name, l.size, l.qty, l.product.price);
      db.prepare('UPDATE products SET stock=stock-?, sold=sold+? WHERE id=?')
        .run(l.qty, l.qty, l.product.id);
    }

    const itemsText = lines.map(l => `${l.qty}× ${l.product.name} (${l.size}) — ₪${l.product.price * l.qty}`).join('\n   ');
    const itemsHtml = lines.map(l =>
      `<tr><td style="padding:6px 0;">${l.qty}× <b>${l.product.name}</b> (${l.size})</td>` +
      `<td style="padding:6px 0;text-align:right;">₪${l.product.price * l.qty}</td></tr>`).join('');
    emailSvc.sendEmail({
      to: email,
      subject: `Order ${num} confirmed 💗`,
      title: 'Your order is in!',
      text: `Order ${num}\n   ${itemsText}\n   Shipping: ₪${shipping}\n   Total: ₪${total}\nTrack it any time on the site with your order number + email.`,
      html: `<p>Hi ${name}, we got your order <b>${num}</b> — so cute of you.</p>
        <table style="width:100%;border-collapse:collapse;">${itemsHtml}
        <tr><td style="padding:6px 0;color:#b08d96;">Shipping</td><td style="text-align:right;">${shipping ? '₪' + shipping : 'Free'}</td></tr>
        <tr><td style="padding:10px 0;font-size:16px;"><b>Total</b></td><td style="text-align:right;font-size:16px;"><b>₪${total}</b></td></tr></table>
        <p>Payment: <b>${payment === 'cash' ? 'Cash on delivery' : payment === 'bit' ? 'Bit / PayBox' : 'Card'}</b>.
        Track it any time with your order number + email.</p>`,
    }).catch(e => console.error('Order email failed:', e.message));

    res.status(201).json({
      order: { order_number: num, subtotal, shipping, total, status: 'pending', payment_method: payment },
    });
  });

// Public tracking: order number + the email it was placed with. The email
// check is what keeps order numbers from being an enumerable window into
// other people's addresses.
router.get('/track',
  rateLimit({ windowMs: 60e3, max: 20, keyFn: req => 'ip' + req.ip, name: 'track' }),
  (req, res) => {
    const num   = String(req.query.n || '').trim().toUpperCase().slice(0, 20);
    const email = String(req.query.e || '').trim().toLowerCase().slice(0, 120);
    const o = db.prepare('SELECT * FROM orders WHERE order_number=? AND email=?').get(num, email);
    if (!o) return res.status(404).json({ error: 'No order found for that number and email' });
    const items = db.prepare('SELECT name,size,qty,price FROM order_items WHERE order_id=?').all(o.id);
    res.json({
      order: {
        order_number: o.order_number, status: o.status, created_at: o.created_at,
        subtotal: o.subtotal, shipping: o.shipping, total: o.total,
        payment_method: o.payment_method, items,
      },
    });
  });

// Cart UI needs the shipping rule to show an honest total before checkout
router.get('/shipping-config', (_, res) =>
  res.json({ flat: SHIPPING_FLAT, free_over: FREE_SHIP_OVER }));

module.exports = router;
