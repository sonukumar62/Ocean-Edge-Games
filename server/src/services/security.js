import { createHmac, randomBytes, randomInt } from 'node:crypto';

const pepper = () => process.env.OEG_OTP_PEPPER || '';
export const makeOtp = () => String(randomInt(0, 1_000_000)).padStart(6, '0');
export const hashChallenge = (value) => createHmac('sha256', pepper()).update(value).digest('hex');
export const makeRecoveryToken = () => randomBytes(32).toString('hex');

export function safeEqualHex(left, right) {
  const a = Buffer.from(String(left || ''), 'hex');
  const b = Buffer.from(String(right || ''), 'hex');
  return a.length === b.length && a.length > 0 && a.length === b.length && a.every((value, index) => value === b[index]);
}
