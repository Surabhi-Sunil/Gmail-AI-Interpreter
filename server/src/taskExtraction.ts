import type { EmailInsight, EmailSummary, TaskItem } from './gmail';

type ExtractedTask = {
  emailId: string;
  title: string;
  source: string;
  dueDate: string;
  priority: 'High' | 'Medium' | 'Low';
};

type ExtractedEmailInsight = {
  emailId: string;
  category: EmailInsight['category'];
  urgency: EmailInsight['urgency'];
  summary: string;
  suggestedAction: string;
  reason: string;
};

type TaskExtractionResponse = {
  tasks: ExtractedTask[];
};

type InsightExtractionResponse = {
  insights: ExtractedEmailInsight[];
};

export type EmailTriageResult = {
  tasks: TaskItem[];
  insights: EmailInsight[];
};

type OllamaResponsePayload = {
  message?: {
    content?: string;
  };
  response?: string;
  error?: string;
};

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';
console.log('Using Ollama model:', OLLAMA_MODEL);
const MAX_EMAIL_BODY_CHARS = Number(process.env.MAX_EMAIL_BODY_CHARS || 1200);
const OLLAMA_MAX_TOKENS = Number(process.env.OLLAMA_MAX_TOKENS || 1024);
const OLLAMA_AGENT_RETRIES = Number(process.env.OLLAMA_AGENT_RETRIES || 2);
const OLLAMA_REQUEST_TIMEOUT_MS = Number(process.env.OLLAMA_REQUEST_TIMEOUT_MS || 120000);

const chunkEmails = (emails: EmailSummary[], size: number) => {
  const chunks: EmailSummary[][] = [];
  for (let i = 0; i < emails.length; i += size) {
    chunks.push(emails.slice(i, i + size));
  }
  return chunks;
};

const getExtractionChunkSize = () => {
  const configuredSize = Number(process.env.TASK_EXTRACTION_CHUNK_SIZE || 1);
  if (!Number.isFinite(configuredSize)) {
    return 1;
  }

  return Math.min(Math.max(Math.floor(configuredSize), 1), 10);
};

const truncateText = (text: string, maxLength: number) => {
  if (text.length <= maxLength) {
    return text;
  }

  return text.slice(0, maxLength);
};

const getRetryCount = () => {
  if (!Number.isFinite(OLLAMA_AGENT_RETRIES)) {
    return 2;
  }

  return Math.min(Math.max(Math.floor(OLLAMA_AGENT_RETRIES), 1), 4);
};

const parseJsonResponse = <T>(text: string): T => {
  try {
    return JSON.parse(text) as T;
  } catch {
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');

    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      return JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as T;
    }

    throw new Error('Model response did not contain a JSON object.');
  }
};

const cleanJsonText = (text: string) => {
  let cleaned = text.trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
  }

  return cleaned;
};

const getOllamaRequestTimeoutMs = () => {
  if (!Number.isFinite(OLLAMA_REQUEST_TIMEOUT_MS)) {
    return 120000;
  }

  return Math.min(Math.max(Math.floor(OLLAMA_REQUEST_TIMEOUT_MS), 10000), 600000);
};

const isOllamaAvailabilityError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Cannot connect to Ollama') || message.includes('Make sure Ollama is running');
};

const buildEmailPayload = (emails: EmailSummary[]) => {
  const today = new Date().toISOString().split('T')[0];

  return {
    today,
    emails: emails.map(email => ({
      emailId: email.id,
      threadId: email.threadId,
      subject: email.subject,
      from: email.from,
      date: email.date,
      snippet: email.snippet,
      body: truncateText(email.body || '', MAX_EMAIL_BODY_CHARS)
    }))
  };
};

const buildInsightAgentPrompt = (emails: EmailSummary[]) => {
  return JSON.stringify({
    agent: 'InboxTriageAgent',
    role: 'Classify unread emails so the user understands what each email is for.',
    outputContract: {
      insights: [
        {
          emailId: 'string',
          category: 'Needs Reply|Task|Meeting|FYI|Newsletter|Promotion|Receipt|Noise',
          urgency: 'High|Medium|Low',
          summary: 'string',
          suggestedAction: 'string',
          reason: 'string'
        }
      ]
    },
    rules: [
      'Return exactly one insight for every provided email.',
      'Use Needs Reply when the sender appears to expect a response.',
      'Use Task when there is a concrete action, deadline, form, approval, payment, purchase, or follow-up.',
      'Use Meeting for calls, calendar events, interviews, appointments, invites, scheduling, or rescheduling.',
      'Use FYI for useful informational emails that do not need action.',
      'Classify sign-in alerts, security alerts, verification codes, and account notifications as FYI unless the email explicitly asks the user to secure, approve, confirm, or complete something.',
      'Use Noise for low-value notifications that can probably be archived.',
      'Keep summary under 18 words.',
      'Keep suggestedAction under 12 words.',
      'Keep reason under 14 words.',
      'Return only one complete valid JSON object.'
    ],
    ...buildEmailPayload(emails)
  });
};

