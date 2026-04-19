import { gmail_v1, google } from 'googleapis';
import { buildAuthorizedClient } from './googleAuth';

export type EmailSummary = {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
};

export type TaskItem = {
  title: string;
  source: string;
  dueDate: string;
  priority: 'High' | 'Medium' | 'Low';
  email: EmailSummary;
};

const parseDate = (text: string, fallback: string): string => {
  const datePatterns = [
    /\bby\s+(\w+\s+\d{1,2}(?:,\s*\d{4})?)\b/i,
    /\b(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/i,
    /\b(on\s+\w+\s+\d{1,2}(?:,\s*\d{4})?)\b/i,
    /\b(\w+\s+\d{1,2})(?:,\s*\d{4})?\b/i
  ];

  for (const pattern of datePatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const attempt = new Date(match[1]);
      if (!Number.isNaN(attempt.getTime())) {
        return attempt.toISOString().split('T')[0];
      }
    }
  }

  return fallback;
};

const inferPriority = (text: string, due: string): 'High' | 'Medium' | 'Low' => {
  const normalized = text.toLowerCase();
  if (normalized.includes('urgent') || normalized.includes('asap') || normalized.includes('immediately')) {
    return 'High';
  }

  const dueDate = new Date(due);
  const now = new Date();
  const diffMs = dueDate.getTime() - now.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);

  if (diffDays <= 2) {
    return 'High';
  }
  if (diffDays <= 7) {
    return 'Medium';
  }
  return 'Low';
};

const extractTaskTitle = (subject: string, snippet: string): string => {
  if (subject && /action|required|please|due|deadline|review|approve|follow up|meeting|schedule/i.test(subject)) {
    return subject;
  }

  const candidate = snippet.split(/[\.\n]/).find((line) => /please|due|deadline|review|approve|follow up|meeting|schedule/i.test(line));
  return candidate?.trim() || subject || snippet.slice(0, 80);
};

export const extractTasksFromEmail = (email: EmailSummary): TaskItem | null => {
  const text = `${email.subject} ${email.snippet}`;
  const taskTitle = extractTaskTitle(email.subject, email.snippet);
  if (!taskTitle || taskTitle.length < 8) {
    return null;
  }

  const dueDate = parseDate(text, new Date(email.date).toISOString().split('T')[0]);
  const priority = inferPriority(text, dueDate);

  return {
    title: taskTitle,
    source: email.from,
    dueDate,
    priority,
    email
  };
};

export const fetchRecentEmails = async (tokens: any): Promise<EmailSummary[]> => {
  const authClient = buildAuthorizedClient(tokens);
  const gmail = google.gmail({ version: 'v1', auth: authClient });

  const listResponse = await gmail.users.messages.list({
    userId: 'me',
    maxResults: 100,
    q: 'in:inbox -label:promotions newer_than:30d'
  });

  const messages = listResponse.data.messages || [];
  const results: EmailSummary[] = [];

  for (const message of messages) {
    if (!message.id) continue;
    const messageResponse = await gmail.users.messages.get({
      userId: 'me',
      id: message.id,
      format: 'metadata',
      metadataHeaders: ['Subject', 'From', 'Date']
    });

    const headers = messageResponse.data.payload?.headers || [];
    const subject = headers.find((header) => header.name === 'Subject')?.value || 'No subject';
    const from = headers.find((header) => header.name === 'From')?.value || 'Unknown sender';
    const date = headers.find((header) => header.name === 'Date')?.value || new Date().toISOString();
    const snippet = messageResponse.data.snippet || '';

    results.push({
      id: message.id,
      threadId: message.threadId || '',
      subject,
      from,
      date,
      snippet
    });
  }

  return results;
};

export const buildTaskList = (emails: EmailSummary[]): TaskItem[] => {
  return emails
    .map(extractTasksFromEmail)
    .filter((task): task is TaskItem => task !== null)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
};
