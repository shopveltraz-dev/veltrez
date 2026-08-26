// VELTREZ storefront shared runtime: cart (localStorage), cart drawer,
// checkout flow, order tracking. Injected markup so every page gets the same
// drawer without duplicating it.
(function () {
  const CART_KEY = 'vz_cart';
  // Pre-launch: hide all prices in the storefront (admin still shows them).
  const HIDE_PRICES = true;
  window.VZ_HIDE_PRICES = HIDE_PRICES;
  // Pre-launch: browsing, accounts and reviews work, but checkout shows
  // "coming soon" instead of the order form. Server enforces the same gate.
  const SHOP_OPEN = false;
  let shipCfg = { flat: 25, free_over: 250 };
  fetch('/api/orders/shipping-config').then(r => r.json()).then(c => { shipCfg = c; renderCart(); }).catch(() => {});

  const $ = sel => document.querySelector(sel);
  const money = n => HIDE_PRICES ? '' : '₪' + (Math.round(n * 100) / 100);
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function cart() {
    try { return JSON.parse(localStorage.getItem(CART_KEY)) || []; } catch { return []; }
  }
  function setCart(items) {
    try { localStorage.setItem(CART_KEY, JSON.stringify(items)); } catch {}
    renderCart();
  }

  window.vzAddToCart = function (item, qty, size) {
    const items = cart();
    const found = items.find(i => i.id === item.id && i.size === size);
    if (found) found.qty = Math.min(10, found.qty + qty);
    else items.push({ id: item.id, slug: item.slug, name: item.name, price: item.price, image: item.image_url, size, qty });
    setCart(items);
    openCart();
    toast(`${item.name} added 💗`);
  };

  function toast(msg) {
    let t = $('#vz-toast');
    if (!t) { t = document.createElement('div'); t.id = 'vz-toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2200);
  }
  window.vzToast = toast;

  // ── Injected drawer + modals ──
  const wrap = document.createElement('div');
  wrap.innerHTML = `
  <div class="vz-overlay" id="vz-overlay"></div>
  <aside class="vz-drawer" id="vz-drawer" aria-label="Cart">
    <div class="vz-drawer-head"><h3>Your cart <span class="spark">✦</span></h3><button class="vz-x" id="vz-close">×</button></div>
    <div class="vz-drawer-body" id="vz-cart-body"></div>
    <div class="vz-drawer-foot" id="vz-cart-foot"></div>
  </aside>
  <div class="vz-modal" id="vz-checkout">
    <div class="vz-modal-card">
      <div class="vz-drawer-head"><h3>Checkout <span class="spark">✦</span></h3><button class="vz-x" data-close="vz-checkout">×</button></div>
      <form id="vz-co-form">
        <label>Full name<input name="name" required maxlength="80" autocomplete="name"></label>
        <label>Email<input name="email" type="email" required maxlength="120" autocomplete="email"></label>
        <label>Phone<input name="phone" type="tel" required maxlength="30" autocomplete="tel" placeholder="05x-xxxxxxx"></label>
        <label>Notes<textarea name="notes" maxlength="500" rows="2" placeholder="optional"></textarea></label>
        <div class="vz-pay">
          <label class="pill"><input type="radio" name="payment_method" value="cash" checked>Cash on delivery</label>
          <label class="pill"><input type="radio" name="payment_method" value="bit">Bit / PayBox</label>
        </div>
        <div class="vz-co-total" id="vz-co-total"></div>
        <button class="vz-btn" type="submit" id="vz-co-submit">Place order</button>
        <p class="vz-co-err" id="vz-co-err"></p>
      </form>
      <div id="vz-co-done" hidden>
        <p class="vz-done-big">🎀</p>
        <h3>Order placed!</h3>
        <p>Your order number is <b id="vz-done-num"></b>.<br>A confirmation was sent to your email.
        Keep the number — you can track your order with it any time.</p>
        <button class="vz-btn" data-close="vz-checkout">Done</button>
      </div>
    </div>
  </div>
  <div class="vz-modal" id="vz-track">
    <div class="vz-modal-card">
      <div class="vz-drawer-head"><h3>Track order <span class="spark">✦</span></h3><button class="vz-x" data-close="vz-track">×</button></div>
      <form id="vz-track-form">
        <label>Order number<input name="n" required placeholder="VZ-XXXXXXXX" maxlength="20"></label>
        <label>Email<input name="e" type="email" required maxlength="120"></label>
        <button class="vz-btn" type="submit">Track</button>
        <p class="vz-co-err" id="vz-track-err"></p>
      </form>
      <div id="vz-track-result"></div>
    </div>
  </div>
  <div class="vz-modal" id="vz-soon">
    <div class="vz-modal-card vz-soon-card">
      <button class="vz-x" data-close="vz-soon">×</button>
      <p class="vz-done-big">🎀</p>
      <h3>Coming soon <span class="spark">✦</span></h3>
      <p>The drop isn't open yet — we're still making sure every piece is perfect.<br>
      Your cart is saved. Make an account and follow us so you're first to know.</p>
      <p class="vz-soon-ar" dir="rtl">قريباً ✦ المتجر لسا مش مفتوح، بس سلتك محفوظة 💗</p>
      <button class="vz-btn" data-close="vz-soon">Okay 💗</button>
    </div>
  </div>
  <div class="vz-modal" id="vz-account">
    <div class="vz-modal-card">
      <div class="vz-drawer-head"><h3>Account <span class="spark">✦</span></h3><button class="vz-x" data-close="vz-account">×</button></div>
      <div id="vz-acct-guest">
        <div class="vz-tabs">
          <button class="vz-chip on" data-atab="login" type="button">Log in</button>
          <button class="vz-chip" data-atab="register" type="button">Register</button>
        </div>
        <form id="vz-login-form" data-apanel="login">
          <label>Email<input name="email" type="email" required maxlength="120" autocomplete="email"></label>
          <label>Password<input name="password" type="password" required autocomplete="current-password"></label>
          <button class="vz-btn" type="submit">Log in</button>
          <p class="vz-co-err" id="vz-login-err"></p>
        </form>
        <form id="vz-reg-form" data-apanel="register" hidden>
          <label>Full name<input name="name" required maxlength="80" autocomplete="name"></label>
          <label>Email<input name="email" type="email" required maxlength="120" autocomplete="email"></label>
          <label>Phone<input name="phone" type="tel" required maxlength="30" autocomplete="tel" placeholder="05x-xxxxxxx"></label>
          <label>Password (min 6)<input name="password" type="password" required minlength="6" autocomplete="new-password"></label>
          <label>Confirm password<input name="password_confirm" type="password" required minlength="6" autocomplete="new-password"></label>
          <button class="vz-btn" type="submit">Create account</button>
          <p class="vz-co-err" id="vz-reg-err"></p>
        </form>
      </div>
      <div id="vz-acct-user" hidden>
        <p>Hi <b id="vz-acct-name"></b> 🎀<br><span class="muted small" id="vz-acct-email"></span></p>
        <h4>My orders</h4>
        <div id="vz-acct-orders"></div>
        <button class="vz-btn ghost" type="button" id="vz-logout">Log out</button>
      </div>
    </div>
  </div>`;
  document.addEventListener('DOMContentLoaded', () => {
    document.body.appendChild(wrap);
    renderCart();

    $('#vz-overlay').onclick = closeAll;
    $('#vz-close').onclick = closeAll;
    document.querySelectorAll('[data-close]').forEach(b => b.onclick = closeAll);
    const cartBtn = $('#vz-cart-btn');
    if (cartBtn) cartBtn.onclick = openCart;
    const trackBtn = $('#vz-track-btn');
    if (trackBtn) trackBtn.onclick = e => { e.preventDefault(); openModal('vz-track'); };

    // ── Account (login / register / my orders) ──
    const acctBtn = $('#vz-acct-btn');
    if (acctBtn) acctBtn.onclick = e => { e.preventDefault(); openModal('vz-account'); renderAccount(); };
    const openAuth = tab => { openModal('vz-account'); renderAccount(); showAuthTab(tab); };
    window.vzOpenAuth = openAuth;
    window.vzGetUser  = getUser;
    window.vzGetToken = getToken;
    const loginBtn = $('#vz-login-btn'), regBtn = $('#vz-reg-btn');
    if (loginBtn) loginBtn.onclick = e => { e.preventDefault(); openAuth('login'); };
    if (regBtn)   regBtn.onclick   = e => { e.preventDefault(); openAuth('register'); };
    function showAuthTab(tab) {
      document.querySelectorAll('[data-atab]').forEach(x => x.classList.toggle('on', x.dataset.atab === tab));
      document.querySelectorAll('[data-apanel]').forEach(p => p.hidden = p.dataset.apanel !== tab);
    }
    document.querySelectorAll('[data-atab]').forEach(b => b.onclick = () => showAuthTab(b.dataset.atab));
    async function authSubmit(form, path, errEl) {
      errEl.textContent = '';
      const data = Object.fromEntries(new FormData(form).entries());
      if (path === 'register' && data.password !== data.password_confirm) {
        errEl.textContent = 'Passwords do not match';
        form.password_confirm.focus();
        return;
      }
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const r = await fetch('/api/auth/' + path, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'Something went wrong');
        setUser(j.token, j.user);
        form.reset();
        toast(path === 'register' ? 'Welcome to VELTREZ ✦' : 'Logged in ✦');
        renderAccount();
      } catch (ex) { errEl.textContent = ex.message; }
      btn.disabled = false;
    }
    $('#vz-login-form').onsubmit = e => { e.preventDefault(); authSubmit(e.target, 'login', $('#vz-login-err')); };
    $('#vz-reg-form').onsubmit   = e => { e.preventDefault(); authSubmit(e.target, 'register', $('#vz-reg-err')); };
    $('#vz-logout').onclick = () => { setUser('', null); renderAccount(); toast('Logged out'); };
    renderAccount();

    $('#vz-co-form').onsubmit = async e => {
      e.preventDefault();
      const f = e.target, err = $('#vz-co-err');
      err.textContent = '';
      const btn = $('#vz-co-submit');
      btn.disabled = true; btn.textContent = 'Placing…';
      try {
        const data = Object.fromEntries(new FormData(f).entries());
        data.items = cart().map(i => ({ id: i.id, size: i.size, qty: i.qty }));
        const r = await fetch('/api/orders', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'Something went wrong');
        setCart([]);
        f.hidden = true;
        $('#vz-done-num').textContent = j.order.order_number;
        $('#vz-co-done').hidden = false;
      } catch (ex) { err.textContent = ex.message; }
      btn.disabled = false; btn.textContent = 'Place order';
    };

    $('#vz-track-form').onsubmit = async e => {
      e.preventDefault();
      const f = e.target, err = $('#vz-track-err'), out = $('#vz-track-result');
      err.textContent = ''; out.innerHTML = '';
      try {
        const q = new URLSearchParams(new FormData(f)).toString();
        const r = await fetch('/api/orders/track?' + q);
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'Not found');
        const o = j.order;
        const STEPS = ['pending', 'confirmed', 'shipped', 'delivered'];
        const stepHtml = o.status === 'cancelled'
          ? '<p class="vz-cancelled">This order was cancelled.</p>'
          : '<div class="vz-steps">' + STEPS.map(s =>
              `<span class="vz-step${STEPS.indexOf(s) <= STEPS.indexOf(o.status) ? ' on' : ''}">${s}</span>`
            ).join('') + '</div>';
        out.innerHTML = `<div class="vz-track-card">
          <b>${esc(o.order_number)}</b> · ${new Date(o.created_at.replace(' ', 'T') + 'Z').toLocaleDateString()}
          ${stepHtml}
          ${o.items.map(i => `<div class="vz-row"><span>${i.qty}× ${esc(i.name)} (${esc(i.size || '-')})</span><span>${money(i.price * i.qty)}</span></div>`).join('')}
          ${HIDE_PRICES ? '' : `<div class="vz-row"><span>Shipping</span><span>${o.shipping ? money(o.shipping) : 'Free'}</span></div>
          <div class="vz-row total"><span>Total</span><span>${money(o.total)}</span></div>`}
        </div>`;
      } catch (ex) { err.textContent = ex.message; }
    };
  });

  // ── Session helpers ──
  const TOKEN_KEY = 'vz_token', USER_KEY = 'vz_user';
  function getUser() { try { return JSON.parse(localStorage.getItem(USER_KEY)) || null; } catch { return null; } }
  function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
  function setUser(token, user) {
    try {
      if (user) { localStorage.setItem(TOKEN_KEY, token); localStorage.setItem(USER_KEY, JSON.stringify(user)); }
      else { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); }
    } catch {}
    prefillCheckout();
    window.dispatchEvent(new CustomEvent('vz:auth', { detail: { user } }));
  }
  function prefillCheckout() {
    const u = getUser(), f = $('#vz-co-form');
    if (!f) return;
    if (u) {
      if (!f.name.value)  f.name.value  = u.name || '';
      if (!f.email.value) f.email.value = u.email || '';
      if (!f.phone.value) f.phone.value = u.phone || '';
    }
    const btn = $('#vz-acct-btn');
    if (btn) { btn.textContent = u ? (String(u.name).split(' ')[0] || 'Account') : 'Account'; btn.hidden = !u; }
    const lb = $('#vz-login-btn'), rb = $('#vz-reg-btn');
    if (lb) lb.hidden = !!u;
    if (rb) rb.hidden = !!u;
  }
  async function renderAccount() {
    const u = getUser();
    $('#vz-acct-guest').hidden = !!u;
    $('#vz-acct-user').hidden  = !u;
    prefillCheckout();
    if (!u) return;
    $('#vz-acct-name').textContent  = u.name;
    $('#vz-acct-email').textContent = u.email;
    const box = $('#vz-acct-orders');
    box.innerHTML = '<p class="muted small">Loading…</p>';
    try {
      const r = await fetch('/api/auth/orders', { headers: { Authorization: 'Bearer ' + getToken() } });
      if (r.status === 401) { setUser('', null); renderAccount(); return; }
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Could not load orders');
      box.innerHTML = !j.orders.length ? '<p class="muted small">No orders yet — go shopping ✦</p>' :
        j.orders.map(o => `<div class="vz-track-card">
          <b>${esc(o.order_number)}</b> · ${new Date(o.created_at.replace(' ', 'T') + 'Z').toLocaleDateString()}
          · <span class="vz-status vz-status-${esc(o.status)}">${esc(o.status)}</span>
          ${o.items.map(i => `<div class="vz-row"><span>${i.qty}× ${esc(i.name)} (${esc(i.size || '-')})</span><span>${money(i.price * i.qty)}</span></div>`).join('')}
          ${HIDE_PRICES ? '' : `<div class="vz-row total"><span>Total</span><span>${money(o.total)}</span></div>`}
        </div>`).join('');
    } catch (ex) { box.innerHTML = `<p class="vz-co-err">${esc(ex.message)}</p>`; }
  }

  function openModal(id) { closeAll(); $('#vz-overlay').classList.add('show'); $('#' + id).classList.add('show'); }
  function openCart() { closeAll(); $('#vz-overlay').classList.add('show'); $('#vz-drawer').classList.add('show'); }
  function closeAll() {
    document.querySelectorAll('.vz-overlay,.vz-drawer,.vz-modal').forEach(el => el.classList.remove('show'));
    // Reset checkout modal for next open
    const f = $('#vz-co-form'), d = $('#vz-co-done');
    if (f && d && !d.hidden) { f.hidden = false; f.reset(); d.hidden = true; }
  }
  window.vzOpenCart = openCart;

  function renderCart() {
    const body = $('#vz-cart-body'), foot = $('#vz-cart-foot');
    const badge = $('#vz-cart-count');
    const items = cart();
    const count = items.reduce((s, i) => s + i.qty, 0);
    if (badge) { badge.textContent = count; badge.style.display = count ? '' : 'none'; }
    if (!body) return;
    if (!items.length) {
      body.innerHTML = '<p class="vz-empty">Your cart is empty… for now <span class="spark">✦</span></p>';
      foot.innerHTML = '';
      return;
    }
    body.innerHTML = items.map((i, idx) => `
      <div class="vz-cart-item">
        <img src="${esc(i.image)}" alt="">
        <div class="grow">
          <b>${esc(i.name)}</b><span class="muted">Size ${esc(i.size)}</span>
          <div class="vz-qty">
            <button data-q="${idx}:-1">−</button><span>${i.qty}</span><button data-q="${idx}:1">+</button>
            <button class="vz-rm" data-rm="${idx}">remove</button>
          </div>
        </div>
        <span class="price">${money(i.price * i.qty)}</span>
      </div>`).join('');
    const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
    const shipping = subtotal >= shipCfg.free_over ? 0 : shipCfg.flat;
    foot.innerHTML = (HIDE_PRICES ? '' : `
      <div class="vz-row"><span>Subtotal</span><span>${money(subtotal)}</span></div>
      <div class="vz-row"><span>Shipping</span><span>${shipping ? money(shipping) : 'Free 🎀'}</span></div>
      ${shipping ? `<p class="muted small">Free shipping over ${money(shipCfg.free_over)}</p>` : ''}
      <div class="vz-row total"><span>Total</span><span>${money(subtotal + shipping)}</span></div>`) + `
      <button class="vz-btn" id="vz-go-checkout">Checkout</button>`;
    foot.querySelector('#vz-go-checkout').onclick = () => {
      if (!SHOP_OPEN) { openModal('vz-soon'); return; }
      openModal('vz-checkout');
      const n = `${count} item${count > 1 ? 's' : ''}`;
      $('#vz-co-total').textContent = HIDE_PRICES ? n : `Total: ${money(subtotal + shipping)} (${n})`;
    };
    body.querySelectorAll('[data-q]').forEach(b => b.onclick = () => {
      const [idx, d] = b.dataset.q.split(':').map(Number);
      const it = cart(); it[idx].qty = Math.max(1, Math.min(10, it[idx].qty + d)); setCart(it);
    });
    body.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => {
      const it = cart(); it.splice(Number(b.dataset.rm), 1); setCart(it);
    });
  }
})();
