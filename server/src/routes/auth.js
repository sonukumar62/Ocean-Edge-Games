import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import { query, withTransaction } from '../config/db.js';
import { hashChallenge, makeOtp, makeRecoveryToken, safeEqualHex } from '../services/security.js';
import { sendCode, sendRecoveryLink } from '../services/email.js';
import { recordAudit, notifyAdmin } from '../services/audit.js';
import { requireAuth } from '../middleware/auth.js';

export const authRouter = Router();
const registerLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many signup attempts. Wait a little before trying again.' } });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many sign-in attempts. Try again later.' } });
const otpLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many verification attempts. Try again later.' } });
const recoveryLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many recovery attempts. Try again later.' } });

const emailSchema = z.string().trim().email().max(254).transform((value) => value.toLowerCase());
const passwordSchema = z.string().min(10).max(128).refine((value) => /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value), 'Use at least 10 characters with upper and lower case letters and a number.');
const registerSchema = z.object({ email: emailSchema, password: passwordSchema, confirmPassword: z.string() }).refine((value) => value.password === value.confirmPassword, { path: ['confirmPassword'], message: 'Passwords do not match.' });
const profileSchema = z.object({
  fullName: z.string().trim().min(2).max(80),
  username: z.string().trim().min(3).max(24).regex(/^[a-zA-Z0-9_]+$/),
  age: z.coerce.number().int().min(13).max(120),
  phone: z.string().trim().regex(/^\+?[1-9]\d{7,14}$/),
  upiId: z.string().trim().max(120).optional().or(z.literal('')),
});
const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(128) });

function validate(schema, body) {
  const result = schema.safeParse(body);
  return result.success ? { value: result.data } : { error: result.error.issues[0]?.message || 'Invalid request.' };
}

function requireOtpPepper(res) {
  if (process.env.OEG_OTP_PEPPER) return true;
  res.status(503).json({ error: 'Account verification is not configured. Set OEG_OTP_PEPPER on the server.' });
  return false;
}

function publicUser(row) {
  return { id: row.id, email: row.email, role: row.role, name: row.full_name || row.username || '', username: row.username || null, emailVerified: Boolean(row.email_verified_at), manualVerified: Boolean(row.manual_verified_at) };
}

async function establishSession(req, row) {
  await new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
  req.session.user = { id: row.id, role: row.role };
  req.session.csrfToken = (await import('node:crypto')).randomBytes(32).toString('hex');
  return req.session.csrfToken;
}

async function ensureAccountAllowed(row) {
  if (row.status === 'blocked') return false;
  if (row.status === 'suspended' && (!row.suspended_until || new Date(row.suspended_until) > new Date())) return false;
  if (row.status === 'suspended') await query("update users set status='active', suspended_until=null where id=$1", [row.id]);
  return true;
}

authRouter.get('/me', async (req, res, next) => {
  try {
    if (!req.session?.user?.id) return res.json({ user: null });
    const result = await query(`select u.id,u.email,u.role,u.status,u.suspended_until,u.email_verified_at,u.manual_verified_at,p.full_name,p.username
      from users u left join player_profiles p on p.user_id=u.id where u.id=$1`, [req.session.user.id]);
    const row = result.rows[0];
    if (!row || row.status === 'blocked' || (row.status === 'suspended' && (!row.suspended_until || new Date(row.suspended_until) > new Date()))) {
      req.session.destroy(() => {});
      return res.json({ user: null });
    }
    res.json({ user: publicUser(row) });
  } catch (error) { next(error); }
});

