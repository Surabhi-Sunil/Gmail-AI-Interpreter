import express from 'express';
import cors from 'cors';
import session from 'express-session';
import dotenv from 'dotenv';
import { getAuthUrl, exchangeCodeForTokens, getUserInfo } from './googleAuth';
import { fetchRecentEmails } from './gmail';
import { canUseTaskExtraction, extractTasksWithOpenRouter } from './taskExtraction';
import {
  initializeDatabase,
  getUserByEmail,
  createUser,
  upsertGmailAccount
} from './db/db';

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 4001);
const clientRoot = process.env.CLIENT_ROOT_URL || 'http://localhost:5173';

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || origin.startsWith('http://localhost:517')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));
app.use(express.json());
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'default-session-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
  })
);

initializeDatabase().catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

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
    const profile = await getUserInfo(tokens);

    if (!profile.email) {
      throw new Error('Unable to retrieve email address from Google profile.');
    }

    let user = await getUserByEmail(profile.email);
    if (!user) {
      user = await createUser(profile.name || 'Unknown User', profile.email);
    }

    await upsertGmailAccount(user.id, profile.email, tokens);

    req.session.user = {
      id: user.id,
      name: user.name,
      email: user.email
    };
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

  if (!canUseTaskExtraction()) {
    return res.status(500).json({ error: 'OPENROUTER_API_KEY is not configured on the server.' });
  }

  try {
    const syncStartedAt = Date.now();
    const emails = await fetchRecentEmails(req.session.tokens);
    const fetchMs = Date.now() - syncStartedAt;
    console.log(`Fetched and stored ${emails.length} emails in ${fetchMs}ms.`);

    const extractionStartedAt = Date.now();
    const tasks = await extractTasksWithOpenRouter(emails);
    const extractionMs = Date.now() - extractionStartedAt;
    console.log(`Extracted ${tasks.length} tasks from ${emails.length} emails in ${extractionMs}ms.`);

    res.json({ tasks });
  } catch (error) {
    console.error('Error in /api/tasks:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unable to build task list' });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
