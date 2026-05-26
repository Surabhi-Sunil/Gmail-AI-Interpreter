import express from 'express';
import cors from 'cors';
import session from 'express-session';
import dotenv from 'dotenv';
import { getAuthUrl, exchangeCodeForTokens, getUserInfo } from './googleAuth';
import { fetchRecentEmails, markEmailsAsRead, applyLabelToEmails, archiveEmails } from './gmail';
import { assertTaskExtractionReady, canUseTaskExtraction, extractEmailTriageWithOllama } from './taskExtraction';
import {
  initializeDatabase,
  getStoredTriage,
  getEmailsByMessageIds,
  getTaskInsights,
  getUntriagedEmailsByMessageIds,
  getUserByEmail,
  createUser,
  saveEmailTriage,
  updateEmailInsightStatus,
  upsertGmailAccount,
  getActiveTasks,
  getAllTasks,
  markTaskAsDone,
  updateEmailTaskStatus,
  createCustomTask,
  getCustomTasks,
  updateCustomTask,
  markCustomTaskDone,
  updateCustomTaskStatus,
  deleteCustomTask
} from './db/db';

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 4001);
const clientRoot = process.env.CLIENT_ROOT_URL || 'http://localhost:5173';

// Increase timeouts for long-running operations
app.use((req, res, next) => {
  res.setTimeout(300000, () => {
    res.status(408).json({ error: 'Request timeout after 5 minutes' });
  });
  next();
});

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
    req.session.user.email = profile.email;

    return res.redirect(`${clientRoot}/auth-success?connected=1`);
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Google token exchange failed' });
  }
});

app.get('/api/auth/status', (req, res) => {
  const isConnected = Boolean(req.session.tokens);
  res.json({ connected: isConnected });
});

app.get('/api/dashboard', async (req, res) => {
  if (!req.session.tokens) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const dashboard = await getStoredTriage();
    const activeTasks = await getActiveTasks(50);
    const taskInsights = await getTaskInsights();
    const allTasks = await getAllTasks(100);

    res.json({
      tasks: activeTasks,
      allTasks,
      insights: dashboard.insights,
      taskInsights,
      stats: {
        listedEmails: 0,
        syncedEmails: 0,
        skippedExisting: 0,
        tasks: activeTasks.length,
        insights: dashboard.insights.length,
        fetchMs: 0,
        extractionMs: 0
      }
    });
  } catch (error) {
    console.error('Error in /api/dashboard:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unable to load dashboard' });
  }
});

app.get('/api/tasks', async (req, res) => {
  if (!req.session.tokens) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  if (!canUseTaskExtraction()) {
    return res.status(500).json({ error: 'Ollama task extraction is not available on the server.' });
  }

  try {
    await assertTaskExtractionReady();

    const syncStartedAt = Date.now();
    const sync = await fetchRecentEmails(req.session.tokens);
    const fetchMs = Date.now() - syncStartedAt;
    console.log(`Listed ${sync.listed} emails, skipped ${sync.skippedExisting} existing, fetched ${sync.emails.length} new in ${fetchMs}ms.`);

    const newEmailIds = new Set(sync.emails.map(email => email.id));
    const existingListedEmails = await getEmailsByMessageIds(
      sync.listedMessageIds.filter(messageId => !newEmailIds.has(messageId))
    );
    const untriagedEmails = await getUntriagedEmailsByMessageIds(sync.listedMessageIds);
    const emailsToTriage = [
      ...sync.emails,
      ...untriagedEmails.filter(email => !newEmailIds.has(email.id))
    ];
    console.log(`Queued ${emailsToTriage.length} unread emails for triage: ${sync.emails.length} new, ${emailsToTriage.length - sync.emails.length} existing untriaged.`);

    const extractionStartedAt = Date.now();
    const triage = emailsToTriage.length > 0
      ? await extractEmailTriageWithOllama(emailsToTriage)
      : { tasks: [], insights: [] };
    if (triage.insights.length > 0 || triage.tasks.length > 0) {
      await saveEmailTriage(triage);
    }
    const extractionMs = Date.now() - extractionStartedAt;
    console.log(`Extracted ${triage.tasks.length} tasks and ${triage.insights.length} insights from ${emailsToTriage.length} emails in ${extractionMs}ms.`);

    // Now apply Gmail actions based on email categories
    const highPriorityEmails = triage.insights
      .filter(insight => insight.urgency === 'High' && insight.category === 'Needs Reply')
      .map(insight => insight.email.id);
    const newsletterEmails = triage.insights
      .filter(insight => insight.category === 'Newsletter')
      .map(insight => insight.email.id);

    try {
      // Mark all processed emails as read
      await markEmailsAsRead(req.session.tokens, emailsToTriage.map(e => e.id));

      // Label high-priority items
      if (highPriorityEmails.length > 0) {
        await applyLabelToEmails(req.session.tokens, highPriorityEmails, '⚡ High Priority');
      }

      // Archive newsletters
      if (newsletterEmails.length > 0) {
        await archiveEmails(req.session.tokens, newsletterEmails);
      }

      console.log(`Applied Gmail actions: marked ${emailsToTriage.length} as read, labeled ${highPriorityEmails.length} as high-priority, archived ${newsletterEmails.length} newsletters`);
    } catch (error) {
      console.error('Error applying Gmail actions:', error);
      // Don't fail the sync if Gmail actions fail
    }

    const dashboard = await getStoredTriage();
    const activeTasks = await getActiveTasks(50);
    const allTasks = await getAllTasks(100);
    const taskInsights = await getTaskInsights();

    res.json({
      tasks: activeTasks,
      allTasks,
      insights: dashboard.insights,
      taskInsights,
      stats: {
        listedEmails: sync.listed,
        syncedEmails: sync.emails.length,
        skippedExisting: sync.skippedExisting,
        tasks: activeTasks.length,
        insights: dashboard.insights.length,
        fetchMs,
        extractionMs
      },
      emailBuckets: {
        unreadListed: [...sync.emails, ...existingListedEmails],
        alreadySeen: existingListedEmails
      }
    });
  } catch (error) {
    console.error('Error in /api/tasks:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unable to build task list' });
  }
});

