import type { EmailBuckets, EmailInsight, TaskItem, TriageStats } from './types';

export type { EmailBuckets, EmailInsight, TaskItem, TriageStats };

export type DashboardResponse = {
  tasks: TaskItem[];
  allTasks?: TaskItem[];
  insights: EmailInsight[];
  taskInsights?: EmailInsight[];
  stats: TriageStats;
  emailBuckets?: EmailBuckets;
};

const API_ROOT = import.meta.env.VITE_API_ROOT || 'http://localhost:4001';

const fetchJson = async <T>(path: string, timeoutMs = 120000, options: RequestInit = {}) => {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${API_ROOT}${path}`, {
      ...options,
      credentials: 'include',
      cache: 'no-store',
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers
      },
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('Request timed out. Ollama may still be processing locally; try a smaller sync or faster model.');
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }

  let data: any;
  try {
    data = await response.json();
  } catch (e) {
    const text = await response.text();
    console.error('API response text:', text.substring(0, 500));
    throw new Error('Server returned invalid JSON. Check console for details.');
  }

  if (!response.ok) {
    const message = typeof data === 'object' && data !== null && 'error' in data ? (data as any).error : `Request failed with status ${response.status}`;
    throw new Error(message);
  }

  if (typeof data === 'object' && data !== null && 'error' in data) {
    throw new Error((data as any).error);
  }

  return data as T;
};

export const getAuthUrl = () => fetchJson<{ url: string }>('/api/auth/url');
export const getAuthStatus = () => fetchJson<{ connected: boolean }>('/api/auth/status');
export const getDashboard = () => fetchJson<DashboardResponse>('/api/dashboard');
export const fetchTasks = () => fetchJson<DashboardResponse>('/api/tasks', 180000);
export const updateInsightStatus = (messageId: string, status: 'active' | 'done' | 'ignored') =>
  fetchJson<DashboardResponse>(`/api/insights/${encodeURIComponent(messageId)}/status`, 30000, {
    method: 'PATCH',
    body: JSON.stringify({ status })
  });
export const markTaskAsDone = (taskId: number) =>
  fetchJson<{ success: boolean; tasks: TaskItem[]; allTasks?: TaskItem[] }>(`/api/tasks/${taskId}/done`, 30000, {
    method: 'PATCH'
  });

export const updateTaskStatus = (taskId: number, status: 'active' | 'done') =>
  fetchJson<{ success: boolean; tasks: TaskItem[]; allTasks?: TaskItem[] }>(`/api/tasks/${taskId}/status`, 30000, {
    method: 'PATCH',
    body: JSON.stringify({ status })
  });

export type CustomTask = {
  id: number;
  title: string;
  priority: 'High' | 'Medium' | 'Low';
  dueDate: string;
  status: 'active' | 'done';
  isCustom: true;
};

export const createCustomTask = (title: string, priority: 'High' | 'Medium' | 'Low', dueDate: string) =>
  fetchJson<CustomTask>('/api/custom-tasks', 30000, {
    method: 'POST',
    body: JSON.stringify({ title, priority, dueDate })
  });

export const getCustomTasks = (includeDone = false) =>
  fetchJson<CustomTask[]>(`/api/custom-tasks${includeDone ? '?includeDone=1' : ''}`, 30000);

export const updateCustomTask = (taskId: number, title: string, priority: 'High' | 'Medium' | 'Low', dueDate: string) =>
  fetchJson<CustomTask>(`/api/custom-tasks/${taskId}`, 30000, {
    method: 'PATCH',
    body: JSON.stringify({ title, priority, dueDate })
  });

export const markCustomTaskAsDone = (taskId: number) =>
  fetchJson<{ success: boolean }>(`/api/custom-tasks/${taskId}/done`, 30000, {
    method: 'PATCH'
  });

export const updateCustomTaskStatus = (taskId: number, status: 'active' | 'done') =>
  fetchJson<CustomTask>(`/api/custom-tasks/${taskId}/status`, 30000, {
    method: 'PATCH',
    body: JSON.stringify({ status })
  });

export const deleteCustomTask = (taskId: number) =>
  fetchJson<{ success: boolean }>(`/api/custom-tasks/${taskId}`, 30000, {
    method: 'DELETE'
  });
