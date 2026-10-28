import bcrypt from 'bcryptjs';
import { query } from '../config/db.js';

export async function bootstrapAdmin() {
  const email = (process.env.ADMIN_EMAIL || 'admin@ocean.games').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    console.warn('[setup] ADMIN_PASSWORD is not set; initial administrator bootstrap is disabled.');
    return;
  }
  if (email !== 'admin@ocean.games') throw new Error('ADMIN_EMAIL must be admin@ocean.games.');
  if (password.length < 14) throw new Error('ADMIN_PASSWORD must contain at least 14 characters.');
  const existing = await query('select id,role from users where email=$1', [email]);
  if (existing.rowCount) {
    if (existing.rows[0].role !== 'admin') throw new Error('The configured administrator email is already assigned to a non-admin account. Resolve this manually; startup will not escalate it.');
    return;
  }
  const hash = await bcrypt.hash(password, 12);
  await query(`insert into users(email,password_hash,role,email_verified_at) values($1,$2,'admin',now())`, [email, hash]);
  console.info('[setup] Initial administrator account created from protected environment configuration.');
}
