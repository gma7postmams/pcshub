// API client. Same contract as before: JSON, same-origin cookies, CSRF header on every call.
export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export async function api(method, url, body) {
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

  if (res.status === 401 && !url.startsWith('/api/auth/')) {
    window.location.href = '/login';
    throw new ApiError('Session expired', 401, data);
  }
  if (res.status === 403 && data && data.twofaSetupRequired) {
    window.location.href = '/profile?setup2fa=1';
    throw new ApiError('2FA setup required', 403, data);
  }
  if (res.status === 403 && data && data.mustChangePassword) {
    window.location.href = '/profile?force=1';
    throw new ApiError('Password change required', 403, data);
  }
  if (!res.ok) throw new ApiError((data && data.error) || `Request failed (${res.status})`, res.status, data);
  return data;
}

export const get = (url) => api('GET', url);
export const post = (url, body) => api('POST', url, body === undefined ? {} : body);
export const put = (url, body) => api('PUT', url, body);
export const del = (url) => api('DELETE', url);
