
async function sendEmail(to, subject, text) {
  const endpoint = process.env.GMAIL_SCRIPT_URL;
  const secret = process.env.EMAIL_WEBHOOK_SECRET;

  if (!endpoint || !secret) {
    const error = new Error(
      "Google Apps Script email service is not configured."
    );
    error.status = 503;
    error.code = "EMAIL_NOT_CONFIGURED";
    throw error;
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        secret,
        to,
        subject,
        text,
        fromName:
          process.env.SMTP_FROM_NAME || "Ocean Edge Games",
      }),
      signal: AbortSignal.timeout(30000),
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok || result.ok !== true) {
      throw new Error(
        result.error ||
          `Email service returned HTTP ${response.status}`
      );
    }
  } catch (cause) {
    const error = new Error("Email delivery failed.");
    error.status = 503;
    error.code = "EMAIL_DELIVERY_FAILED";
    error.cause = cause;
    throw error;
  }
}

export async function sendCode(
  to,
  code,
  purpose = "verify your email"
) {
  await sendEmail(
    to,
    `Ocean Edge Games — ${purpose}`,
    `Your Ocean Edge Games code is ${code}. It expires in 10 minutes. If you did not request this, you can ignore this email.`
  );
}

export async function sendRecoveryLink(to, token) {
  const frontendUrl = (
    process.env.CLIENT_URL ||
    "http://localhost:5175"
  ).replace(/\/+$/, "");

  const url = new URL("/reset-password", frontendUrl);
  url.searchParams.set("token", token);

  await sendEmail(
    to,
    "Ocean Edge Games — password reset",
    `Use this one-time link to reset your password. It expires in 30 minutes: ${url.toString()}\nIf you did not request this, ignore this email.`
  );
}
