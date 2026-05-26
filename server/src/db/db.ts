import { Pool } from 'pg';
import type { EmailInsight, EmailSummary, TaskItem } from '../gmail';

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

      CREATE TABLE IF NOT EXISTS email_insights (
        id SERIAL PRIMARY KEY,
        email_id INTEGER UNIQUE REFERENCES emails(id) ON DELETE CASCADE,
        category VARCHAR(50) NOT NULL,
        urgency VARCHAR(20) NOT NULL,
        summary TEXT NOT NULL,
        suggested_action TEXT NOT NULL,
        reason TEXT NOT NULL,
        status VARCHAR(20) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS email_tasks (
        id SERIAL PRIMARY KEY,
        email_id INTEGER REFERENCES emails(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        source TEXT NOT NULL,
        due_date DATE NOT NULL,
        priority VARCHAR(20) NOT NULL,
        status VARCHAR(20) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE email_insights
      ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active';

      ALTER TABLE email_tasks
      ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active';

      ALTER TABLE email_tasks
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

      CREATE TABLE IF NOT EXISTS custom_tasks (
        id SERIAL PRIMARY KEY,
        user_email VARCHAR(255) NOT NULL,
        title TEXT NOT NULL,
        priority VARCHAR(20) NOT NULL DEFAULT 'Medium',
        due_date DATE NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

export const getExistingMessageIds = async (messageIds: string[]) => {
  if (messageIds.length === 0) {
    return new Set<string>();
  }

  const result = await getPool().query(
    'SELECT message_id FROM emails WHERE message_id = ANY($1)',
    [messageIds]
  );

  return new Set<string>(result.rows.map(row => row.message_id));
};

const mapEmailRow = (row: any): EmailSummary => ({
  id: row.message_id,
  threadId: row.gmail_thread_id,
  subject: row.subject,
  from: row.from_email,
  date: row.date instanceof Date ? row.date.toISOString() : String(row.date),
  snippet: row.snippet || '',
  body: row.body || undefined
});

export const saveEmailTriage = async (triage: { insights: EmailInsight[]; tasks: TaskItem[] }) => {
  const client = await getPool().connect();

  try {
    await client.query('BEGIN');

    for (const insight of triage.insights) {
      await client.query(`
        INSERT INTO email_insights (email_id, category, urgency, summary, suggested_action, reason, updated_at)
        SELECT id, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP
        FROM emails
        WHERE message_id = $1
        ON CONFLICT (email_id) DO UPDATE SET
          category = EXCLUDED.category,
          urgency = EXCLUDED.urgency,
          summary = EXCLUDED.summary,
          suggested_action = EXCLUDED.suggested_action,
          reason = EXCLUDED.reason,
          updated_at = CURRENT_TIMESTAMP
      `, [
        insight.email.id,
        insight.category,
        insight.urgency,
        insight.summary,
        insight.suggestedAction,
        insight.reason
      ]);
    }

    const taskMessageIds = [...new Set(triage.tasks.map(task => task.email.id))];
    if (taskMessageIds.length > 0) {
      await client.query(`
        DELETE FROM email_tasks
        WHERE email_id IN (
          SELECT id FROM emails WHERE message_id = ANY($1)
        )
      `, [taskMessageIds]);
    }

    for (const task of triage.tasks) {
      await client.query(`
        INSERT INTO email_tasks (email_id, title, source, due_date, priority)
        SELECT id, $2, $3, $4, $5
        FROM emails
        WHERE message_id = $1
      `, [
        task.email.id,
        task.title,
        task.source,
        task.dueDate,
        task.priority
      ]);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export const getUntriagedEmails = async (limit = 50): Promise<EmailSummary[]> => {
  const result = await getPool().query(`
    SELECT e.*, et.thread_id as gmail_thread_id
    FROM emails e
    JOIN email_threads et ON e.thread_id = et.id
    LEFT JOIN email_insights ei ON ei.email_id = e.id
    WHERE ei.id IS NULL
    ORDER BY e.date DESC
    LIMIT $1
  `, [limit]);

  return result.rows.map(mapEmailRow);
};

export const getUntriagedEmailsByMessageIds = async (messageIds: string[]): Promise<EmailSummary[]> => {
  if (messageIds.length === 0) {
    return [];
  }

  const result = await getPool().query(`
    SELECT e.*, et.thread_id as gmail_thread_id
    FROM emails e
    JOIN email_threads et ON e.thread_id = et.id
    LEFT JOIN email_insights ei ON ei.email_id = e.id
    WHERE ei.id IS NULL
      AND e.message_id = ANY($1)
    ORDER BY e.date DESC
  `, [messageIds]);

  return result.rows.map(mapEmailRow);
};

export const getEmailsByMessageIds = async (messageIds: string[]): Promise<EmailSummary[]> => {
  if (messageIds.length === 0) {
    return [];
  }

  const result = await getPool().query(`
    SELECT e.*, et.thread_id as gmail_thread_id
    FROM emails e
    JOIN email_threads et ON e.thread_id = et.id
    WHERE e.message_id = ANY($1)
    ORDER BY e.date DESC
  `, [messageIds]);

  return result.rows.map(mapEmailRow);
};

export const getStoredTriage = async (limit = 100): Promise<{ insights: EmailInsight[]; tasks: TaskItem[] }> => {
  const insightResult = await getPool().query(`
    SELECT
      ei.category,
      ei.urgency,
      ei.summary,
      ei.suggested_action,
      ei.reason,
      ei.status,
      e.*,
      et.thread_id as gmail_thread_id
    FROM email_insights ei
    JOIN emails e ON ei.email_id = e.id
    JOIN email_threads et ON e.thread_id = et.id
    WHERE COALESCE(ei.status, 'active') = 'active'
    ORDER BY
      CASE ei.urgency WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END,
      e.date DESC
    LIMIT $1
  `, [limit]);

  const taskResult = await getPool().query(`
    SELECT
      t.title,
      t.source,
      t.due_date,
      t.priority,
      e.*,
      et.thread_id as gmail_thread_id
    FROM email_tasks t
    JOIN emails e ON t.email_id = e.id
    JOIN email_threads et ON e.thread_id = et.id
    JOIN email_insights ei ON ei.email_id = e.id
    WHERE COALESCE(ei.status, 'active') = 'active'
    ORDER BY t.due_date ASC, e.date DESC
    LIMIT $1
  `, [limit]);

  return {
    insights: insightResult.rows.map(row => ({
      category: row.category,
      urgency: row.urgency,
      summary: row.summary,
      suggestedAction: row.suggested_action,
      reason: row.reason,
      status: row.status || 'active',
      email: mapEmailRow(row)
    })),
    tasks: taskResult.rows.map(row => ({
      title: row.title,
      source: row.source,
      dueDate: row.due_date instanceof Date ? row.due_date.toISOString().split('T')[0] : String(row.due_date),
      priority: row.priority,
      email: mapEmailRow(row)
    }))
  };
};

export const getTaskInsights = async (limit = 100): Promise<EmailInsight[]> => {
  const result = await getPool().query(`
    SELECT
      ei.category,
      ei.urgency,
      ei.summary,
      ei.suggested_action,
      ei.reason,
      ei.status,
      e.*,
      et.thread_id as gmail_thread_id
    FROM email_insights ei
    JOIN emails e ON ei.email_id = e.id
    JOIN email_threads et ON e.thread_id = et.id
    WHERE ei.category = 'Task'
      AND COALESCE(ei.status, 'active') IN ('active', 'done', 'ignored')
    ORDER BY
      CASE COALESCE(ei.status, 'active') WHEN 'active' THEN 0 WHEN 'done' THEN 1 ELSE 2 END,
      CASE ei.urgency WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END,
      e.date DESC
    LIMIT $1
  `, [limit]);

  return result.rows.map(row => ({
    category: row.category,
    urgency: row.urgency,
    summary: row.summary,
    suggestedAction: row.suggested_action,
    reason: row.reason,
    status: row.status || 'active',
    email: mapEmailRow(row)
  }));
};

export const updateEmailInsightStatus = async (messageId: string, status: 'active' | 'done' | 'ignored') => {
  const result = await getPool().query(`
    UPDATE email_insights
    SET status = $2,
        updated_at = CURRENT_TIMESTAMP
    WHERE email_id = (
      SELECT id FROM emails WHERE message_id = $1
    )
    RETURNING id
  `, [messageId, status]);

  return (result.rowCount || 0) > 0;
};

export type Task = {
  id: number;
  title: string;
  source: string;
  dueDate: string;
  priority: 'High' | 'Medium' | 'Low';
  status: 'active' | 'done';
  emailSubject: string;
  emailId: string;
};

export const getActiveTasks = async (limit = 50): Promise<Task[]> => {
  const result = await getPool().query(`
    SELECT
      t.id,
      t.title,
      t.source,
      t.due_date,
      t.priority,
      t.status,
      e.subject as email_subject,
      e.message_id as email_id
    FROM email_tasks t
    JOIN emails e ON t.email_id = e.id
    WHERE COALESCE(t.status, 'active') = 'active'
    ORDER BY
      CASE t.priority WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END,
      t.due_date ASC,
      e.date DESC
    LIMIT $1
  `, [limit]);

  return result.rows.map(row => ({
    id: row.id,
    title: row.title,
    source: row.source,
    dueDate: row.due_date instanceof Date ? row.due_date.toISOString().split('T')[0] : String(row.due_date),
    priority: row.priority,
    status: row.status || 'active',
    emailSubject: row.email_subject,
    emailId: row.email_id
  }));
};

export const markTaskAsDone = async (taskId: number): Promise<boolean> => {
  const result = await getPool().query(`
    UPDATE email_tasks
    SET status = 'done',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = $1
    RETURNING id
  `, [taskId]);

  return (result.rowCount || 0) > 0;
};

export const updateEmailTaskStatus = async (taskId: number, status: 'active' | 'done'): Promise<boolean> => {
  const result = await getPool().query(`
    UPDATE email_tasks
    SET status = $2,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = $1
    RETURNING id
  `, [taskId, status]);

  return (result.rowCount || 0) > 0;
};

export const getAllTasks = async (limit = 50): Promise<Task[]> => {
  const result = await getPool().query(`
    SELECT
      t.id,
      t.title,
      t.source,
      t.due_date,
      t.priority,
      t.status,
      e.subject as email_subject,
      e.message_id as email_id
    FROM email_tasks t
    JOIN emails e ON t.email_id = e.id
    ORDER BY
      CASE t.status WHEN 'done' THEN 1 ELSE 0 END,
      CASE t.priority WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END,
      t.due_date ASC,
      e.date DESC
    LIMIT $1
  `, [limit]);

  return result.rows.map(row => ({
    id: row.id,
    title: row.title,
    source: row.source,
    dueDate: row.due_date instanceof Date ? row.due_date.toISOString().split('T')[0] : String(row.due_date),
    priority: row.priority,
    status: row.status || 'active',
    emailSubject: row.email_subject,
    emailId: row.email_id
  }));
};

export type CustomTask = {
  id: number;
  title: string;
  priority: 'High' | 'Medium' | 'Low';
  dueDate: string;
  status: 'active' | 'done';
  isCustom: true;
};

export const createCustomTask = async (
  userEmail: string,
  title: string,
  priority: 'High' | 'Medium' | 'Low',
  dueDate: string
): Promise<CustomTask> => {
  const result = await getPool().query(`
    INSERT INTO custom_tasks (user_email, title, priority, due_date, status)
    VALUES ($1, $2, $3, $4, 'active')
    RETURNING id, title, priority, due_date, status
  `, [userEmail, title, priority, dueDate]);

  const row = result.rows[0];
  return {
    id: row.id,
    title: row.title,
    priority: row.priority,
    dueDate: row.due_date instanceof Date ? row.due_date.toISOString().split('T')[0] : String(row.due_date),
    status: row.status,
    isCustom: true
  };
};

export const getCustomTasks = async (userEmail: string, includeDone = false): Promise<CustomTask[]> => {
  const result = await getPool().query(`
    SELECT id, title, priority, due_date, status
    FROM custom_tasks
    WHERE user_email = $1
      AND ($2::boolean OR status = 'active')
    ORDER BY
      CASE status WHEN 'active' THEN 0 ELSE 1 END,
      CASE priority WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END,
      due_date ASC
  `, [userEmail, includeDone]);

  return result.rows.map(row => ({
    id: row.id,
    title: row.title,
    priority: row.priority,
    dueDate: row.due_date instanceof Date ? row.due_date.toISOString().split('T')[0] : String(row.due_date),
    status: row.status,
    isCustom: true
  }));
};

export const updateCustomTask = async (
  taskId: number,
  title?: string,
  priority?: string,
  dueDate?: string
): Promise<CustomTask | null> => {
  const updates: string[] = [];
  const values: any[] = [];
  let paramCount = 1;

  if (title !== undefined) {
    updates.push(`title = $${paramCount++}`);
    values.push(title);
  }
  if (priority !== undefined) {
    updates.push(`priority = $${paramCount++}`);
    values.push(priority);
  }
  if (dueDate !== undefined) {
    updates.push(`due_date = $${paramCount++}`);
    values.push(dueDate);
  }

  if (updates.length === 0) return null;

  updates.push(`updated_at = CURRENT_TIMESTAMP`);
  values.push(taskId);

  const result = await getPool().query(`
    UPDATE custom_tasks
    SET ${updates.join(', ')}
    WHERE id = $${paramCount}
    RETURNING id, title, priority, due_date, status
  `, values);

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    id: row.id,
    title: row.title,
    priority: row.priority,
    dueDate: row.due_date instanceof Date ? row.due_date.toISOString().split('T')[0] : String(row.due_date),
    status: row.status,
    isCustom: true
  };
};

export const markCustomTaskDone = async (taskId: number): Promise<boolean> => {
  const result = await getPool().query(`
    UPDATE custom_tasks
    SET status = 'done',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = $1
    RETURNING id
  `, [taskId]);

  return (result.rowCount || 0) > 0;
};

export const updateCustomTaskStatus = async (taskId: number, status: 'active' | 'done'): Promise<CustomTask | null> => {
  const result = await getPool().query(`
    UPDATE custom_tasks
    SET status = $2,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = $1
    RETURNING id, title, priority, due_date, status
  `, [taskId, status]);

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    id: row.id,
    title: row.title,
    priority: row.priority,
    dueDate: row.due_date instanceof Date ? row.due_date.toISOString().split('T')[0] : String(row.due_date),
    status: row.status,
    isCustom: true
  };
};

export const deleteCustomTask = async (taskId: number): Promise<boolean> => {
  const result = await getPool().query(`
    DELETE FROM custom_tasks
    WHERE id = $1
  `, [taskId]);

  return (result.rowCount || 0) > 0;
};