app.patch('/api/insights/:messageId/status', async (req, res) => {
  if (!req.session.tokens) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const status = req.body?.status;
  if (status !== 'active' && status !== 'done' && status !== 'ignored') {
    return res.status(400).json({ error: 'Invalid insight status.' });
  }

  try {
    const updated = await updateEmailInsightStatus(req.params.messageId, status);
    if (!updated) {
      return res.status(404).json({ error: 'Insight not found.' });
    }

    const dashboard = await getStoredTriage();
    const activeTasks = await getActiveTasks(50);
    const allTasks = await getAllTasks(100);
    const taskInsights = await getTaskInsights();
    res.json({
      tasks: activeTasks,
      allTasks,
      insights: dashboard.insights,
      taskInsights,
      stats: {
        listedEmails: 0,
        syncedEmails: 0,
        skippedExisting: 0,
        tasks: activeTasks.length,
        insights: dashboard.insights.length,
        fetchMs: 0,
        extractionMs: 0
      }
    });
  } catch (error) {
    console.error('Error in /api/insights/:messageId/status:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unable to update insight status' });
  }
});

app.patch('/api/tasks/:taskId/done', async (req, res) => {
  if (!req.session.tokens) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const taskId = parseInt(req.params.taskId, 10);
    const updated = await markTaskAsDone(taskId);
    if (!updated) {
      return res.status(404).json({ error: 'Task not found.' });
    }

    const activeTasks = await getActiveTasks(50);
    const allTasks = await getAllTasks(100);
    res.json({ success: true, tasks: activeTasks, allTasks });
  } catch (error) {
    console.error('Error in /api/tasks/:taskId/done:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unable to mark task as done' });
  }
});

app.patch('/api/tasks/:taskId/status', async (req, res) => {
  if (!req.session.tokens) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const status = req.body?.status;
  if (status !== 'active' && status !== 'done') {
    return res.status(400).json({ error: 'Invalid task status.' });
  }

  try {
    const taskId = parseInt(req.params.taskId, 10);
    const updated = await updateEmailTaskStatus(taskId, status);
    if (!updated) {
      return res.status(404).json({ error: 'Task not found.' });
    }

    const activeTasks = await getActiveTasks(50);
    const allTasks = await getAllTasks(100);
    res.json({ success: true, tasks: activeTasks, allTasks });
  } catch (error) {
    console.error('Error updating task status:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unable to update task status' });
  }
});

app.post('/api/custom-tasks', async (req, res) => {
  if (!req.session.tokens || !req.session.user.email) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { title, priority, dueDate } = req.body;
  if (!title || !priority || !dueDate) {
    return res.status(400).json({ error: 'Missing required fields: title, priority, dueDate' });
  }

  if (!['High', 'Medium', 'Low'].includes(priority)) {
    return res.status(400).json({ error: 'Invalid priority. Must be High, Medium, or Low.' });
  }

  try {
    const task = await createCustomTask(req.session.user.email, title, priority, dueDate);
    res.json(task);
  } catch (error) {
    console.error('Error creating custom task:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unable to create custom task' });
  }
});

app.get('/api/custom-tasks', async (req, res) => {
  if (!req.session.tokens || !req.session.user.email) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const includeDone = req.query.includeDone === '1' || req.query.includeDone === 'true';
    const tasks = await getCustomTasks(req.session.user.email, includeDone);
    res.json(tasks);
  } catch (error) {
    console.error('Error fetching custom tasks:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unable to fetch custom tasks' });
  }
});

app.patch('/api/custom-tasks/:taskId', async (req, res) => {
  if (!req.session.tokens) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { title, priority, dueDate } = req.body;
  const taskId = parseInt(req.params.taskId, 10);

  try {
    const task = await updateCustomTask(taskId, title, priority, dueDate);
    if (!task) {
      return res.status(404).json({ error: 'Custom task not found.' });
    }
    res.json(task);
  } catch (error) {
    console.error('Error updating custom task:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unable to update custom task' });
  }
});

app.patch('/api/custom-tasks/:taskId/status', async (req, res) => {
  if (!req.session.tokens) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const status = req.body?.status;
  if (status !== 'active' && status !== 'done') {
    return res.status(400).json({ error: 'Invalid custom task status.' });
  }

  try {
    const taskId = parseInt(req.params.taskId, 10);
    const task = await updateCustomTaskStatus(taskId, status);
    if (!task) {
      return res.status(404).json({ error: 'Custom task not found.' });
    }

    res.json(task);
  } catch (error) {
    console.error('Error updating custom task status:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unable to update custom task status' });
  }
});

app.patch('/api/custom-tasks/:taskId/done', async (req, res) => {
  if (!req.session.tokens) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const taskId = parseInt(req.params.taskId, 10);
    const updated = await markCustomTaskDone(taskId);
    if (!updated) {
      return res.status(404).json({ error: 'Custom task not found.' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error marking custom task done:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unable to mark custom task as done' });
  }
});

app.delete('/api/custom-tasks/:taskId', async (req, res) => {
  if (!req.session.tokens) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const taskId = parseInt(req.params.taskId, 10);
    const deleted = await deleteCustomTask(taskId);
    if (!deleted) {
      return res.status(404).json({ error: 'Custom task not found.' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting custom task:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unable to delete custom task' });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
