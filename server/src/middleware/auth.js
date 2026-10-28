import { query } from '../config/db.js';

async function authorize(req, res, next, expectedRole = null) {
  if (!req.session?.user?.id) return res.status(401).json({ error: 'Authentication required.' });
  const result = await query('select id,role,status,suspended_until from users where id=$1', [req.session.user.id]);
  const account = result.rows[0];
  const suspended = account?.status === 'suspended' && (!account.suspended_until || new Date(account.suspended_until) > new Date());
  if (!account || account.status === 'blocked' || suspended) {
    req.session.destroy(() => {});
    return res.status(403).json({ error: 'This account cannot access the platform. Contact support if you need help.' });
  }
  if (account.status === 'suspended') await query("update users set status='active',suspended_until=null where id=$1", [account.id]);
  req.session.user.role = account.role;
  if (expectedRole && account.role !== expectedRole) return res.status(403).json({ error: `${expectedRole === 'admin' ? 'Administrator' : 'Player'} access required.` });
  return next();
}

export const requireAuth = (req,res,next) => authorize(req,res,next);
export const requirePlayer = (req,res,next) => authorize(req,res,next,'player');
export const requireAdmin = (req,res,next) => authorize(req,res,next,'admin');
