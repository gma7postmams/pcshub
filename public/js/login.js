(async function () {
  'use strict';
  const { api, esc } = App;
  App.registerSW();
  const b = await App.loadBranding();
  document.getElementById('brand').innerHTML =
    `${App.brandHtml(b)}${b.tagline ? `<span class="tagline">${esc(b.tagline)}</span>` : ''}`;
  document.title = `Sign in · ${b.app_name}`;

  const err = document.getElementById('err');
  const lf = document.getElementById('login-form');
  const of = document.getElementById('otp-form');
  const showErr = (m) => { err.textContent = m; err.classList.toggle('hidden', !m); };
  const go = (r) => { location.href = r.mustChangePassword ? '/profile?force=1' : '/'; };

  lf.addEventListener('submit', async (e) => {
    e.preventDefault();
    showErr('');
    const btn = lf.querySelector('button');
    btn.disabled = true;
    try {
      const r = await api('POST', '/api/auth/login', { username: lf.username.value, password: lf.password.value });
      if (r.twofa) {
        lf.classList.add('hidden'); of.classList.remove('hidden'); of.token.value = ''; of.token.focus();
      } else go(r);
    } catch (ex) { showErr(ex.message); } finally { btn.disabled = false; }
  });

  of.addEventListener('submit', async (e) => {
    e.preventDefault();
    showErr('');
    const btn = of.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      go(await api('POST', '/api/auth/2fa', { token: of.token.value }));
    } catch (ex) {
      showErr(ex.message);
      if (ex.status === 401 && /expired|again/i.test(ex.message)) { of.classList.add('hidden'); lf.classList.remove('hidden'); }
    } finally { btn.disabled = false; }
  });
  of.token.addEventListener('input', () => {
    of.token.value = of.token.value.replace(/\D/g, '').slice(0, 6);
    if (of.token.value.length === 6) of.requestSubmit();
  });
  document.getElementById('otp-back').addEventListener('click', () => {
    of.classList.add('hidden'); lf.classList.remove('hidden'); showErr('');
  });
})();
