import { useEffect, useState } from 'react';
import { fetchTasks, getAuthStatus, getAuthUrl, TaskItem } from './api';

const getGroupLabel = (dueDate: string) => {
  const due = new Date(dueDate);
  const today = new Date();
  const difference = due.getTime() - today.getTime();
  const days = Math.ceil(difference / (1000 * 60 * 60 * 24));

  if (days < 0) return 'Overdue';
  if (days <= 1) return 'Today';
  if (days <= 7) return 'This week';
  return 'Later';
};

const groupTasks = (tasks: TaskItem[]) => {
  return tasks.reduce<Record<string, TaskItem[]>>((groups, task) => {
    const label = getGroupLabel(task.dueDate);
    groups[label] = groups[label] || [];
    groups[label].push(task);
    return groups;
  }, {});
};

function App() {
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const checkConnection = async () => {
      const result = await getAuthStatus();
      setConnected(result.connected);
    };
    checkConnection();
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('connected') === '1') {
      setConnected(true);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const handleConnect = async () => {
    try {
      setError(null);
      const result = await getAuthUrl();
      window.location.href = result.url;
    } catch (err) {
      setError('Unable to start Gmail connection.');
    }
  };

  const handleSyncTasks = async () => {
    try {
      setError(null);
      setLoading(true);
      const response = await fetchTasks();
      setTasks(response.tasks);
    } catch (_err) {
      setError('Unable to sync tasks. Please reconnect or try again.');
    } finally {
      setLoading(false);
    }
  };

  const groupedTasks = groupTasks(tasks);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>nbox Intelligence</h1>
          <p>Connect Gmail to surface task-oriented emails in a clean action dashboard.</p>
        </div>
        <div>
          <span className={`status-chip ${connected ? 'connected' : 'disconnected'}`}>
            {connected ? 'Gmail connected' : 'Not connected'}
          </span>
        </div>
      </header>

      {!connected ? (
        <section className="hero-card">
          <h2>Start by connecting your Gmail account</h2>
          <button className="primary-button" onClick={handleConnect}>
            Connect Gmail
          </button>
          <p>Once connected, the app can read your recent emails and surface the most actionable tasks.</p>
        </section>
      ) : (
        <section className="task-panel">
          <div className="task-actions">
            <button className="primary-button" onClick={handleSyncTasks} disabled={loading}>
              {loading ? 'Syncing…' : 'Sync recent email tasks'}
            </button>
            <p>Fetch the latest actionable items from your recent Gmail messages.</p>
          </div>

          {error ? <div className="alert">{error}</div> : null}

          {tasks.length === 0 ? (
            <div className="empty-state">
              <p>No tasks yet. Click sync to build your dashboard from recent emails.</p>
            </div>
          ) : (
            Object.entries(groupedTasks).map(([group, groupTasks]) => (
              <div key={group} className="group-card">
                <h3>{group}</h3>
                <div className="task-list">
                  {groupTasks.map((task) => (
                    <article key={task.email.id} className="task-card">
                      <div className="task-label-row">
                        <span className={`task-priority ${task.priority.toLowerCase()}`}>{task.priority}</span>
                        <span className="task-due">Due {task.dueDate}</span>
                      </div>
                      <h4>{task.title}</h4>
                      <p>{task.email.subject}</p>
                      <div className="task-meta">
                        <span>{task.source}</span>
                        <span>{new Date(task.email.date).toLocaleDateString()}</span>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            ))
          )}
        </section>
      )}
    </div>
  );
}

export default App;
