import type { TaskItem } from './types';

export type { TaskItem };

const API_ROOT = import.meta.env.VITE_API_ROOT || 'http://localhost:4001';

const fetchJson = async <T>(path: string) => {
  const response = await fetch(`${API_ROOT}${path}`, {
    credentials: 'include',
    cache: 'no-store'
  });

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
export const fetchTasks = () => fetchJson<{ tasks: TaskItem[] }>('/api/tasks');
