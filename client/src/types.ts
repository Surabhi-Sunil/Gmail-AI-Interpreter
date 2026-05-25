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