const buildTaskAgentPrompt = (emails: EmailSummary[]) => {
  return JSON.stringify({
    agent: 'ActionExtractionAgent',
    role: 'Extract only concrete human follow-up tasks from unread emails.',
    outputContract: {
      tasks: [
        {
          emailId: 'string',
          title: 'string',
          source: 'string',
          dueDate: 'YYYY-MM-DD',
          priority: 'High|Medium|Low'
        }
      ]
    },
    rules: [
      'Return zero or more tasks.',
      'Do not create tasks for newsletters, promotions, receipts, FYI messages, or pure notifications unless there is a concrete action.',
      'Do not create tasks for sign-in alerts, security alerts, verification codes, or account notifications unless the email explicitly asks the user to take action.',
      'Use the email sender for source when available.',
      'Return dueDate in YYYY-MM-DD format.',
      'If no explicit due date exists, use the email sent date.',
      'Keep titles short, specific, and action-oriented.',
      'Each task must reference the source email by emailId.',
      'Return only one complete valid JSON object.'
    ],
    ...buildEmailPayload(emails)
  });
};

const normalizeInsights = (emails: EmailSummary[], extracted: ExtractedEmailInsight[]): EmailInsight[] => {
  const emailById = new Map(emails.map(email => [email.id, email]));
  const categoryOrder: Record<EmailInsight['category'], number> = {
    'Needs Reply': 0,
    Task: 1,
    Meeting: 2,
    FYI: 3,
    Receipt: 4,
    Newsletter: 5,
    Promotion: 6,
    Noise: 7
  };
  const urgencyOrder: Record<EmailInsight['urgency'], number> = {
    High: 0,
    Medium: 1,
    Low: 2
  };

  return extracted
    .map(insight => {
      const email = emailById.get(insight.emailId);
      if (!email) {
        return null;
      }

      return {
        category: insight.category,
        urgency: insight.urgency,
        summary: insight.summary.trim(),
        suggestedAction: insight.suggestedAction.trim(),
        reason: insight.reason.trim(),
        email
      } satisfies EmailInsight;
    })
    .filter((insight): insight is EmailInsight => insight !== null)
    .sort((a, b) => {
      const categoryDiff = categoryOrder[a.category] - categoryOrder[b.category];
      if (categoryDiff !== 0) return categoryDiff;
      return urgencyOrder[a.urgency] - urgencyOrder[b.urgency];
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

export const canUseTaskExtraction = () => true;

export const assertTaskExtractionReady = async () => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`Ollama health check returned status ${response.status}.`);
    }
  } catch (error) {
    throw new Error(
      `Cannot connect to Ollama at ${OLLAMA_BASE_URL}. ` +
      `Start Ollama and make sure the local model is installed: ollama pull ${OLLAMA_MODEL}.`
    );
  } finally {
    clearTimeout(timeout);
  }
};

const requestOllamaAgentJson = async <T>(
  agentName: string,
  systemPrompt: string,
  userPrompt: string
): Promise<T> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getOllamaRequestTimeoutMs());
  let response: Response;
  try {
    response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'user',
            content: userPrompt
          }
        ],
        stream: false,
        format: 'json',
        options: {
          temperature: 0,
          num_predict: OLLAMA_MAX_TOKENS
        }
      })
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(
        `${agentName}: Ollama timed out after ${getOllamaRequestTimeoutMs()}ms for model "${OLLAMA_MODEL}". ` +
        'Try a smaller model, lower GMAIL_SYNC_LIMIT, lower TASK_EXTRACTION_CHUNK_SIZE, or increase OLLAMA_REQUEST_TIMEOUT_MS.'
      );
    }

    throw new Error(
      `${agentName}: Cannot connect to Ollama at ${OLLAMA_BASE_URL}. ` +
      `Start Ollama and make sure the local model is installed: ollama pull ${OLLAMA_MODEL}.`
    );
  } finally {
    clearTimeout(timeout);
  }

  let payload: OllamaResponsePayload;
  try {
    payload = await response.json();
  } catch (e) {
    const text = await response.text();
    console.error(`${agentName} failed to parse Ollama response:`, text.substring(0, 500));
    throw new Error(`${agentName}: Ollama returned an invalid JSON response envelope.`);
  }

  if (!response.ok) {
    const message = payload?.error || `Ollama API error: ${response.status}`;
    throw new Error(
      `${agentName}: Ollama request failed for model "${OLLAMA_MODEL}": ${message}. ` +
      `Make sure Ollama is running and the model is pulled locally: ollama pull ${OLLAMA_MODEL}.`
    );
  }

  const responseText = payload.message?.content || payload.response;
  if (!responseText || typeof responseText !== 'string') {
    console.error(`${agentName} Ollama payload:`, JSON.stringify(payload, null, 2));
    throw new Error(`${agentName}: Ollama returned no text content for model "${OLLAMA_MODEL}".`);
  }

  const cleaned = cleanJsonText(responseText);
  console.log(`${agentName} response text:`, cleaned.substring(0, 200));
  return parseJsonResponse<T>(cleaned);
};

