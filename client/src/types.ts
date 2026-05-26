export type TaskItem = {
  id: number;
  title: string;
  source: string;
  dueDate: string;
  priority: 'High' | 'Medium' | 'Low';
  status: 'active' | 'done';
  emailSubject: string;
  emailId: string;
};

export type EmailInsight = {
  category: 'Needs Reply' | 'Task' | 'Meeting' | 'FYI' | 'Newsletter' | 'Promotion' | 'Receipt' | 'Noise';
  urgency: 'High' | 'Medium' | 'Low';
  summary: string;
  suggestedAction: string;
  reason: string;
  status?: 'active' | 'done' | 'ignored';
  email: {
    id: string;
    threadId: string;
    subject: string;
    from: string;
    date: string;
    snippet: string;
  };
};

export type TriageStats = {
  listedEmails: number;
  syncedEmails: number;
  skippedExisting: number;
  tasks: number;
  insights: number;
  fetchMs: number;
  extractionMs: number;
};

export type EmailSummary = EmailInsight['email'];

export type EmailBuckets = {
  unreadListed: EmailSummary[];
  alreadySeen: EmailSummary[];
};