authRouter.post('/register', registerLimiter, async (req, res, next) => {
  const checked = validate(registerSchema, req.body);
  if (checked.error) return res.status(400).json({ error: checked.error });
  if (!requireOtpPepper(res)) return;
  try {
    const { email, password } = checked.value;
    const existing = await query('select 1 from users where email=$1', [email]);
    if (existing.rowCount) return res.status(409).json({ error: 'An account already uses that email. Sign in or reset its password.' });
    const pending=await query('select id,password_hash,verified_at,resend_after from pending_registrations where email=$1',[email]);
    if(pending.rows[0]?.verified_at){
      if(!(await bcrypt.compare(password,pending.rows[0].password_hash)))return res.status(409).json({error:'A registration is already in progress for that email. Verify your password to resume profile setup.'});
      req.session.registrationId=pending.rows[0].id;
      return res.json({message:'Email already verified. Complete your profile.',email,profileSetupRequired:true});
    }
    if (pending.rows[0] && new Date(pending.rows[0].resend_after) > new Date()) {
      req.session.registrationId = pending.rows[0].id;
      return res.json({ message: 'A verification code was already sent. Check your inbox or wait before requesting another.', email, resendAfter: pending.rows[0].resend_after });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const code = makeOtp();
    const otpHash = hashChallenge(code);
    const saved = await query(`insert into pending_registrations(email,password_hash,otp_hash,expires_at,resend_after,attempts,verified_at)
      values($1,$2,$3,now()+interval '10 minutes',now()+interval '60 seconds',0,null)
      on conflict(email) do update set password_hash=excluded.password_hash,otp_hash=excluded.otp_hash,expires_at=excluded.expires_at,resend_after=excluded.resend_after,attempts=0,verified_at=null
      where pending_registrations.verified_at is null and pending_registrations.resend_after < now()
      returning id,resend_after`, [email, passwordHash, otpHash]);
    if (!saved.rowCount) {
      const current = await query('select id,password_hash,verified_at,resend_after from pending_registrations where email=$1', [email]);
      if (current.rows[0]?.verified_at) {
        if (!(await bcrypt.compare(password, current.rows[0].password_hash))) return res.status(409).json({ error: 'A registration is already in progress for that email. Verify your password to resume profile setup.' });
        req.session.registrationId = current.rows[0].id;
        return res.json({ message: 'Email already verified. Complete your profile.', email, profileSetupRequired: true });
      }
      if (current.rows[0]) {
        req.session.registrationId = current.rows[0].id;
        return res.json({ message: 'A verification code was already sent. Check your inbox or wait before requesting another.', email, resendAfter: current.rows[0].resend_after });
      }
      return res.status(409).json({ error: 'Registration could not be resumed. Please start again.' });
    }
    try {
      await sendCode(email, code, 'verify your email');
    } catch (mailError) {
      // Do not leave a code the user cannot receive.
      await query('delete from pending_registrations where id=$1', [saved.rows[0].id]);
      throw mailError;
    }
    req.session.registrationId = saved.rows[0].id;
    res.status(pending.rowCount ? 200 : 201).json({ message: 'Verification code sent.', email, resendAfter: saved.rows[0].resend_after });
  } catch (error) { next(error); }
});

authRouter.post('/resend-code', otpLimiter, async (req, res, next) => {
  const checked = validate(z.object({ email: emailSchema }), req.body);
  if (checked.error) return res.status(400).json({ error: checked.error });
  if (!requireOtpPepper(res)) return;
  try {
    const record = await query(`select id,resend_after,verified_at from pending_registrations where email=$1`, [checked.value.email]);
    if (!record.rowCount) return res.status(404).json({ error: 'No pending registration was found for that email.' });
    if (record.rows[0].verified_at) return res.status(409).json({ error: 'Email verification is already complete. Finish your profile.' });
    if (new Date(record.rows[0].resend_after) > new Date()) return res.status(429).json({ error: 'Please wait before requesting another code.', resendAfter: record.rows[0].resend_after });
    const code = makeOtp();
    const saved = await query(`update pending_registrations set otp_hash=$2,expires_at=now()+interval '10 minutes',resend_after=now()+interval '60 seconds',attempts=0
      where id=$1 returning id,resend_after`, [record.rows[0].id, hashChallenge(code)]);
    try { await sendCode(checked.value.email, code, 'verify your email'); }
    catch (mailError) { await query('delete from pending_registrations where id=$1', [saved.rows[0].id]); throw mailError; }
    res.json({ message: 'A new verification code was sent.', resendAfter: saved.rows[0].resend_after });
  } catch (error) { next(error); }
});

authRouter.post('/verify-code', otpLimiter, async (req, res, next) => {
  const checked = validate(z.object({ email: emailSchema, code: z.string().regex(/^\d{6}$/) }), req.body);
  if (checked.error) return res.status(400).json({ error: checked.error });
  if (!requireOtpPepper(res)) return;
  try {
    const found = await query('select id,otp_hash,expires_at,attempts,verified_at from pending_registrations where email=$1', [checked.value.email]);
    const row = found.rows[0];
    if (!row) return res.status(404).json({ error: 'No pending verification was found.' });
    if (row.verified_at) {
      req.session.registrationId = row.id;
      return res.json({ message: 'Email already verified. Complete your profile.' });
    }
    if (new Date(row.expires_at) <= new Date()) return res.status(410).json({ error: 'That code expired. Request a new one.' });
    if (row.attempts >= 5) return res.status(429).json({ error: 'Too many incorrect attempts. Request a new code.' });
    const match = safeEqualHex(hashChallenge(checked.value.code), row.otp_hash);
    if (!match) {
      await query('update pending_registrations set attempts=attempts+1 where id=$1', [row.id]);
      return res.status(400).json({ error: 'That code is not valid.' });
    }
    const consumed = await query(`update pending_registrations set verified_at=now(),otp_hash=$2 where id=$1 and verified_at is null and otp_hash=$3 and expires_at>now() returning id`, [row.id, hashChallenge(`used:${row.id}`), row.otp_hash]);
    if (!consumed.rowCount) return res.status(409).json({ error: 'That code was already used. Continue to profile setup or request a new code.' });
    req.session.registrationId = row.id;
    res.json({ message: 'Email verified. Complete your profile.' });
  } catch (error) { next(error); }
});

authRouter.post('/complete-profile', otpLimiter, async (req, res, next) => {
  const checked = validate(profileSchema, req.body);
  if (checked.error) return res.status(400).json({ error: checked.error });
  if (!req.session?.registrationId) return res.status(401).json({ error: 'Verify your email before completing your profile.' });
  try {
    const created = await withTransaction(async (client) => {
      const pending = await client.query('select * from pending_registrations where id=$1 and verified_at is not null for update', [req.session.registrationId]);
      if (!pending.rowCount) return { status: 401, error: 'The verified registration could not be resumed. Start again.' };
      const duplicate = await client.query('select email from users where email=$1', [pending.rows[0].email]);
      if (duplicate.rowCount) return { status: 409, error: 'An account already uses that email. Sign in instead.' };
      const account = await client.query(`insert into users(email,password_hash,email_verified_at) values($1,$2,now()) returning id,email,role,email_verified_at`, [pending.rows[0].email, pending.rows[0].password_hash]);
      const profile = await client.query(`insert into player_profiles(user_id,full_name,username,age,phone,upi_id)
        values($1,$2,$3,$4,$5,$6) returning full_name,username`, [account.rows[0].id, checked.value.fullName, checked.value.username, checked.value.age, checked.value.phone, checked.value.upiId || null]);
      await client.query('delete from pending_registrations where id=$1', [pending.rows[0].id]);
      await notifyAdmin(client, 'new_registration', 'New player registration', `${profile.rows[0].username} created an account.`, '/pass/ads/players');
      return { user: { ...account.rows[0], ...profile.rows[0] } };
    });
    if (created.error) return res.status(created.status).json({ error: created.error });
    delete req.session.registrationId;
    const csrf = await establishSession(req, created.user);
    res.status(201).json({ user: publicUser(created.user), csrfToken: csrf });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: error.constraint?.includes('username') ? 'That username is already in use.' : 'An account with those details already exists.' });
    next(error);
  }
});

