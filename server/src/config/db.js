import pg from 'pg';

const { Pool } = pg;

const databaseUrl = process.env.DATABASE_URL?.trim() || '';
const hasPostgresUrl = /^postgres(?:ql)?:\/\//i.test(databaseUrl);

const registrationTables = [
  'users',
  'player_profiles',
  'pending_registrations',
  'sessions',
  'admin_notifications',
];
const requiredColumns = ['tournaments.priority_level'];

// Load the certificate from the server environment.

const rawCa = process.env.SUPABASE_DB_CA?.trim() || '';

let ca = '';

if (rawCa) {
  const decodedCa = rawCa.includes('-----BEGIN CERTIFICATE-----')
    ? rawCa.replace(/\\n/g, '\n')
    : Buffer.from(rawCa, 'base64').toString('utf8').trim();

  if (
    decodedCa.includes('-----BEGIN CERTIFICATE-----') &&
    decodedCa.includes('-----END CERTIFICATE-----')
  ) {
    ca = decodedCa;
  }
}


// Check the URL without printing credentials.
const urlHasSslParameters =
  /[?&](sslmode|sslrootcert|sslcert|sslkey)=/i.test(databaseUrl);

console.log('[database SSL diagnostic]', {
  nodeEnv: process.env.NODE_ENV,
  certificateLoaded: Boolean(
    ca?.includes('-----BEGIN CERTIFICATE-----') &&
    ca?.includes('-----END CERTIFICATE-----')
  ),
  certificateLength: ca?.length ?? 0,
  urlHasSslParameters,
});

// Avoid conflicting SSL settings in the connection URL and pg options.
function removeSslUrlParameters(value) {
  const url = new URL(value);

  for (const key of [
    'sslmode',
    'sslrootcert',
    'sslcert',
    'sslkey',
  ]) {
    url.searchParams.delete(key);
  }

  return url.toString();
}

const connectionString = hasPostgresUrl
  ? removeSslUrlParameters(databaseUrl)
  : '';

if (process.env.NODE_ENV === 'production' && !ca) {
  console.error(
    '[database] SUPABASE_DB_CA is missing or is not a PEM certificate.'
  );
}

export const pool = hasPostgresUrl
  ? new Pool({
      connectionString,
      ssl:
        process.env.NODE_ENV === 'production'
          ? {
              rejectUnauthorized: true,
              ...(ca ? { ca } : {}),
            }
          : undefined,
      max: 12,
      connectionTimeoutMillis: 10000,
    })
  : null;

function explainConnectionError(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || '').toLowerCase();

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return 'The database hostname could not be resolved. Check DATABASE_URL.';
  }

  if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT') {
    return 'The database could not be reached. Check the host, port and Supabase status.';
  }

  if (code === '28P01' || message.includes('password authentication failed')) {
    return 'PostgreSQL rejected the database username or password.';
  }

  if (code === '3D000') {
    return 'The configured PostgreSQL database does not exist.';
  }

  if (
    message.includes('ssl') ||
    message.includes('tls') ||
    message.includes('certificate')
  ) {
    return 'The TLS/SSL connection failed. Check the certificate and SSL configuration.';
  }

  return `PostgreSQL connection failed${code ? ` (${code})` : ''}.`;
}

export async function checkDatabaseConnection() {
  if (!databaseUrl) {
    return {
      connected: false,
      reason: 'DATABASE_URL is missing.',
    };
  }

  if (!hasPostgresUrl) {
    return {
      connected: false,
      reason: 'DATABASE_URL must be a PostgreSQL connection string.',
    };
  }

  if (!pool) {
    return {
      connected: false,
      reason: 'The PostgreSQL connection pool was not created.',
    };
  }

  try {
    await pool.query('SELECT 1');

    const result = await pool.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
       AND table_name = ANY($1::text[])`,
      [registrationTables],
    );

    const present = new Set(
      result.rows.map((row) => row.table_name),
    );

    const missing = registrationTables.filter(
      (table) => !present.has(table),
    );

    const columnResult = await pool.query(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
       AND (table_name, column_name) IN (
         SELECT split_part(required_column, '.', 1), split_part(required_column, '.', 2)
         FROM unnest($1::text[]) AS required_column
       )`,
      [requiredColumns],
    );
    const presentColumns = new Set(
      columnResult.rows.map(({ table_name, column_name }) => `${table_name}.${column_name}`),
    );
    const missingColumns = requiredColumns.filter((column) => !presentColumns.has(column));
    const missingDetails = [
      ...(missing.length ? [`tables: ${missing.join(', ')}`] : []),
      ...(missingColumns.length ? [`columns: ${missingColumns.join(', ')}`] : []),
    ];

    return {
      connected: true,
      schemaReady: missingDetails.length === 0,
      reason: missingDetails.length
        ? `Missing application schema ${missingDetails.join('; ')}. Apply the corresponding database migrations.`
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
    const error = new Error(
      'Database is not configured. Set DATABASE_URL.',
    );
    error.status = 503;
    error.code = 'DATABASE_NOT_CONFIGURED';
    throw error;
  }

  return pool.query(text, values);
}

export async function withTransaction(work) {
  if (!pool) {
    const error = new Error(
      'Database is not configured. Set DATABASE_URL.',
    );
    error.status = 503;
    error.code = 'DATABASE_NOT_CONFIGURED';
    throw error;
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original error.
    }
    throw error;
  } finally {
    client.release();
  }
}
