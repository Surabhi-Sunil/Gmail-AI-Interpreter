import express from 'express';
import cors from 'cors';
import session from 'express-session';
import dotenv from 'dotenv';
import { getAuthUrl, exchangeCodeForTokens } from './googleAuth';
import { fetchRecentEmails, buildTaskList } from './gmail';

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 4001);
const clientRoot = process.env.CLIENT_ROOT_URL || 'http://localhost:5173';

app.use(cors({
  origin: clientRoot,
  credentials: true
}));
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'default-session-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
  })
);

app.get('/api/auth/url', (_req, res) => {
  try {
    const url = getAuthUrl();
    res.json({ url });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unable to generate auth URL' });
  }
});

app.get('/api/auth/callback', async (req, res) => {
  const code = req.query.code as string | undefined;
  if (!code) {
    return res.status(400).send('Missing authorization code.');
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    req.session.tokens = tokens;
    return res.redirect(`${clientRoot}/auth-success?connected=1`);
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Google token exchange failed' });
  }
});

app.get('/api/auth/status', (req, res) => {
  const isConnected = Boolean(req.session.tokens);
  res.json({ connected: isConnected });
});

app.get('/api/tasks', async (req, res) => {
  if (!req.session.tokens) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const emails = await fetchRecentEmails(req.session.tokens);
    console.log(`Fetched ${emails.length} emails for task extraction.`);
    const tasks = buildTaskList(emails);
    res.json({ tasks });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unable to build task list' });
  }
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
