import type { EmailSummary, TaskItem } from './gmail';

type ExtractedTask = {
  emailId: string;
  title: string;
  source: string;
  dueDate: string;
  priority: 'High' | 'Medium' | 'Low';
};

type TaskExtractionResponse = {
  tasks: ExtractedTask[];
};

type OpenRouterResponsePayload = {
  choices?: Array<{
    message?: {
      content?: string;
    };
    delta?: {
      content?: string;
    };
  }>;
  error?: {
    code?: string | number;
    message?: string;
    metadata?: unknown;
  };
};

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'openrouter/free';
console.log('Using OpenRouter model:', DEFAULT_MODEL);
const MAX_EMAIL_BODY_CHARS = Number(process.env.MAX_EMAIL_BODY_CHARS || 4000);

const chunkEmails = (emails: EmailSummary[], size: number) => {
  const chunks: EmailSummary[][] = [];
  for (let i = 0; i < emails.length; i += size) {
    chunks.push(emails.slice(i, i + size));
  }
  return chunks;
};

const getExtractionChunkSize = () => {
  const configuredSize = Number(process.env.TASK_EXTRACTION_CHUNK_SIZE || 10);
  if (!Number.isFinite(configuredSize)) {
    return 10;
  }

  return Math.min(Math.max(Math.floor(configuredSize), 1), 20);
};

const truncateText = (text: string, maxLength: number) => {
  if (text.length <= maxLength) {
    return text;
  }

  return text.slice(0, maxLength);
};

const parseTaskResponse = (text: string): TaskExtractionResponse => {
  try {
    return JSON.parse(text) as TaskExtractionResponse;
  } catch {
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');

    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      return JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as TaskExtractionResponse;
    }

    throw new Error('Model response did not contain a JSON object.');
  }
};

const getResponseText = (payload: OpenRouterResponsePayload): string => {
  const choices = Array.isArray(payload?.choices) ? payload?.choices : [];

  if (choices.length === 0) {
    console.error('OpenRouter response payload:', JSON.stringify(payload, null, 2));
    throw new Error('OpenRouter task extraction returned no response choices.');
  }

  const choice = choices[0];
  const content = choice?.message?.content || choice?.delta?.content;

  if (!content || typeof content !== 'string') {
    console.error('OpenRouter choice:', JSON.stringify(choice, null, 2));
    throw new Error('OpenRouter task extraction returned no text content.');
  }

  let cleaned = content.trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
  }

  return cleaned;
};

const buildPrompt = (emails: EmailSummary[]) => {
  const today = new Date().toISOString().split('T')[0];

  return JSON.stringify({
    today,
    instructions: [
      'Extract only actionable tasks that a human would reasonably need to follow up on.',
      'Ignore newsletters, promotions, receipts, and purely informational emails unless they contain a concrete action request.',
      'Return zero or more tasks for the provided emails.',
      'Use the email sender for source when available.',
      'Return dueDate in YYYY-MM-DD format.',
      `If no explicit due date exists, use the email's sent date in YYYY-MM-DD format. Today's date is ${today}.`,
      'Keep titles short, specific, and action-oriented.',
      'Each task must reference the source email by emailId.',
      'Return only JSON. Do not include markdown, prose, or explanations.',
      'The JSON shape must be {"tasks":[{"emailId":"string","title":"string","source":"string","dueDate":"YYYY-MM-DD","priority":"High|Medium|Low"}]}.'
    ],
    emails: emails.map(email => ({
      emailId: email.id,
      threadId: email.threadId,
      subject: email.subject,
      from: email.from,
      date: email.date,
      snippet: email.snippet,
      body: truncateText(email.body || '', MAX_EMAIL_BODY_CHARS)
    }))
  });
};

const normalizeTasks = (emails: EmailSummary[], extracted: ExtractedTask[]): TaskItem[] => {
  const emailById = new Map(emails.map(email => [email.id, email]));

  return extracted
    .map(task => {
      const email = emailById.get(task.emailId);
      if (!email) {
        return null;
      }

      return {
        title: task.title.trim(),
        source: task.source.trim() || email.from,
        dueDate: task.dueDate,
        priority: task.priority,
        email
      } satisfies TaskItem;
    })
    .filter((task): task is TaskItem => task !== null)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
};

const getOpenRouterApiKey = () => process.env.OPENROUTER_API_KEY;

export const canUseTaskExtraction = () => Boolean(getOpenRouterApiKey());

export const extractTasksWithOpenRouter = async (emails: EmailSummary[]): Promise<TaskItem[]> => {
  const apiKey = getOpenRouterApiKey();

  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not configured.');
  }

  const chunks = chunkEmails(emails, getExtractionChunkSize());
  const extractedTasks: ExtractedTask[] = [];

  for (const chunk of chunks) {
    try {
      const response = await fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'http://localhost:5173',
          'X-Title': 'Gmail AI Interpreter'
        },
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          messages: [
            {
              role: 'system',
              content: 'You extract actionable tasks from emails and must respond with a valid JSON object matching the schema.'
            },
            {
              role: 'user',
              content: buildPrompt(chunk)
            }
          ],
          temperature: 0.2,
          max_tokens: 4096
        })
      });

      let payload: OpenRouterResponsePayload;
      try {
        payload = await response.json();
      } catch (e) {
        const text = await response.text();
        console.error('Failed to parse OpenRouter response:', text.substring(0, 500));
        throw new Error('OpenRouter returned an invalid JSON response.');
      }

      if (!response.ok) {
        const message = payload?.error?.message || `OpenRouter API error: ${response.status}`;
        console.error('OpenRouter error payload:', JSON.stringify(payload, null, 2));
        if (/insufficient credits/i.test(message)) {
          throw new Error(
            `OpenRouter rejected the request for model "${DEFAULT_MODEL}" due to insufficient credits. ` +
            'Use OPENROUTER_MODEL=openrouter/free or a model ID ending in :free for zero-cost routing.'
          );
        }
        if (/provider returned error/i.test(message)) {
          throw new Error(
            `OpenRouter provider failed for model "${DEFAULT_MODEL}". ` +
            'This is common with free routed models when the selected provider is overloaded or unavailable. Try again, or set OPENROUTER_MODEL to a specific :free model.'
          );
        }
        throw new Error(`OpenRouter request failed with status ${response.status}: ${message}`);
      }

      try {
        const responseText = getResponseText(payload);
        console.log('Extracted response text:', responseText.substring(0, 200));
        const parsed = parseTaskResponse(responseText);
        extractedTasks.push(...(Array.isArray(parsed.tasks) ? parsed.tasks : []));
      } catch (e) {
        console.error('Failed to parse task response:', e instanceof Error ? e.message : e);
        throw new Error('Failed to extract tasks from API response');
      }
    } catch (chunkError) {
      console.error('Error processing chunk:', chunkError);
      throw chunkError;
    }
  }

  return normalizeTasks(emails, extractedTasks);
};
