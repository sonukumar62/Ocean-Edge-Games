let csrf = '';

export async function api(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const { __csrfRetried = false, ...requestOptions } = options;
  const headers = new Headers(options.headers || {});
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    if (!csrf) {
      const security = await fetch('/api/auth/csrf', { credentials: 'include' });
      if (security.ok) csrf = (await security.json()).token || '';
    }
    if (csrf) headers.set('x-csrf-token', csrf);
  }
  const response = await fetch(`/api${path}`, { ...requestOptions, method, headers, credentials: 'include' });
  const payload = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (payload?.csrfToken) csrf = payload.csrfToken;
  if (response.status === 403 && payload?.code === 'CSRF_TOKEN_INVALID' && !__csrfRetried) {
    csrf = '';
    return api(path, { ...requestOptions, method, headers, __csrfRetried: true });
  }
  if (!response.ok) {
    const message = payload?.error || 'The request could not be completed.';
    const diagnostic = import.meta.env.DEV ? payload?.diagnostic : '';
    const error = new Error(diagnostic ? `${message} (${diagnostic})` : message);
    error.status = response.status;
    error.code = payload?.code;
    throw error;
  }
  return payload;
}

export const send = (path, body, method = 'POST') => api(path, { method, body: JSON.stringify(body) });

export function money(paise = 0) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(paise || 0) / 100);
}

export function dateTime(value, options = {}) {
  if (!value) return 'Date to be announced';
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata', ...options }).format(new Date(value));
}
