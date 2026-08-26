// One-off admin password recovery.
//
// The shop admin password is generated once, at first boot, and printed to
// the log. On a host with rotating logs that is a single point of failure:
// miss the line and the admin panel is unreachable for good, because nothing
// in the app can grant the admin role to anyone else.
//
// Setting ADMIN_RESET to any value fixes that. On the next boot it sets a
// fresh random admin password and prints it once.
//
// The value is used as a nonce, not as the password. Its fingerprint is
// recorded in audit_log when consumed, so a variable left set does NOT reset
// the password again on every deploy — which would otherwise silently undo
// whatever password you set afterwards and look like the reset had failed. To
// reset a second time, change the value. Only the fingerprint is stored, so
// the audit trail shows a reset happened without recording the nonce itself.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db     = require('./db');

const ACTION        = 'admin.reset';
const DEFAULT_EMAIL = 'admin@veltrez.local';

const fingerprint = nonce =>
  crypto.createHash('sha256').update(nonce).digest('hex').slice(0, 16);

function run() {
  const nonce = String(process.env.ADMIN_RESET || '').trim();
  if (!nonce) return null;

  const fp = fingerprint(nonce);
  if (db.prepare('SELECT id FROM audit_log WHERE action=? AND detail=?').get(ACTION, fp)) {
    console.log('🔑 ADMIN_RESET already used — change its value to reset again.');
    return null;
  }

  const pw   = crypto.randomBytes(12).toString('base64url');
  const hash = bcrypt.hashSync(pw, 12);

  // Three cases: an admin exists, no admin exists but the email is taken by an
  // ordinary account, or nothing exists at all. The middle one matters —
  // inserting over a taken email would blow up on the UNIQUE constraint and
  // leave the operator with a failed reset and no idea why.
  let admin = db.prepare("SELECT id, email FROM customers WHERE role='admin' ORDER BY id").get();
  let what;
  if (admin) {
    db.prepare('UPDATE customers SET password_hash=? WHERE id=?').run(hash, admin.id);
    what = 'password reset';
  } else {
    const email    = String(process.env.ADMIN_EMAIL || DEFAULT_EMAIL).trim().toLowerCase();
    const existing = db.prepare('SELECT id FROM customers WHERE email=?').get(email);
    if (existing) {
      db.prepare("UPDATE customers SET password_hash=?, role='admin' WHERE id=?").run(hash, existing.id);
      admin = { id: existing.id, email };
      what  = 'existing account promoted to admin';
    } else {
      const { lastInsertRowid } = db.prepare(
        `INSERT INTO customers (name,email,password_hash,role) VALUES (?,?,?,'admin')`
      ).run('Shop Admin', email, hash);
      admin = { id: lastInsertRowid, email };
      what  = 'admin account created';
    }
  }

  db.prepare('INSERT INTO audit_log (actor_id, actor, action, detail) VALUES (?,?,?,?)')
    .run(admin.id, admin.email, ACTION, fp);

  // Force the snapshot out now. Writes are debounced by 400ms and uploaded to
  // cloud storage on flush; a boot that dies in that window would print a
  // password that was never actually saved.
  db.flush();

  console.log('\n🔑 ADMIN RESET — ' + what);
  console.log(`   email:    ${admin.email}`);
  console.log(`   password: ${pw}`);
  console.log('   Shown ONCE. Save it, then remove ADMIN_RESET from the environment.\n');
  return { email: admin.email, action: what };
}

module.exports = { run, fingerprint, ACTION };
