(async function () {
  'use strict';
  const { api, esc, toast, modal, qs } = App;
  const ctx = await App.init('/profile');
  const main = document.getElementById('main');
  const u = ctx.user;
  const forced = u.must_change_password;
  const needs2fa = () => u.totp_required && !u.totp_enabled;

  function render() {
    main.innerHTML = `
      <div class="page-head"><div><h1>Profile</h1><div class="sub">Your account, password and two-factor authentication.</div></div></div>
      ${forced ? '<div class="alert warn mb-12"><strong>Password change required.</strong> Set a new password to continue using the app.</div>' : ''}
      ${!forced && needs2fa() ? '<div class="alert warn mb-12"><strong>Two-factor authentication is required for your account.</strong> Set it up below to continue using the app.</div>' : ''}
      <div class="grid grid-2">
        <div class="card"><div class="card-head"><h2>Account</h2><span class="role-badge r-${esc(u.role)}">${esc(u.role)}</span></div>
          <form class="card-pad stack" id="pf">
            <label class="f"><span>Username</span><input value="${esc(u.username)}" disabled></label>
            <label class="f"><span>Full name</span><input name="full_name" maxlength="120" value="${esc(u.full_name)}"></label>
            <label class="f"><span>Email</span><input name="email" type="email" maxlength="200" value="${esc(u.email || '')}"></label>
            <div><button class="btn primary" ${forced ? 'disabled' : ''}>Save</button></div>
            <dl class="kv">
              <dt>Role</dt><dd>${esc(u.role)} <span class="dim">— what you can do</span></dd>
              <dt>Group</dt><dd>${u.group ? esc(u.group) : (u.role === 'Admin' ? '<span class="dim">Not needed (Admin role opens every page)</span>' : '<span class="dim">Not enrolled — ask an Admin</span>')} <span class="dim">— what you can open</span></dd>
              <dt>Pages</dt><dd>${ctx.pages.map((p) => esc(p.label)).join(', ')}</dd>
            </dl>
          </form></div>
        <div class="card"><div class="card-head"><h2>Change password</h2></div>
          <form class="card-pad stack" id="pwf" autocomplete="off">
            <label class="f"><span>Current password</span><input name="current" type="password" autocomplete="current-password"></label>
            <label class="f"><span>New password</span><input name="password" type="password" autocomplete="new-password" placeholder="8+ chars, letters and numbers"></label>
            <label class="f"><span>Confirm new password</span><input name="confirm" type="password" autocomplete="new-password"></label>
            <div><button class="btn primary">Update password</button></div>
            <div class="dim">Other sessions are signed out when you change your password.</div>
          </form></div>
        <div class="card"><div class="card-head"><h2>Appearance</h2></div>
          <div class="card-pad stack">
            <div>${App.appearanceSeg()}</div>
            <p class="muted m-0 mt-12">Dark, Light, or System to follow your device setting. Saved to your account.
              The colour theme is set by your Admin.</p>
          </div></div>
        <div class="card"><div class="card-head"><h2>Two-factor authentication</h2>${u.totp_enabled ? '<span class="pill s-approved">Enabled</span>' : '<span class="pill s-hold">Off</span>'}</div>
          <div class="card-pad stack">
            <p class="muted m-0">${u.totp_enabled
              ? 'Your account requires a 6-digit code from your authenticator app at sign-in.'
              : 'Protect your account with a time-based code from Google Authenticator, Microsoft Authenticator, 1Password, Authy, etc.'}</p>
            <div>${u.totp_enabled && u.totp_required
              ? '<span class="dim">Required for your account — cannot be disabled.</span>'
              : `<button class="btn ${u.totp_enabled ? 'danger' : 'primary'}" id="tfa" ${forced ? 'disabled' : ''}>${u.totp_enabled ? 'Disable 2FA' : 'Set up 2FA'}</button>`}</div>
          </div></div>
      </div>`;

    App.bindAppearance(main);
    main.querySelector('#pf').addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api('PUT', '/api/profile', App.formData(e.target)); toast('Profile saved'); } catch (ex) { toast(ex.message, 'err'); }
    });
    main.querySelector('#pwf').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      if (f.password.value !== f.confirm.value) { toast('New passwords do not match', 'err'); return; }
      try {
        await api('POST', '/api/profile/password', { current: f.current.value, password: f.password.value });
        toast('Password updated');
        if (forced) setTimeout(() => { location.href = '/'; }, 600);
        f.reset();
      } catch (ex) { toast(ex.message, 'err'); }
    });
    const tfa = main.querySelector('#tfa');
    if (tfa) tfa.addEventListener('click', () => (u.totp_enabled ? disable2fa() : setup2fa()));
  }

  async function setup2fa() {
    let s;
    try { s = await api('POST', '/api/profile/2fa/setup', {}); } catch (e) { toast(e.message, 'err'); return; }
    const m = modal({
      title: 'Set up two-factor authentication', size: 'sm',
      body: `<div class="stack">
        <p class="muted m-0">1. Scan this QR code with your authenticator app.</p>
        <div class="right-center"><span class="qr"><img src="${esc(s.qr)}" alt="2FA QR code"></span></div>
        <p class="muted m-0">Can't scan? Enter this key manually:</p>
        <div class="secret">${esc(s.secret.replace(/(.{4})/g, '$1 ').trim())}</div>
        <label class="f"><span>2. Enter the 6-digit code</span><input id="tok" class="otp-input" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></label>
      </div>`,
      foot: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="en">Enable 2FA</button>',
    });
    const tok = m.el.querySelector('#tok');
    tok.addEventListener('input', () => { tok.value = tok.value.replace(/\D/g, '').slice(0, 6); });
    m.el.querySelector('#en').addEventListener('click', async () => {
      try { await api('POST', '/api/profile/2fa/enable', { token: tok.value }); const wasRequired = needs2fa(); u.totp_enabled = true; toast('2FA enabled'); m.close(); if (wasRequired) { setTimeout(() => { location.href = '/'; }, 600); } else render(); } catch (e) { toast(e.message, 'err'); }
    });
  }

  function disable2fa() {
    const m = modal({
      title: 'Disable two-factor authentication', size: 'sm',
      body: `<div class="stack">
        <label class="f"><span>Password</span><input id="pw" type="password" autocomplete="current-password"></label>
        <label class="f"><span>Current 6-digit code</span><input id="tok" class="otp-input" inputmode="numeric" maxlength="6"></label></div>`,
      foot: '<button class="btn" data-close>Cancel</button><button class="btn danger" id="dis">Disable 2FA</button>',
    });
    m.el.querySelector('#dis').addEventListener('click', async () => {
      try {
        await api('POST', '/api/profile/2fa/disable', { password: m.el.querySelector('#pw').value, token: m.el.querySelector('#tok').value });
        u.totp_enabled = false; toast('2FA disabled'); m.close(); render();
      } catch (e) { toast(e.message, 'err'); }
    });
  }

  render();
  if (qs('force') && !forced) history.replaceState(null, '', '/profile');
  if (!forced && needs2fa()) setup2fa();
})();
