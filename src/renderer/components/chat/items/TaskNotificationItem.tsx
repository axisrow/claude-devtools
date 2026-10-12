import { CheckCircle, Circle, FileText, XCircle } from 'lucide-react';

import type { TaskNotification } from '@shared/utils/contentSanitizer';

interface TaskNotificationItemProps {
  notification: TaskNotification;
}

/**
 * Card for a background task completion (issue #104): status icon, quoted
 * command name, exit code and output file — the card that used to live in
 * UserChatGroup before #70 moved these lines into AI groups.
 */
export const TaskNotificationItem = ({
  notification,
}: Readonly<TaskNotificationItemProps>): React.JSX.Element => {
  const isCompleted = notification.status === 'completed';
  const isFailed = notification.status === 'failed' || notification.status === 'error';
  const StatusIcon = isFailed ? XCircle : isCompleted ? CheckCircle : Circle;
  const statusColor = isFailed
    ? 'var(--error-highlight-text, #ef4444)'
    : isCompleted
      ? 'var(--badge-success-text, #22c55e)'
      : 'var(--color-text-muted)';

  // Extract quoted command name from summary (e.g., 'Background command "Run foo" completed')
  const cmdMatch = /"([^"]+)"/.exec(notification.summary);
  const cmdName = cmdMatch?.[1] ?? notification.summary;
  // Extract exit code
  const exitMatch = /\(exit code (\d+)\)/.exec(notification.summary);
  const exitCode = exitMatch?.[1];

  return (
    <div
      className="flex items-start gap-2.5 rounded-lg px-3 py-2"
      style={{
        backgroundColor: 'var(--card-bg)',
        border: '1px solid var(--card-border)',
      }}
    >
      <StatusIcon className="mt-0.5 size-3.5 shrink-0" style={{ color: statusColor }} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div
          className="text-xs font-medium leading-snug"
          style={{ color: 'var(--color-text-secondary)' }}
        >
          {cmdName}
        </div>
        <div
          className="flex items-center gap-2 text-[10px]"
          style={{ color: 'var(--color-text-muted)' }}
        >
          <span className="capitalize">{notification.status}</span>
          {exitCode != null && <span>exit {exitCode}</span>}
          {notification.outputFile && (
            <span className="flex items-center gap-0.5 truncate">
              <FileText className="size-2.5" />
              <span className="truncate">{notification.outputFile.split('/').pop()}</span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
