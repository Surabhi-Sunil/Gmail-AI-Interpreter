import { google } from 'googleapis';
import { buildAuthorizedClient } from './googleAuth';
import { getOrCreateThread, insertEmail } from './db/db';

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

export const fetchRecentEmails = async (tokens: any): Promise<EmailSummary[]> => {
  const authClient = buildAuthorizedClient(tokens);
  const gmail = google.gmail({ version: 'v1', auth: authClient });
  const maxResults = getBoundedEnvNumber('GMAIL_SYNC_LIMIT', 25, 1, 100);
  const concurrency = getBoundedEnvNumber('GMAIL_SYNC_CONCURRENCY', 8, 1, 20);

  const listResponse = await gmail.users.messages.list({
    userId: 'me',
    maxResults,
    q: 'in:inbox -label:promotions newer_than:30d'
  });

  const messages = listResponse.data.messages || [];
  const validMessages = messages.filter((message): message is { id: string; threadId?: string | null } =>
    Boolean(message.id)
  );

  return mapWithConcurrency(validMessages, concurrency, async (message) => {
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
};
