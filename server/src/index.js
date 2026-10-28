import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDirectory = dirname(fileURLToPath(import.meta.url));
// Load the documented project-root .env, then use server/.env for any missing keys.
dotenv.config({ path: resolve(serverDirectory, '../../.env') });
dotenv.config({ path: resolve(serverDirectory, '../.env') });

const [{ app }, { bootstrapAdmin }, { checkDatabaseConnection, pool }] = await Promise.all([
  import('./app.js'),
  import('./services/bootstrap.js'),
  import('./config/db.js'),
]);

const port = Number(process.env.PORT || 5000);
const databaseStatus = await checkDatabaseConnection();
if (databaseStatus.connected) {
  console.info('[database] CONNECTED — PostgreSQL responded to SELECT 1.');
  if (!databaseStatus.schemaReady) {
    console.error(`[database] SCHEMA NOT READY — ${databaseStatus.reason}`);
  } else {
    try { await bootstrapAdmin(); }
    catch (error) { console.error(`[setup] Admin bootstrap did not complete: ${error.message}`); }
  }
} else {
  console.error(`[database] NOT CONNECTED — ${databaseStatus.reason}`);
}
if (!process.env.OEG_OTP_PEPPER) {
  console.error('[setup] OEG_OTP_PEPPER is missing; registration email verification and password recovery are disabled.');
}
if (!process.env.SMTP_USER || !process.env.SMTP_APP_PASSWORD) {
  console.error('[setup] SMTP_USER and SMTP_APP_PASSWORD are required to send registration and recovery emails.');
}
app.listen(port, () => console.info(`[api] Ocean Edge Games listening on port ${port}.`));

process.on('SIGTERM', async () => { await pool?.end(); process.exit(0); });
