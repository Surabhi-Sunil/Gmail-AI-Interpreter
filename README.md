# nbox Intelligence

A full-stack web app for connecting Gmail, syncing recent emails, and extracting actionable tasks.

## Features

- Google OAuth sign-in with Gmail access
- Fetch recent Gmail messages
- Extract task-like items from email content
- Dashboard grouped by urgency / due date

## Local setup

1. Copy the example env file:
   ```bash
   cp server/.env.example server/.env
   ```
2. Create Google OAuth credentials and enable Gmail API.
3. Fill in `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SERVER_ROOT_URL`, `CLIENT_ROOT_URL`, and `SESSION_SECRET`.
4. Install dependencies:
   ```bash
   npm install
   ```
5. Run locally:
   ```bash
   npm run dev
   ```

## Development ports

- Backend: `http://localhost:4000`
- Frontend: `http://localhost:5173`
