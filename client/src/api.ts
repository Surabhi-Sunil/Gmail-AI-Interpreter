export type TaskItem = {
  title: string;
  source: string;
  dueDate: string;
  priority: 'High' | 'Medium' | 'Low';
  email: {
    id: string;
    threadId: string;
    subject: string;
    from: string;
    date: string;
    snippet: string;
  };
};

const API_ROOT = import.meta.env.VITE_API_ROOT || 'http://localhost:4001';

const fetchJson = async <T>(path: string) => {
  const response = await fetch(`${API_ROOT}${path}`, {
    credentials: 'include'
  });
  return response.json() as Promise<T>;
};

export const getAuthUrl = () => fetchJson<{ url: string }>('/api/auth/url');
export const getAuthStatus = () => fetchJson<{ connected: boolean }>('/api/auth/status');
export const fetchTasks = () => fetchJson<{ tasks: TaskItem[] }>('/api/tasks');