authRouter.post('/login', loginLimiter, async (req, res, next) => {
  const checked = validate(loginSchema, req.body);
  if (checked.error) return res.status(400).json({ error: checked.error });
  try {
    const result = await query(`select u.id,u.email,u.password_hash,u.role,u.status,u.suspended_until,u.email_verified_at,u.manual_verified_at,p.full_name,p.username
      from users u left join player_profiles p on p.user_id=u.id where u.email=$1`, [checked.value.email]);
    const row = result.rows[0];
    const valid = row ? await bcrypt.compare(checked.value.password, row.password_hash) : false;
    if (!valid) return res.status(401).json({ error: 'Email or password is incorrect.' });
    if (!(await ensureAccountAllowed(row))) return res.status(403).json({ error: 'This account cannot sign in. Contact support if you need help.' });
    if (!row.email_verified_at && row.role !== 'admin') return res.status(403).json({ error: 'Verify your email before signing in.' });
    const csrf = await establishSession(req, row);
    res.json({ user: publicUser(row), csrfToken: csrf });
  } catch (error) { next(error); }
});

authRouter.post('/logout', (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie('oeg.sid', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
    res.json({ ok: true });
  });
});

authRouter.post('/forgot-password', recoveryLimiter, async (req, res, next) => {
  const checked = validate(z.object({ email: emailSchema }), req.body);
  if (checked.error) return res.status(400).json({ error: checked.error });
  if (!requireOtpPepper(res)) return;
  try {
    const found = await query('select id,email from users where email=$1 and role=\'player\'', [checked.value.email]);
    // Always return the same response to avoid disclosing whether an account exists.
    if (found.rowCount) {
      const token = makeRecoveryToken();
      const tokenHash = hashChallenge(token);
      await query(`insert into password_reset_challenges(user_id,token_hash,expires_at) values($1,$2,now()+interval '30 minutes')`, [found.rows[0].id, tokenHash]);
      try { await sendRecoveryLink(found.rows[0].email, token); }
      catch (error) {
  const cause = error?.cause || error;

  console.error(JSON.stringify({
    level: 'warn',
    event: 'password_recovery_delivery_failed',
    code: error?.code || null,
    causeCode: cause?.code || null,
    causeMessage: cause?.message || null,
    timeoutType: cause?.timeoutType || null,
    responseCode: cause?.responseCode || null,
    command: cause?.command || null,
  }));
}
    }
    res.json({ message: 'If an eligible account exists and email delivery is available, a reset link will be sent.' });
  } catch (error) { next(error); }
});

