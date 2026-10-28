import nodemailer from 'nodemailer';

function transporter() {
  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_APP_PASSWORD } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_APP_PASSWORD) {
    const error = new Error('Email delivery is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_APP_PASSWORD.');
    error.status = 503;
    error.code = 'EMAIL_NOT_CONFIGURED';
    throw error;
  }
  return nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT),
  secure: String(SMTP_SECURE).toLowerCase() === 'true',
  auth: {
    user: SMTP_USER,
    pass: SMTP_APP_PASSWORD,
  },
  tls: {
    rejectUnauthorized: true,
  },

  // Fail promptly if the SMTP server cannot be reached.
  connectionTimeout: 15000,
  greetingTimeout: 10000,
  socketTimeout: 30000,
});
}

export async function sendCode(to, code, purpose = 'verify your email') {
  const mail = transporter();
  try { await mail.sendMail({
    from: { name: process.env.SMTP_FROM_NAME || 'Ocean Edge Games', address: process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER },
    to,
    subject: `Ocean Edge Games — ${purpose}`,
    text: `Your Ocean Edge Games code is ${code}. It expires in 10 minutes. If you did not request this, you can ignore this email.`,
  }); } catch (cause) {
    const error = new Error('Email delivery failed. Check the server SMTP configuration and try again.');
    error.status = 503;
    error.code = 'EMAIL_DELIVERY_FAILED';
    error.cause = cause;
    throw error;
  }
}

export async function sendRecoveryLink(to, token) {
  const mail = transporter();
  const url = `${process.env.CLIENT_URL || 'http://localhost:5173'}/reset-password?token=${encodeURIComponent(token)}`;
  try { await mail.sendMail({
    from: { name: process.env.SMTP_FROM_NAME || 'Ocean Edge Games', address: process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER },
    to,
    subject: 'Ocean Edge Games — password reset',
    text: `Use this one-time link to reset your password. It expires in 30 minutes: ${url}\nIf you did not request this, ignore this email.`,
  }); } catch (cause) {
    const error = new Error('Email delivery failed. Check the server SMTP configuration and try again.');
    error.status = 503;
    error.code = 'EMAIL_DELIVERY_FAILED';
    error.cause = cause;
    throw error;
  }
}
