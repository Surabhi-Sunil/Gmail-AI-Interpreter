# nbox Intelligence

A full-stack web app for connecting Gmail, syncing recent emails, and extracting actionable tasks.

## Features

- Google OAuth sign-in with Gmail access
- Fetch recent Gmail messages
- Extract task-like items from email content
- Dashboard grouped by urgency / due date
- PostgreSQL database on Supabase

## Local setup

1. Create a Supabase project at https://supabase.com
2. Copy the database connection string from your Supabase project settings
3. Copy the example env file:
   ```bash
   cp server/.env.example server/.env
   ```
4. Create Google OAuth credentials and enable Gmail API.
5. Fill in the environment variables:
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
   - `SERVER_ROOT_URL=http://localhost:4001`
   - `CLIENT_ROOT_URL=http://localhost:5173`
   - `SESSION_SECRET` (any random string)
   - `DATABASE_URL` (from Supabase)
   - `OLLAMA_BASE_URL` (optional, defaults to `http://localhost:11434`)
   - `OLLAMA_MODEL` (optional, defaults to `qwen2.5:7b`)
   - `GMAIL_QUERY` (optional, defaults to unread inbox mail from the last 90 days)
   - `GMAIL_SYNC_LIMIT` (optional, defaults to `20`)
   - `GMAIL_SYNC_CONCURRENCY` (optional, defaults to `8`)
   - `TASK_EXTRACTION_CHUNK_SIZE` (optional, defaults to `3`)
   - `MAX_EMAIL_BODY_CHARS` (optional, defaults to `1200`)
   - `OLLAMA_MAX_TOKENS` (optional, defaults to `4096`)
   - `OLLAMA_AGENT_RETRIES` (optional, defaults to `2`)
   - `OLLAMA_REQUEST_TIMEOUT_MS` (optional, defaults to `120000`)

## Local Ollama setup

Install Ollama and pull the local model:

```bash
ollama pull qwen2.5:7b
```

Then set:

```bash
OLLAMA_MODEL=qwen2.5:7b
```
6. Install dependencies:
   ```bash
   npm install
   ```
7. Run locally:
   ```bash
   npm run dev
   ```

## Development ports

- Backend: `http://localhost:4001`
- Frontend: `http://localhost:5173`
