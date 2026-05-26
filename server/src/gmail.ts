import { google } from 'googleapis';
import { buildAuthorizedClient } from './googleAuth';
import { getExistingMessageIds, getOrCreateThread, insertEmail } from './db/db';

export type EmailSummary = {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  body?: string;
};

export type TaskItem = {
  title: string;
  source: string;
  dueDate: string;
  priority: 'High' | 'Medium' | 'Low';
  email: EmailSummary;
};

export type EmailInsight = {
  category: 'Needs Reply' | 'Task' | 'Meeting' | 'FYI' | 'Newsletter' | 'Promotion' | 'Receipt' | 'Noise';
  urgency: 'High' | 'Medium' | 'Low';
  summary: string;
  suggestedAction: string;
  reason: string;
  status?: 'active' | 'done' | 'ignored';
  email: EmailSummary;
};

export type EmailSyncResult = {
  emails: EmailSummary[];
  listedMessageIds: string[];
  listed: number;
  skippedExisting: number;
};

const decodeBase64Url = (value?: string) => {
  if (!value) {
    return '';
  }

  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf-8');
};

const getHeaderValue = (headers: any[], name: string) =>
  headers.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value;

const getBoundedEnvNumber = (name: string, fallback: number, min: number, max: number) => {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(Math.max(Math.floor(value), min), max);
};

const mapWithConcurrency = async <T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
) => {
  const results: R[] = [];
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex]);
    }
  });

  await Promise.all(workers);
  return results;
};

const extractBodyText = (payload?: any): string => {
  if (!payload) {
    return '';
  }

  const mimeType = payload.mimeType || '';
  const bodyData = decodeBase64Url(payload.body?.data).trim();

  if (bodyData && (mimeType === 'text/plain' || !payload.parts?.length)) {
    return bodyData;
  }

  const parts = Array.isArray(payload.parts) ? payload.parts : [];
  for (const part of parts) {
    const partText = extractBodyText(part).trim();
    if (partText) {
      return partText;
    }
  }

  return bodyData;
};

export const fetchRecentEmails = async (tokens: any): Promise<EmailSyncResult> => {
  const authClient = buildAuthorizedClient(tokens);
  const gmail = google.gmail({ version: 'v1', auth: authClient });
  const maxResults = getBoundedEnvNumber('GMAIL_SYNC_LIMIT', 5, 1, 100);
  const concurrency = getBoundedEnvNumber('GMAIL_SYNC_CONCURRENCY', 8, 1, 20);

  const listResponse = await gmail.users.messages.list({
    userId: 'me',
    maxResults,
    q: process.env.GMAIL_QUERY || 'in:inbox is:unread -category:promotions newer_than:90d'
  });

  const messages = listResponse.data.messages || [];
  const validMessages = messages.filter((message): message is { id: string; threadId?: string | null } =>
    Boolean(message.id)
  );
  const existingMessageIds = await getExistingMessageIds(validMessages.map(message => message.id));
  const newMessages = validMessages.filter(message => !existingMessageIds.has(message.id));

  const emails = await mapWithConcurrency(newMessages, concurrency, async (message) => {
    const messageResponse = await gmail.users.messages.get({
      userId: 'me',
      id: message.id,
      format: 'full'
    });

    const headers = messageResponse.data.payload?.headers || [];
    const subject = getHeaderValue(headers, 'Subject') || 'No subject';
    const from = getHeaderValue(headers, 'From') || 'Unknown sender';
    const date = getHeaderValue(headers, 'Date') || new Date().toISOString();
    const snippet = messageResponse.data.snippet || '';
    const body = extractBodyText(messageResponse.data.payload);

    const emailSummary: EmailSummary = {
      id: message.id,
      threadId: message.threadId || '',
      subject,
      from,
      date,
      snippet,
      body
    };

    // Store in database
    try {
      const threadId = await getOrCreateThread(message.threadId || '', subject, snippet);
      await insertEmail(threadId as number, message.id, {
        subject,
        from,
        to: '',
        date,
        snippet,
        body
      });
    } catch (error) {
      console.error('Error storing email in DB:', error);
    }

    return emailSummary;
  });

  return {
    emails,
    listedMessageIds: validMessages.map(message => message.id),
    listed: validMessages.length,
    skippedExisting: validMessages.length - newMessages.length
  };
};

export const markEmailsAsRead = async (tokens: any, messageIds: string[]): Promise<void> => {
  if (messageIds.length === 0) return;

  const authClient = buildAuthorizedClient(tokens);
  const gmail = google.gmail({ version: 'v1', auth: authClient });

  await gmail.users.messages.batchModify({
    userId: 'me',
    requestBody: {
      ids: messageIds,
      removeLabelIds: ['UNREAD']
    }
  });

  console.log(`Marked ${messageIds.length} emails as read`);
};

export const applyLabelToEmails = async (
  tokens: any,
  messageIds: string[],
  labelName: string
): Promise<void> => {
  if (messageIds.length === 0) return;

  const authClient = buildAuthorizedClient(tokens);
  const gmail = google.gmail({ version: 'v1', auth: authClient });

  // First, get or create the label
  const labelsResponse = await gmail.users.labels.list({ userId: 'me' });
  let labelId = labelsResponse.data.labels?.find((label) => label.name === labelName)?.id;

  if (!labelId) {
    const createResponse = await gmail.users.labels.create({
      userId: 'me',
      requestBody: {
        name: labelName,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show'
      }
    });
    labelId = createResponse.data.id;
  }

  if (!labelId) {
    throw new Error(`Failed to get or create label: ${labelName}`);
  }

  // Apply the label to messages
  await gmail.users.messages.batchModify({
    userId: 'me',
    requestBody: {
      ids: messageIds,
      addLabelIds: [labelId]
    }
  });

  console.log(`Applied label "${labelName}" to ${messageIds.length} emails`);
};

export const archiveEmails = async (tokens: any, messageIds: string[]): Promise<void> => {
  if (messageIds.length === 0) return;

  const authClient = buildAuthorizedClient(tokens);
  const gmail = google.gmail({ version: 'v1', auth: authClient });

  await gmail.users.messages.batchModify({
    userId: 'me',
    requestBody: {
      ids: messageIds,
      removeLabelIds: ['INBOX']
    }
  });

  console.log(`Archived ${messageIds.length} emails`);
};
