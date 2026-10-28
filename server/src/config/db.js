import pg from 'pg';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL?.trim() || '';
const hasPostgresUrl = /^postgres(?:ql)?:\/\//i.test(databaseUrl);
const registrationTables = ['users', 'player_profiles', 'pending_registrations', 'sessions', 'admin_notifications'];


const ca = process.env.SUPABASE_DB_CA
  ?.replace(/\\n/g, '\n')
  .trim();

export const pool = hasPostgresUrl
  ? new Pool({
      connectionString: databaseUrl,
      ssl:
        process.env.NODE_ENV === 'production'
          ? {
              rejectUnauthorized: true,
              ca,
            }
          : undefined,
      max: 12,
      connectionTimeoutMillis: 10000,
    })
  : null;


function explainConnectionError(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || '').toLowerCase();

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'The database hostname could not be resolved. Check the host in DATABASE_URL and your network connection.';
  if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT') return 'The PostgreSQL server could not be reached. Check the host, port, Supabase project status, network allowlist, and internet connection.';
  if (code === '28P01' || message.includes('password authentication failed')) return 'PostgreSQL rejected the database username or password. Copy the current database credentials from Supabase.';
  if (code === '3D000') return 'The database name in DATABASE_URL does not exist. Use the database name shown in the Supabase connection details.';
  if (message.includes('ssl') || message.includes('tls') || message.includes('certificate')) return 'The TLS/SSL connection failed. Check the Supabase connection mode and SSL settings.';
  return `PostgreSQL did not respond successfully${code ? ` (${code})` : ''}. Check the Supabase connection string, credentials, network access, and SSL settings.`;
}

export async function checkDatabaseConnection() {
  if (!databaseUrl) {
    return { connected: false, reason: 'DATABASE_URL is missing or blank. Add the Supabase PostgreSQL connection string to the server environment.' };
  }
  if (!hasPostgresUrl) {
    return { connected: false, reason: 'DATABASE_URL is not a PostgreSQL connection string. Use the URI beginning with postgres:// or postgresql:// from Supabase → Connect → URI; the https:// project URL is not a database connection string.' };
  }

  try {
    await pool.query('select 1');
    const result = await pool.query(
      `select table_name from information_schema.tables
       where table_schema='public' and table_name=any($1::text[])`,
      [registrationTables],
    );
    const present = new Set(result.rows.map((row) => row.table_name));
    const missing = registrationTables.filter((table) => !present.has(table));
    return {
      connected: true,
      schemaReady: missing.length === 0,
      reason: missing.length
        ? `PostgreSQL is reachable, but required registration tables are missing: ${missing.join(', ')}. Apply database/migrations/001_initial.sql.`
        : '',
    };
  } catch (error) {
  console.error('[database] Connection failure:', {
    name: error?.name,
    code: error?.code,
    message: error?.message,
    causeCode: error?.cause?.code,
    causeMessage: error?.cause?.message,
  });

  return {
    connected: false,
    reason: explainConnectionError(error),
  };
}
}

export async function query(text, values = []) {
  if (!pool) {
    const error = new Error('Database is not configured. Set DATABASE_URL to the Supabase PostgreSQL connection string.');
    error.status = 503;
    error.code = 'DATABASE_NOT_CONFIGURED';
    throw error;
  }
  return pool.query(text, values);
}

export async function withTransaction(work) {
  if (!pool) {
    const error = new Error('Database is not configured. Set DATABASE_URL to the Supabase PostgreSQL connection string.');
    error.status = 503;
    error.code = 'DATABASE_NOT_CONFIGURED';
    throw error;
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
