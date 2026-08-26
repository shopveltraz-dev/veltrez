const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  const token = header.slice(7);
  try {
    req.customer = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Role gate — use after requireAuth: requireRole('admin')
function requireRole(role) {
  return (req, res, next) => {
    // Re-check role from DB so a revoked role dies immediately, not at token expiry
    const db = require('../db');
    const u = db.prepare('SELECT role FROM customers WHERE id=?').get(req.customer.id);
    if (!u || u.role !== role) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

// Audit trail helper
function audit(actorIdOrNull, actorLabel, action, detail) {
  try {
    const db = require('../db');
    db.prepare('INSERT INTO audit_log (actor_id,actor,action,detail) VALUES (?,?,?,?)')
      .run(actorIdOrNull, actorLabel || null, action, detail ? String(detail).slice(0, 300) : null);
  } catch (e) { console.error('audit failed:', e.message); }
}

module.exports = requireAuth;
module.exports.requireRole = requireRole;
module.exports.audit = audit;