const runAgentWithRetry = async <T>(
  chunk: EmailSummary[],
  agentName: string,
  systemPrompt: string,
  buildUserPrompt: (emails: EmailSummary[]) => string
): Promise<T> => {
  let lastError: unknown;

  for (let attempt = 1; attempt <= getRetryCount(); attempt += 1) {
    try {
      return await requestOllamaAgentJson<T>(agentName, systemPrompt, buildUserPrompt(chunk));
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${agentName} attempt ${attempt}/${getRetryCount()} failed for ${chunk.length} emails:`, message);

      if (isOllamaAvailabilityError(error)) {
        throw error;
      }
    }
  }

  try {
    throw lastError instanceof Error ? lastError : new Error('Ollama request failed.');
  } catch (error) {
    console.error(`${agentName} failed for chunk of ${chunk.length} emails after retries:`, error instanceof Error ? error.message : error);

    if (isOllamaAvailabilityError(error)) {
      throw error;
    }

    if (chunk.length === 1) {
      throw new Error(
        `${agentName}: Ollama returned an unusable response for email "${chunk[0].subject}". ` +
        `${error instanceof Error ? error.message : 'The model response could not be parsed.'}`
      );
    }

    const midpoint = Math.ceil(chunk.length / 2);
    const first = await runAgentWithRetry<T>(chunk.slice(0, midpoint), agentName, systemPrompt, buildUserPrompt);
    const second = await runAgentWithRetry<T>(chunk.slice(midpoint), agentName, systemPrompt, buildUserPrompt);

    if (agentName === 'InboxTriageAgent') {
      const firstInsights = (first as InsightExtractionResponse).insights || [];
      const secondInsights = (second as InsightExtractionResponse).insights || [];
      return { insights: [...firstInsights, ...secondInsights] } as T;
    }

    const firstTasks = (first as TaskExtractionResponse).tasks || [];
    const secondTasks = (second as TaskExtractionResponse).tasks || [];
    return { tasks: [...firstTasks, ...secondTasks] } as T;
  }
};

const runInboxTriageAgent = (chunk: EmailSummary[]) => {
  return runAgentWithRetry<InsightExtractionResponse>(
    chunk,
    'InboxTriageAgent',
    'You are InboxTriageAgent. Your only job is to classify each email and return insights JSON. Do not extract tasks.',
    buildInsightAgentPrompt
  );
};

const runActionExtractionAgent = (chunk: EmailSummary[]) => {
  return runAgentWithRetry<TaskExtractionResponse>(
    chunk,
    'ActionExtractionAgent',
    'You are ActionExtractionAgent. Your only job is to extract concrete follow-up tasks and return tasks JSON. Do not classify inbox categories.',
    buildTaskAgentPrompt
  );
};

const getTaskCandidateEmails = (emails: EmailSummary[], insights: ExtractedEmailInsight[]) => {
  const actionableEmailIds = new Set(
    insights
      .filter(insight => insight.category === 'Task' || insight.category === 'Needs Reply' || insight.category === 'Meeting')
      .map(insight => insight.emailId)
  );

  return emails.filter(email => actionableEmailIds.has(email.id));
};

/**
 * Rule-based pre-filter: Categorize obvious emails without using AI
 * Returns insights for emails that match clear patterns, null for ambiguous ones
 */
const preFilterEmailByRules = (email: EmailSummary): ExtractedEmailInsight | null => {
  const subject = email.subject.toLowerCase();
  const from = email.from.toLowerCase();
  const body = (email.body || '').toLowerCase().slice(0, 500);
  const combined = `${subject} ${from} ${body}`;

  // Newsletter detection
  if (/newsletter|digest|weekly|monthly|unsubscribe|curated/.test(combined)) {
    return {
      emailId: email.id,
      category: 'Newsletter',
      urgency: 'Low',
      summary: 'Newsletter/digest content',
      suggestedAction: 'Archive',
      reason: 'Matched newsletter pattern'
    };
  }

  // Receipt/Order detection
  if (/receipt|order|invoice|purchase|confirmation|tracking|shipped|delivery/.test(combined)) {
    return {
      emailId: email.id,
      category: 'Receipt',
      urgency: 'Low',
      summary: 'Purchase receipt or order update',
      suggestedAction: 'Archive',
      reason: 'Matched receipt pattern'
    };
  }

  // Promotion/Sale detection
  if (/sale|discount|offer|limited time|deal|coupon|% off|save now|shop now/.test(combined)) {
    return {
      emailId: email.id,
      category: 'Promotion',
      urgency: 'Low',
      summary: 'Promotional content',
      suggestedAction: 'Archive',
      reason: 'Matched promotion pattern'
    };
  }

  // Social media notifications
  if (/facebook|instagram|twitter|linkedin|tiktok|youtube|reddit|slack/i.test(from)) {
    return {
      emailId: email.id,
      category: 'FYI',
      urgency: 'Low',
      summary: 'Social media notification',
      suggestedAction: 'Archive',
      reason: 'Matched social media pattern'
    };
  }

  // Bank/Finance alerts (but not receipts)
  if (/zelle|paypal|venmo|stripe|bank|account|transaction|balance/i.test(combined) && !/receipt|order/.test(combined)) {
    return {
      emailId: email.id,
      category: 'FYI',
      urgency: 'Medium',
      summary: 'Financial alert or notification',
      suggestedAction: 'Keep',
      reason: 'Matched finance pattern'
    };
  }

  // System/Notification detection
  if (/password reset|confirm email|verify|activate account|security alert|unusual activity/i.test(combined)) {
    return {
      emailId: email.id,
      category: 'Needs Reply',
      urgency: 'High',
      summary: 'Security verification required',
      suggestedAction: 'Review',
      reason: 'Matched security pattern'
    };
  }

  // No clear pattern - needs AI analysis
  return null;
};

export const extractEmailTriageWithOllama = async (emails: EmailSummary[]): Promise<EmailTriageResult> => {
  const extractedTasks: ExtractedTask[] = [];
  const preFilteredInsights: ExtractedEmailInsight[] = [];
  const emailsNeedingAI: EmailSummary[] = [];

  // First pass: Apply rule-based pre-filter
  console.log(`[PRE-FILTER] Analyzing ${emails.length} emails for patterns...`);
  for (const email of emails) {
    const preFiltered = preFilterEmailByRules(email);
    if (preFiltered) {
      preFilteredInsights.push(preFiltered);
      console.log(`  ✓ ${email.subject.slice(0, 50)} → ${preFiltered.category}`);
    } else {
      emailsNeedingAI.push(email);
    }
  }

  console.log(`[PRE-FILTER] Result: ${preFilteredInsights.length} auto-categorized, ${emailsNeedingAI.length} need AI`);

  // Second pass: Only run AI on ambiguous emails
  let ollama_insights: ExtractedEmailInsight[] = [];
  if (emailsNeedingAI.length > 0) {
    console.log(`[OLLAMA] Processing ${emailsNeedingAI.length} emails with Ollama...`);
    const chunks = chunkEmails(emailsNeedingAI, getExtractionChunkSize());

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const startTime = Date.now();
      try {
        console.log(`[OLLAMA ${i + 1}/${chunks.length}] Processing: ${chunk.map(e => e.subject.slice(0, 40)).join(', ')}`);
        
        const insightResponse = await runInboxTriageAgent(chunk);
        ollama_insights.push(...(Array.isArray(insightResponse.insights) ? insightResponse.insights : []));

        const taskCandidateEmails = getTaskCandidateEmails(chunk, insightResponse.insights || []);
        if (taskCandidateEmails.length === 0) {
          console.log(`[OLLAMA ${i + 1}/${chunks.length}] No actionable items. ${Date.now() - startTime}ms`);
          continue;
        }

        const taskResponse = await runActionExtractionAgent(taskCandidateEmails);
        extractedTasks.push(...(Array.isArray(taskResponse.tasks) ? taskResponse.tasks : []));
        console.log(`[OLLAMA ${i + 1}/${chunks.length}] ✓ Done. ${taskResponse.tasks?.length || 0} tasks. ${Date.now() - startTime}ms`);
      } catch (chunkError) {
        console.error(`[OLLAMA ${i + 1}/${chunks.length}] Error:`, chunkError);
        throw chunkError;
      }
    }
  }

  const allInsights = [...preFilteredInsights, ...ollama_insights];
  console.log(`✓ Complete: ${preFilteredInsights.length} pre-filtered + ${ollama_insights.length} AI insights = ${allInsights.length} total, ${extractedTasks.length} tasks`);

  return {
    tasks: normalizeTasks(emails, extractedTasks),
    insights: normalizeInsights(emails, allInsights)
  };
};
