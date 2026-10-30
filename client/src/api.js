
let csrf = '';

function apiUrl(path) {
  return `/api${path.startsWith('/') ? path : `/${path}`}`;
}

export async function api(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const { __csrfRetried = false, ...requestOptions } = options;
  const headers = new Headers(options.headers || {});

  if (options.body && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    if (!csrf) {
      const security = await fetch(apiUrl('/auth/csrf'), {
        credentials: 'include',
      });

      if (security.ok) {
        csrf = (await security.json()).token || '';
      }
    }

    if (csrf) headers.set('x-csrf-token', csrf);
  }

  let response;
  try {
    response = await fetch(apiUrl(path), {
      ...requestOptions,
      method,
      headers,
      credentials: 'include',
    });
  } catch (cause) {
    if (cause?.name === 'AbortError') throw cause;
    const isPaymentStep = path.includes('/payments') || /\/tournaments\/[^/]+\/register/.test(path);
    throw new Error(isPaymentStep
      ? 'We could not reach the payment service. Check your connection and Payments & rewards before retrying. If you were charged, contact support with your registration number.'
      : 'We could not reach Ocean Edge Games. Check your connection and try again.');
  }

  const payload = response.status === 204
    ? null
    : await response.json().catch(() => ({}));

  if (payload?.csrfToken) csrf = payload.csrfToken;

  if (
    response.status === 403 &&
    payload?.code === 'CSRF_TOKEN_INVALID' &&
    !__csrfRetried
  ) {
    csrf = '';
    return api(path, {
      ...requestOptions,
      method,
      headers,
      __csrfRetried: true,
    });
  }

  if (!response.ok) {
    const paymentStep = path.includes('/payments') || /\/tournaments\/[^/]+\/register/.test(path);
    const unavailable = [502, 503, 504].includes(response.status);
    const fallback = unavailable
      ? paymentStep
        ? 'The payment service is temporarily unavailable. Check Payments & rewards before retrying; if you were charged, contact support with your registration number.'
        : 'Ocean Edge Games is temporarily unavailable. Please try again shortly.'
      : 'The request could not be completed.';
    const message = payload?.error || fallback;
    const diagnostic = import.meta.env.DEV ? payload?.diagnostic : '';
    const error = new Error(
      diagnostic ? `${message} (${diagnostic})` : message
    );

    error.status = response.status;
    error.code = payload?.code;
    throw error;
  }

  return payload;
}

export const send = (path, body, method = 'POST') =>
  api(path, { method, body: JSON.stringify(body) });

export function money(paise = 0) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(Number(paise || 0) / 100);
}

export function dateTime(value, options = {}) {
  if (!value) return 'Date to be announced';

  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
    ...options,
  }).format(new Date(value));
}