authRouter.post('/reset-password', recoveryLimiter, async (req, res, next) => {
  const checked = validate(z.object({ token: z.string().min(32).max(128), password: passwordSchema, confirmPassword: z.string() }).refine((value) => value.password === value.confirmPassword, { path: ['confirmPassword'], message: 'Passwords do not match.' }), req.body);
  if (checked.error) return res.status(400).json({ error: checked.error });
  if (!requireOtpPepper(res)) return;
  try {
    const passwordHash = await bcrypt.hash(checked.value.password, 12);
    const changed = await withTransaction(async (client) => {
      const challenge = await client.query(`select id,user_id from password_reset_challenges where token_hash=$1 and used_at is null and expires_at > now() for update`, [hashChallenge(checked.value.token)]);
      if (!challenge.rowCount) return false;
      await client.query('update users set password_hash=$2,updated_at=now() where id=$1', [challenge.rows[0].user_id, passwordHash]);
      await client.query('update password_reset_challenges set used_at=now() where user_id=$1 and used_at is null', [challenge.rows[0].user_id]);
      await client.query("delete from sessions where sess->'user'->>'id'=$1", [challenge.rows[0].user_id]);
      await recordAudit(client, challenge.rows[0].user_id, 'password_reset', 'user', challenge.rows[0].user_id);
      return true;
    });
    if (!changed) return res.status(400).json({ error: 'That reset link is invalid or expired.' });
    res.json({ message: 'Password updated. Sign in with your new password.' });
  } catch (error) { next(error); }
});

authRouter.post('/change-password', requireAuth, async(req,res,next)=>{
  const checked=validate(z.object({currentPassword:z.string().min(1).max(128),password:passwordSchema,confirmPassword:z.string()}).refine(value=>value.password===value.confirmPassword,{path:['confirmPassword'],message:'Passwords do not match.'}),req.body);
  if(checked.error)return res.status(400).json({error:checked.error});
  try{
    const account=await query('select id,password_hash,role from users where id=$1',[req.session.user.id]);
    if(!account.rowCount||!(await bcrypt.compare(checked.value.currentPassword,account.rows[0].password_hash)))return res.status(401).json({error:'Current password is incorrect.'});
    const hash=await bcrypt.hash(checked.value.password,12);
    await withTransaction(async(client)=>{await client.query('update users set password_hash=$2,updated_at=now() where id=$1',[req.session.user.id,hash]);await client.query("delete from sessions where sess->'user'->>'id'=$1",[req.session.user.id]);await recordAudit(client,req.session.user.id,'password_changed','user',req.session.user.id);});
    const sessionUser={id:account.rows[0].id,role:account.rows[0].role};const csrf=await establishSession(req,sessionUser);
    res.json({message:'Password updated. Other sessions were signed out.',csrfToken:csrf});
  }catch(error){next(error);}
});
