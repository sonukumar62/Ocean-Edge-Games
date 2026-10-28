import { randomBytes, timingSafeEqual } from 'node:crypto';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export function csrfToken(req, res) {
  req.session.csrfToken ??= randomBytes(32).toString('hex');
  res.json({ token: req.session.csrfToken });
}

export function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method) || req.path === '/api/payments/webhook') return next();
  const expected = req.session?.csrfToken;
  const provided = req.get('x-csrf-token');
  if (!expected || !provided || expected.length !== provided.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(provided))) {
    return res.status(403).json({ error: 'Session security token is missing or expired.', code: 'CSRF_TOKEN_INVALID' });
  }
  next();
}
