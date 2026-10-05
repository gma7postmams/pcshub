// API client. Same contract as before: JSON, same-origin cookies, CSRF header on every call.
export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

/** `quiet: true` is for background, best-effort calls (the presence heartbeat): a "password change required" / "2FA required" / signed-out answer
    is just an error for that call and does NOT send the browser anywhere — otherwise such a call made from the very page that handles those
    states (Profile) would redirect to itself forever. */
export async function api(method, url, body, { quiet = false } = {}) {
  const opts = { method, headers: { 'X-Requested-With': 'PromoHub' }, credentials: 'same-origin' };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    throw new ApiError('Network error — are you offline?', 0);
  }
  let data = null;
  if ((res.headers.get('content-type') || '').includes('application/json')) data = await res.json();

  if (res.status === 401 && !url.startsWith('/api/auth/') && !quiet) {
    window.location.href = '/login';
    throw new ApiError('Session expired', 401, data);
  }
  if (res.status === 403 && data && data.twofaSetupRequired && !quiet) {
    window.location.href = '/profile?setup2fa=1';
    throw new ApiError('2FA setup required', 403, data);
  }
  if (res.status === 403 && data && data.mustChangePassword && !quiet) {
    window.location.href = '/profile?force=1';
    throw new ApiError('Password change required', 403, data);
  }
  if (!res.ok) throw new ApiError((data && data.error) || `Request failed (${res.status})`, res.status, data);
  return data;
}

export const get = (url, options) => api('GET', url, undefined, options);
export const post = (url, body, options) => api('POST', url, body === undefined ? {} : body, options);
export const put = (url, body) => api('PUT', url, body);
export const patch = (url, body) => api('PATCH', url, body);
export const del = (url) => api('DELETE', url);
