/**
 * SessionOriginStrip - One-line "where does this session live" label shown
 * above the chat: `repo · worktree · branch · ~/path`. Full path in tooltip.
 * Renders nothing when the origin is unknown.
 */

interface SessionOriginStripProps {
  /** Formatted origin string; '' renders nothing */
  origin: string;
  /** Tooltip (full unshortened origin parts) */
  title?: string;
}

export const SessionOriginStrip = ({
  origin,
  title,
}: Readonly<SessionOriginStripProps>): React.JSX.Element | null => {
  if (!origin) return null;
  return (
    <div
      className="shrink-0 truncate px-4 pt-1 text-[11px]"
      title={title}
      style={{ color: 'var(--color-text-muted)' }}
    >
      {origin}
    </div>
  );
};
