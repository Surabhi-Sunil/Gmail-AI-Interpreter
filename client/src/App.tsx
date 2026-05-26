import { useEffect, useState } from 'react';
import { fetchTasks, getAuthStatus, getAuthUrl, getDashboard, updateInsightStatus, updateTaskStatus, createCustomTask, getCustomTasks, updateCustomTaskStatus, deleteCustomTask, type CustomTask } from './api';
import type { EmailBuckets, EmailInsight, TaskItem, TriageStats } from './api';

type MetricFilter = 'unread' | 'seen' | 'needsReply' | null;
type DashboardTab = 'inbox' | 'myTasks' | 'triage';
type TaskLifecycleFilter = 'active' | 'done';

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

const groupInsights = (insights: EmailInsight[]) => {
  return insights.reduce<Record<string, EmailInsight[]>>((groups, insight) => {
    groups[insight.category] = groups[insight.category] || [];
    groups[insight.category].push(insight);
    return groups;
  }, {});
};

const getInsightCounts = (insights: EmailInsight[]) => {
  return insights.reduce<Record<string, number>>((counts, insight) => {
    counts[insight.category] = (counts[insight.category] || 0) + 1;
    return counts;
  }, {});
};

function App() {
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [allEmailTasks, setAllEmailTasks] = useState<TaskItem[]>([]);
  const [customTasks, setCustomTasks] = useState<CustomTask[]>([]);
  const [insights, setInsights] = useState<EmailInsight[]>([]);
  const [emailTaskInsights, setEmailTaskInsights] = useState<EmailInsight[]>([]);
  const [stats, setStats] = useState<TriageStats | null>(null);
  const [emailBuckets, setEmailBuckets] = useState<EmailBuckets>({ unreadListed: [], alreadySeen: [] });
  const [metricFilter, setMetricFilter] = useState<MetricFilter>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<DashboardTab>('myTasks');
  const [taskLifecycleFilter, setTaskLifecycleFilter] = useState<TaskLifecycleFilter>('active');
  const [triageCategory, setTriageCategory] = useState<string>('');
  
  // Custom task form state
  const [showCustomTaskForm, setShowCustomTaskForm] = useState(false);
  const [customTaskForm, setCustomTaskForm] = useState({
    title: '',
    priority: 'Medium' as 'High' | 'Medium' | 'Low',
    dueDate: new Date().toISOString().split('T')[0]
  });

  useEffect(() => {
    const checkConnection = async () => {
      try {
        const result = await getAuthStatus();
        setConnected(result.connected);
      } catch (err) {
        console.error('Failed to check auth status:', err);
        setError('Unable to connect to server. Please check your connection.');
      }
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

  const applyDashboard = (response: { tasks?: TaskItem[]; allTasks?: TaskItem[]; insights?: EmailInsight[]; taskInsights?: EmailInsight[]; stats?: TriageStats; emailBuckets?: EmailBuckets }) => {
    const fetchedTasks = response.tasks ?? [];
    const fetchedAllTasks = response.allTasks ?? fetchedTasks;
    const fetchedInsights = response.insights ?? [];
    const fetchedTaskInsights = response.taskInsights ?? fetchedInsights.filter((insight) => insight.category === 'Task');
    if (!Array.isArray(fetchedTasks)) {
      throw new Error('Invalid task response from server.');
    }
    if (!Array.isArray(fetchedAllTasks)) {
      throw new Error('Invalid task history response from server.');
    }
    if (!Array.isArray(fetchedInsights)) {
      throw new Error('Invalid insight response from server.');
    }
    setTasks(fetchedTasks);
    setAllEmailTasks(fetchedAllTasks);
    setInsights(fetchedInsights);
    setEmailTaskInsights(fetchedTaskInsights);
    setStats(response.stats ?? null);
    setEmailBuckets(response.emailBuckets ?? { unreadListed: [], alreadySeen: [] });
  };

  useEffect(() => {
    if (!connected) {
      return;
    }

    const loadDashboard = async () => {
      try {
        setError(null);
        const response = await getDashboard();
        applyDashboard(response);
        
        // Also load custom tasks
        const custom = await getCustomTasks(true);
        setCustomTasks(custom);
      } catch (err) {
        console.error('Dashboard load error:', err);
        setError(err instanceof Error ? err.message : 'Unable to load dashboard.');
      }
    };

    loadDashboard();
  }, [connected]);

  const handleSyncTasks = async () => {
    try {
      setError(null);
      setLoading(true);
      const response = await fetchTasks();
      applyDashboard(response);
    } catch (err) {
      console.error('Sync error:', err);
      setError(err instanceof Error ? err.message : 'Unable to sync tasks. Please reconnect or try again.');
      setTasks([]);
      setAllEmailTasks([]);
      setInsights([]);
      setEmailTaskInsights([]);
      setStats(null);
      setEmailBuckets({ unreadListed: [], alreadySeen: [] });
      setMetricFilter(null);
    } finally {
      setLoading(false);
    }
  };

  const handleInsightStatus = async (messageId: string, status: 'active' | 'done' | 'ignored') => {
    try {
      setError(null);
      const response = await updateInsightStatus(messageId, status);
      applyDashboard(response);
    } catch (err) {
      console.error('Status update error:', err);
      setError(err instanceof Error ? err.message : 'Unable to update email status.');
    }
  };

  const handleEmailTaskStatus = async (taskId: number, status: 'active' | 'done') => {
    try {
      setError(null);
      const response = await updateTaskStatus(taskId, status);
      if (response.success) {
        setTasks(response.tasks);
        setAllEmailTasks(response.allTasks ?? response.tasks);
      }
    } catch (err) {
      console.error('Update task status error:', err);
      setError(err instanceof Error ? err.message : 'Unable to update task status.');
    }
  };

  const handleCreateCustomTask = async () => {
    if (!customTaskForm.title.trim()) {
      setError('Task title cannot be empty');
      return;
    }

    try {
      setError(null);
      const task = await createCustomTask(customTaskForm.title, customTaskForm.priority, customTaskForm.dueDate);
      setCustomTasks([...customTasks, task]);
      setCustomTaskForm({
        title: '',
        priority: 'Medium',
        dueDate: new Date().toISOString().split('T')[0]
      });
      setShowCustomTaskForm(false);
    } catch (err) {
      console.error('Create custom task error:', err);
      setError(err instanceof Error ? err.message : 'Unable to create task.');
    }
  };

  const handleMarkCustomTaskDone = async (taskId: number) => {
    try {
      setError(null);
      const updatedTask = await updateCustomTaskStatus(taskId, 'done');
      setCustomTasks(customTasks.map(task => task.id === taskId ? updatedTask : task));
    } catch (err) {
      console.error('Mark custom task done error:', err);
      setError(err instanceof Error ? err.message : 'Unable to mark task as done.');
    }
  };

  const handleRestoreCustomTask = async (taskId: number) => {
    try {
      setError(null);
      const updatedTask = await updateCustomTaskStatus(taskId, 'active');
      setCustomTasks(customTasks.map(task => task.id === taskId ? updatedTask : task));
    } catch (err) {
      console.error('Restore custom task error:', err);
      setError(err instanceof Error ? err.message : 'Unable to restore task.');
    }
  };

  const handleDeleteCustomTask = async (taskId: number) => {
    try {
      setError(null);
      await deleteCustomTask(taskId);
      setCustomTasks(customTasks.filter(t => t.id !== taskId));
    } catch (err) {
      console.error('Delete custom task error:', err);
      setError(err instanceof Error ? err.message : 'Unable to delete task.');
    }
  };

  const handleMetricClick = (filter: Exclude<MetricFilter, null>) => {
    setMetricFilter(metricFilter === filter ? null : filter);
    setActiveTab('inbox');
  };

  const taskInsights = emailTaskInsights;
  const triageInsights = insights.filter((insight) => insight.category !== 'Task');
  const activeEmailTaskInsights = taskInsights.filter((insight) => (insight.status || 'active') === 'active');
  const doneEmailTaskInsights = taskInsights.filter((insight) => insight.status === 'done');
  const visibleEmailTaskInsights = taskInsights.filter((insight) => {
    const status = insight.status || 'active';
    return status === taskLifecycleFilter;
  });
  const visibleCustomTasks = customTasks.filter((task) => task.status === taskLifecycleFilter);
  const visibleExtractedEmailTasks = allEmailTasks.filter((task) => task.status === taskLifecycleFilter);
  const activeCustomTasks = customTasks.filter((task) => task.status === 'active');
  const doneCustomTasks = customTasks.filter((task) => task.status === 'done');
  const activeExtractedEmailTasks = allEmailTasks.filter((task) => task.status === 'active');
  const doneExtractedEmailTasks = allEmailTasks.filter((task) => task.status === 'done');
  const groupedInsights = groupInsights(triageInsights);
  const triageCategories = Object.keys(groupedInsights);
  const selectedTriageCategory = triageCategories.includes(triageCategory) ? triageCategory : (triageCategories[0] || '');
  const visibleTriageInsights = selectedTriageCategory ? groupedInsights[selectedTriageCategory] || [] : [];
  const insightCounts = getInsightCounts(insights || []);
  const needsReplyInsights = insights.filter((insight) => insight.category === 'Needs Reply');
  const metricEmails =
    metricFilter === 'unread' ? emailBuckets.unreadListed :
    metricFilter === 'seen' ? emailBuckets.alreadySeen :
    metricFilter === 'needsReply' ? needsReplyInsights.map((insight) => insight.email) :
    [];
  const metricTitle =
    metricFilter === 'unread' ? 'Unread listed' :
    metricFilter === 'seen' ? 'Already seen' :
    metricFilter === 'needsReply' ? 'Needs reply' :
    '';
  const inboxTabCount = metricFilter ? metricEmails.length : emailBuckets.unreadListed.length;
  const tabs: Array<{ id: DashboardTab; label: string; count: number }> = [
    { id: 'myTasks', label: 'My tasks', count: activeCustomTasks.length + activeEmailTaskInsights.length + activeExtractedEmailTasks.length },
    { id: 'triage', label: 'Triage', count: triageInsights.length },
    { id: 'inbox', label: 'Inbox emails', count: inboxTabCount }
  ];
  const taskLifecycleLabel = taskLifecycleFilter;

  return (
    <div className="app-shell">
      {!connected ? (
        <header className="topbar">
          <div>
            <h1>Inbox Intelligence</h1>
            <p>Connect Gmail to turn unread email into a focused action and triage dashboard.</p>
          </div>
          <div>
            <span className="status-chip disconnected">Not connected</span>
          </div>
        </header>
      ) : null}

      {!connected ? (
        <section className="hero-card">
          <h2>Start by connecting your Gmail account</h2>
          <button className="primary-button" onClick={handleConnect}>
            Connect Gmail
          </button>
          <p>Once connected, the app can read your recent emails and surface the most actionable tasks.</p>
        </section>
      ) : (
        <section className="workspace">
          <aside className="menu-bar">
            <div className="menu-brand">
              <span className="menu-kicker">Dashboard</span>
              <strong>Inbox Intelligence</strong>
            </div>
            <nav className="menu-nav" aria-label="Dashboard sections">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  aria-current={activeTab === tab.id ? 'page' : undefined}
                  className={`menu-item ${activeTab === tab.id ? 'active' : ''}`}
                  onClick={() => setActiveTab(tab.id)}
                >
                  <span>{tab.label}</span>
                  <strong>{tab.count}</strong>
                </button>
              ))}
            </nav>
            <div className="menu-footer">
              <span className={`status-chip ${connected ? 'connected' : 'disconnected'}`}>
                {connected ? 'Gmail connected' : 'Not connected'}
              </span>
            </div>
          </aside>

          <main className="task-panel">
            <div className="task-actions">
              <div>
                <h2>{tabs.find((tab) => tab.id === activeTab)?.label}</h2>
                <p>Pull new unread mail, triage anything unprocessed, and show the saved dashboard.</p>
              </div>
              <button className="primary-button" onClick={handleSyncTasks} disabled={loading}>
                {loading ? 'Syncing...' : 'Sync inbox'}
              </button>
            </div>

          {error ? <div className="alert">{error}</div> : null}

          <div className="tab-panel">
            {activeTab === 'inbox' ? (
              <div className="triage-section metric-email-section">
                {stats ? (
                  <div className="metric-grid">
                    <button type="button" className={`metric-tile ${metricFilter === 'unread' ? 'active' : ''}`} onClick={() => handleMetricClick('unread')}>
                      <span>Unread listed</span>
                      <strong>{stats.listedEmails}</strong>
                    </button>
                    <div className="metric-tile">
                      <span>New</span>
                      <strong>{stats.syncedEmails}</strong>
                    </div>
                    <button type="button" className={`metric-tile ${metricFilter === 'seen' ? 'active' : ''}`} onClick={() => handleMetricClick('seen')}>
                      <span>Already seen</span>
                      <strong>{stats.skippedExisting}</strong>
                    </button>
                    <button type="button" className={`metric-tile ${metricFilter === 'needsReply' ? 'active' : ''}`} onClick={() => handleMetricClick('needsReply')}>
                      <span>Needs reply</span>
                      <strong>{insightCounts['Needs Reply'] || 0}</strong>
                    </button>
                  </div>
                ) : null}
                <div className="section-title-row">
                  <div>
                    <h2>{metricTitle || 'Inbox emails'}</h2>
                    <p className="section-subtitle">Use the summary cards above to choose which emails to inspect.</p>
                  </div>
                  {metricFilter ? (
                    <button type="button" className="text-button" onClick={() => setMetricFilter(null)}>Clear</button>
                  ) : null}
                </div>
                {metricFilter && metricEmails.length > 0 ? (
                  <div className="task-list">
                    {metricEmails.map((email) => (
                      <article key={email.id} className="task-card">
                        <div className="task-label-row">
                          <span className="task-priority medium">{email.from}</span>
                          <span className="task-due">{new Date(email.date).toLocaleDateString()}</span>
                        </div>
                        <h4>{email.subject}</h4>
                        <p>{email.snippet}</p>
                        <div className="card-actions">
                          <a href={`https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(email.id)}`} target="_blank" rel="noreferrer">
                            Open in Gmail
                          </a>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="empty-state">
                    <p>{metricFilter ? 'No emails to show for this card yet. Run a sync to refresh this list.' : 'Click Unread listed, Already seen, or Needs reply to show matching emails here.'}</p>
                  </div>
                )}
              </div>
            ) : null}

            {activeTab === 'myTasks' ? (
              <div className="triage-section">
                <div className="custom-task-section">
                  <div className="custom-task-header">
                    <h2>My tasks</h2>
                    <button 
                      className="secondary-button" 
                      onClick={() => setShowCustomTaskForm(!showCustomTaskForm)}
                    >
                      {showCustomTaskForm ? 'Close' : 'New Task'}
                    </button>
                  </div>
                  
                  {showCustomTaskForm ? (
                    <div className="custom-task-form">
                      <input
                        type="text"
                        placeholder="What do you need to do?"
                        value={customTaskForm.title}
                        onChange={(e) => setCustomTaskForm({ ...customTaskForm, title: e.target.value })}
                        className="form-input"
                      />
                      <select
                        value={customTaskForm.priority}
                        onChange={(e) => setCustomTaskForm({ ...customTaskForm, priority: e.target.value as any })}
                        className="form-select"
                      >
                        <option value="High">High Priority</option>
                        <option value="Medium">Medium Priority</option>
                        <option value="Low">Low Priority</option>
                      </select>
                      <input
                        type="date"
                        value={customTaskForm.dueDate}
                        onChange={(e) => setCustomTaskForm({ ...customTaskForm, dueDate: e.target.value })}
                        className="form-input"
                      />
                      <button className="primary-button" onClick={handleCreateCustomTask}>
                        Create Task
                      </button>
                    </div>
                  ) : null}

                  <div className="lifecycle-summary">
                    <button type="button" className={taskLifecycleFilter === 'active' ? 'active' : ''} onClick={() => setTaskLifecycleFilter('active')}>
                      <span>Active</span>
                      <strong>{activeCustomTasks.length + activeEmailTaskInsights.length + activeExtractedEmailTasks.length}</strong>
                    </button>
                    <button type="button" className={taskLifecycleFilter === 'done' ? 'active' : ''} onClick={() => setTaskLifecycleFilter('done')}>
                      <span>Done</span>
                      <strong>{doneCustomTasks.length + doneEmailTaskInsights.length + doneExtractedEmailTasks.length}</strong>
                    </button>
                  </div>
                </div>

                {visibleExtractedEmailTasks.length > 0 || visibleEmailTaskInsights.length > 0 ? (
                  <div className="group-card">
                    <h3>Email tasks</h3>
                    <div className="task-list">
                      {visibleExtractedEmailTasks.map((task) => (
                        <article key={task.id} className="task-card">
                          <div className="task-label-row">
                            <span className={`task-priority ${task.priority.toLowerCase()}`}>{task.priority}</span>
                            <span className="task-due">Due {task.dueDate}</span>
                            {task.status === 'done' && <span className="task-status-badge">done</span>}
                          </div>
                          <h4>{task.title}</h4>
                          <p className="task-email-subject">{task.emailSubject}</p>
                          <div className="task-meta">
                            <span>{task.source}</span>
                          </div>
                          <div className="card-actions">
                            <a href={`https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(task.emailId)}`} target="_blank" rel="noreferrer">
                              Open in Gmail
                            </a>
                            {task.status !== 'done' ? (
                              <button type="button" onClick={() => handleEmailTaskStatus(task.id, 'done')}>
                                Mark Done
                              </button>
                            ) : (
                              <button type="button" onClick={() => handleEmailTaskStatus(task.id, 'active')}>
                                Restore
                              </button>
                            )}
                          </div>
                        </article>
                      ))}
                      {visibleEmailTaskInsights.map((insight) => (
                        <article key={insight.email.id} className="task-card">
                          <div className="task-label-row">
                            <span className={`task-priority ${insight.urgency.toLowerCase()}`}>{insight.urgency}</span>
                            <span className="task-due">{new Date(insight.email.date).toLocaleDateString()}</span>
                            {insight.status && insight.status !== 'active' ? <span className="task-status-badge">{insight.status}</span> : null}
                          </div>
                          <h4>{insight.summary}</h4>
                          <p className="task-email-subject">{insight.email.subject}</p>
                          <div className="insight-action">{insight.suggestedAction}</div>
                          <div className="task-meta">
                            <span>{insight.email.from}</span>
                            <span>{insight.reason}</span>
                          </div>
                          <div className="card-actions">
                            <a href={`https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(insight.email.id)}`} target="_blank" rel="noreferrer">
                              Open in Gmail
                            </a>
                            {(insight.status || 'active') !== 'done' ? (
                              <button type="button" onClick={() => handleInsightStatus(insight.email.id, 'done')}>
                                Done
                              </button>
                            ) : (
                              <button type="button" onClick={() => handleInsightStatus(insight.email.id, 'active')}>
                                Restore
                              </button>
                            )}
                          </div>
                        </article>
                      ))}
                    </div>
                  </div>
                ) : null}

                {visibleCustomTasks.length > 0 ? (
                  <div className="group-card">
                    <h3>Personal tasks</h3>
                    <div className="task-list">
                    {visibleCustomTasks.map((task) => (
                      <article key={task.id} className="task-card custom-task-card">
                        <div className="task-label-row">
                          <span className={`task-priority ${task.priority.toLowerCase()}`}>{task.priority}</span>
                          <span className="task-due">Due {task.dueDate}</span>
                          {task.status === 'done' && <span className="task-status-badge">done</span>}
                        </div>
                        <h4>{task.title}</h4>
                        <div className="card-actions">
                          {task.status !== 'done' ? (
                            <button type="button" onClick={() => handleMarkCustomTaskDone(task.id)}>
                              Mark Done
                            </button>
                          ) : (
                            <button type="button" onClick={() => handleRestoreCustomTask(task.id)}>
                              Restore
                            </button>
                          )}
                          <button type="button" onClick={() => handleDeleteCustomTask(task.id)} className="delete-button">
                            Delete
                          </button>
                        </div>
                      </article>
                    ))}
                    </div>
                  </div>
                ) : (
                  visibleEmailTaskInsights.length === 0 && visibleExtractedEmailTasks.length === 0 ? (
                    <div className="empty-state">
                      <p>No {taskLifecycleLabel} tasks to show.</p>
                    </div>
                  ) : null
                )}
              </div>
            ) : null}

            {activeTab === 'triage' ? (
              <div className="triage-section">
                <h2>Unread triage</h2>
                {triageInsights.length > 0 ? (
                  <>
                    <div className="category-tabs" role="tablist" aria-label="Triage categories">
                      {triageCategories.map((category) => (
                        <button
                          key={category}
                          type="button"
                          role="tab"
                          aria-selected={selectedTriageCategory === category}
                          className={selectedTriageCategory === category ? 'active' : ''}
                          onClick={() => setTriageCategory(category)}
                        >
                          <span>{category}</span>
                          <strong>{groupedInsights[category].length}</strong>
                        </button>
                      ))}
                    </div>

                    <div className="group-card">
                      <h3>{selectedTriageCategory}</h3>
                      <div className="task-list">
                        {visibleTriageInsights.map((insight) => (
                          <article key={insight.email.id} className="task-card">
                            <div className="task-label-row">
                              <span className={`task-priority ${insight.urgency.toLowerCase()}`}>{insight.urgency}</span>
                              <span className="task-due">{new Date(insight.email.date).toLocaleDateString()}</span>
                            </div>
                            <h4>{insight.summary}</h4>
                            <p>{insight.email.subject}</p>
                            <div className="insight-action">{insight.suggestedAction}</div>
                            <div className="task-meta">
                              <span>{insight.email.from}</span>
                              <span>{insight.reason}</span>
                            </div>
                            <div className="card-actions">
                              <a href={`https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(insight.email.id)}`} target="_blank" rel="noreferrer">
                                Open in Gmail
                              </a>
                              <button type="button" onClick={() => handleInsightStatus(insight.email.id, 'done')}>
                                Done
                              </button>
                              <button type="button" onClick={() => handleInsightStatus(insight.email.id, 'ignored')}>
                                Ignore
                              </button>
                            </div>
                          </article>
                        ))}
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="empty-state">
                    <p>No triage insights yet. Sync your inbox to categorize unread mail.</p>
                  </div>
                )}
              </div>
            ) : null}
          </div>
          </main>
        </section>
      )}
    </div>
  );
}

export default App;
