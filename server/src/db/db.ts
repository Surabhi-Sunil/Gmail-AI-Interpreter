import { Pool } from 'pg';

let pool: Pool | null = null;

type GmailTokens = {
  access_token?: string | null;
  refresh_token?: string | null;
  expiry_date?: number | null;
};

type EmailInsertData = {
  subject: string;
  from: string;
  to: string;
  date: string;
  snippet: string;
  body: string;
};

export const initializeDatabase = async () => {
  if (pool) return;

  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required for Supabase connection');
  }

  pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false } // Required for Supabase
  });

  try {
    await pool.query('SELECT 1');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255),
        email VARCHAR(255) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS gmail_accounts (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        gmail_email VARCHAR(255) UNIQUE NOT NULL,
        access_token TEXT,
        refresh_token TEXT,
        expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS email_threads (
        id SERIAL PRIMARY KEY,
        thread_id VARCHAR(255) UNIQUE NOT NULL,
        subject TEXT,
        snippet TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS emails (
        id SERIAL PRIMARY KEY,
        thread_id INTEGER REFERENCES email_threads(id),
        message_id VARCHAR(255) UNIQUE NOT NULL,
        subject TEXT,
        from_email VARCHAR(255),
        to_email VARCHAR(255),
        date TIMESTAMP,
        snippet TEXT,
        body TEXT,
        processing_status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Database initialization failed:', error);
    throw error;
  }
};

export function getPool() {
  if (!pool) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return pool;
}

export const getUserByEmail = async (email: string) => {
  const result = await getPool().query('SELECT * FROM users WHERE email = $1', [email]);
  return result.rows[0];
};

export const createUser = async (name: string, email: string) => {
  const result = await getPool().query('INSERT INTO users (name, email) VALUES ($1, $2) RETURNING *', [name, email]);
  return result.rows[0];
};

export const upsertGmailAccount = async (userId: number, gmailEmail: string, tokens: GmailTokens) => {
  const expiresAt = tokens.expiry_date ? new Date(tokens.expiry_date) : null;

  const result = await getPool().query(`
    INSERT INTO gmail_accounts (user_id, gmail_email, access_token, refresh_token, expires_at)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (gmail_email) DO UPDATE SET
      user_id = EXCLUDED.user_id,
      access_token = EXCLUDED.access_token,
      refresh_token = EXCLUDED.refresh_token,
      expires_at = EXCLUDED.expires_at
    RETURNING *
  `, [userId, gmailEmail, tokens.access_token, tokens.refresh_token, expiresAt]);
  return result.rows[0];
};

export const getOrCreateThread = async (threadId: string, subject?: string, snippet?: string) => {
  let result = await getPool().query('SELECT id FROM email_threads WHERE thread_id = $1', [threadId]);
  if (result.rows.length > 0) {
    return result.rows[0].id;
  }

  result = await getPool().query('INSERT INTO email_threads (thread_id, subject, snippet) VALUES ($1, $2, $3) RETURNING id', [threadId, subject, snippet]);
  return result.rows[0].id;
};

export const insertEmail = async (threadId: number, messageId: string, emailData: EmailInsertData) => {
  try {
    const result = await getPool().query(`
      INSERT INTO emails (thread_id, message_id, subject, from_email, to_email, date, snippet, body)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (message_id) DO NOTHING
      RETURNING id
    `, [threadId, messageId, emailData.subject, emailData.from, emailData.to, emailData.date, emailData.snippet, emailData.body]);
    return { changes: result.rowCount };
  } catch (error) {
    return { changes: 0 };
  }
};
