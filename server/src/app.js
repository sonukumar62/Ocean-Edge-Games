import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import cors from 'cors';
import helmet from 'helmet';
import { randomBytes } from 'node:crypto';
import { checkDatabaseConnection, pool } from './config/db.js';
import { csrfProtection, csrfToken } from './middleware/csrf.js';
import { authRouter } from './routes/auth.js';
import { platformRouter } from './routes/platform.js';
import { paymentsRouter, razorpayWebhookRouter } from './routes/payments.js';
import { requireAdmin } from './middleware/auth.js';

export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
const storageOrigin=(()=>{try{return new URL(process.env.SUPABASE_URL).origin;}catch{return null;}})();
const configuredClientOrigin = (() => {
  const value = process.env.CLIENT_URL || 'http://localhost:5173';
  try { return new URL(value).origin; } catch { return value; }
})();
const clientOrigins = new Set([configuredClientOrigin]);
if (process.env.NODE_ENV === 'development') {
  for (const port of [5173, 5174]) {
    clientOrigins.add(`http://localhost:${port}`);
    clientOrigins.add(`http://127.0.0.1:${port}`);
  }
}
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'blob:', ...(storageOrigin?[storageOrigin]:[])],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
      scriptSrc: ["'self'", 'https://checkout.razorpay.com'],
      frameSrc: ["'self'", 'https://api.razorpay.com', 'https://checkout.razorpay.com'],
      connectSrc: ["'self'", 'ws://localhost:5173', 'ws://localhost:5174', 'ws://127.0.0.1:5173', 'ws://127.0.0.1:5174', 'https://api.razorpay.com', ...(storageOrigin?[storageOrigin]:[])],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
}));
app.use(cors({
  origin(origin, callback) {
    if (!origin || clientOrigins.has(origin)) return callback(null, true);
    return callback(new Error('Origin is not allowed by CORS.'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));
app.use('/api/payments/webhook', express.raw({ type: 'application/json', limit: '1mb' }), razorpayWebhookRouter);
app.use(express.json({ limit: '256kb' }));
const PgStore = connectPgSimple(session);
const sessionSecret = process.env.SESSION_SECRET || randomBytes(48).toString('hex');
if (!process.env.SESSION_SECRET) console.warn('[setup] SESSION_SECRET missing; sessions will be invalidated on server restart. Configure a stable secret.');
app.use(session({
  name: 'oeg.sid',
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  store: pool ? new PgStore({ pool, tableName: 'sessions', createTableIfMissing: false }) : undefined,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 24 * 7 },
}));
app.use(csrfProtection);

app.get('/api/health', async (req, res) => {
  const databaseStatus = await checkDatabaseConnection();
  const database = databaseStatus.connected ? 'connected' : pool ? 'unavailable' : 'not_configured';
  const schema = databaseStatus.connected ? (databaseStatus.schemaReady ? 'ready' : 'not_ready') : 'unknown';
  const ready = database === 'connected' && schema === 'ready';
  const emailConfigured = Boolean(process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.SMTP_USER && process.env.SMTP_APP_PASSWORD);
  res.status(ready ? 200 : 503).json({ service: 'ocean-edge-games-api', status: ready ? 'ok' : 'setup_required', database, registrationSchema: schema, emailConfigured, verificationConfigured: emailConfigured && Boolean(process.env.OEG_OTP_PEPPER), paymentsConfigured: Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET && process.env.RAZORPAY_MODE === 'test') });
});
app.get('/api/auth/csrf', csrfToken);
app.use('/api/auth', authRouter);
app.use('/api', platformRouter);
app.use('/api/payments', paymentsRouter);

app.get('/api/admin/session', requireAdmin, (req, res) => res.json({ ok: true }));

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
function safeErrorSummary(error) {
  const details = String(error?.message || 'Unknown error')
    .replace(/(?:postgres(?:ql)?|https?):\/\/[^\s"'<>]+/gi, '[connection URL redacted]')
    .replace(/(password|passwd|secret|token)\s*[=:]\s*[^,;\s]+/gi, '$1=[redacted]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 400);
  return `${error?.code || error?.name || 'internal'}: ${details}`;
}
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error.code === 'DATABASE_NOT_CONFIGURED' || error.code === 'EMAIL_NOT_CONFIGURED' || error.code === 'PAYMENTS_NOT_CONFIGURED' || error.code === 'STORAGE_NOT_CONFIGURED' || error.code === 'EMAIL_DELIVERY_FAILED') return res.status(503).json({ error: error.message, code: error.code });
  if (error.code === '23505' && error.constraint === 'teams_name_game_idx') return res.status(409).json({ error: 'Team name already exists for this game.' });
  if (error.code === '23505') return res.status(409).json({ error: 'That record already exists.' });
  if (error.code === '42P01' || error.code === '42703') {
    console.error(`[api] ${req.method} ${req.path} failed (${error.code}): a required database table or column is missing.`);
    return res.status(503).json({ error: 'The database is connected, but its application schema is incomplete. Apply the missing database migrations in numeric order and restart the server.', code: 'DATABASE_SCHEMA_NOT_READY' });
  }
  if (error.status && error.status < 500) return res.status(error.status).json({ error: error.message });
  const diagnostic = safeErrorSummary(error);
  console.error(`[api] ${req.method} ${req.path} failed (${diagnostic})`);
  res.status(500).json({
    error: 'The request could not be completed.',
    ...(process.env.NODE_ENV === 'development' ? { diagnostic } : {}),
  });
});
