/**
 * NotificationsSection - Notification settings including triggers and ignored repositories.
 */

import {
  RepositoryDropdown,
  SelectedRepositoryItem,
} from '@renderer/components/common/RepositoryDropdown';

import { SettingRow, SettingsSectionHeader, SettingsSelect, SettingsToggle } from '../components';
import { NotificationTriggerSettings } from '../NotificationTriggerSettings';

import type { RepositoryDropdownItem, SafeConfig } from '../hooks/useSettingsConfig';
import type { NotificationTrigger } from '@renderer/types/data';

// Snooze duration options
const SNOOZE_OPTIONS = [
  { value: 15, label: '15 minutes' },
  { value: 30, label: '30 minutes' },
  { value: 60, label: '1 hour' },
  { value: 120, label: '2 hours' },
  { value: 240, label: '4 hours' },
  { value: -1, label: 'Until tomorrow' },
] as const;

interface NotificationsSectionProps {
  readonly safeConfig: SafeConfig;
  readonly saving: boolean;
  readonly isSnoozed: boolean;
  readonly ignoredRepositoryItems: RepositoryDropdownItem[];
  readonly excludedRepositoryIds: string[];
  readonly onNotificationToggle: (
    key: 'enabled' | 'soundEnabled' | 'includeSubagentErrors',
    value: boolean
  ) => void;
  readonly onLoopDetectionChange: (value: { enabled: boolean; cycleThreshold: number }) => void;
  readonly onTurnBudgetChange: (value: { enabled: boolean; maxInputTokensPerTurn: number }) => void;
  readonly onSnooze: (minutes: number) => Promise<void>;
  readonly onClearSnooze: () => Promise<void>;
  readonly onAddIgnoredRepository: (item: RepositoryDropdownItem) => Promise<void>;
  readonly onRemoveIgnoredRepository: (repositoryId: string) => Promise<void>;
  readonly onAddTrigger: (trigger: Omit<NotificationTrigger, 'isBuiltin'>) => Promise<void>;
  readonly onUpdateTrigger: (
    triggerId: string,
    updates: Partial<NotificationTrigger>
  ) => Promise<void>;
  readonly onRemoveTrigger: (triggerId: string) => Promise<void>;
}

export const NotificationsSection = ({
  safeConfig,
  saving,
  isSnoozed,
  ignoredRepositoryItems,
  excludedRepositoryIds,
  onNotificationToggle,
  onLoopDetectionChange,
  onTurnBudgetChange,
  onSnooze,
  onClearSnooze,
  onAddIgnoredRepository,
  onRemoveIgnoredRepository,
  onAddTrigger,
  onUpdateTrigger,
  onRemoveTrigger,
}: NotificationsSectionProps): React.JSX.Element => {
  return (
    <div>
      {/* Notification Triggers */}
      <NotificationTriggerSettings
        triggers={safeConfig.notifications.triggers || []}
        saving={saving}
        onUpdateTrigger={onUpdateTrigger}
        onAddTrigger={onAddTrigger}
        onRemoveTrigger={onRemoveTrigger}
      />

      {/* Notification Settings */}
      <SettingsSectionHeader title="Notification Settings" />
      <SettingRow
        label="Enable System Notifications"
        description="Show system notifications for errors and events"
      >
        <SettingsToggle
          enabled={safeConfig.notifications.enabled}
          onChange={(v) => onNotificationToggle('enabled', v)}
          disabled={saving}
        />
      </SettingRow>
      <SettingRow label="Play sound" description="Play a sound when notifications appear">
        <SettingsToggle
          enabled={safeConfig.notifications.soundEnabled}
          onChange={(v) => onNotificationToggle('soundEnabled', v)}
          disabled={saving || !safeConfig.notifications.enabled}
        />
      </SettingRow>
      <SettingRow
        label="Include subagent errors"
        description="Detect and notify about errors in subagent sessions"
      >
        <SettingsToggle
          enabled={safeConfig.notifications.includeSubagentErrors}
          onChange={(v) => onNotificationToggle('includeSubagentErrors', v)}
          disabled={saving || !safeConfig.notifications.enabled}
        />
      </SettingRow>

      {/* Live loop detection */}
      <SettingsSectionHeader title="Loop Detection" />
      <SettingRow
        label="Detect tool-call loops"
        description="Ring the bell when a live session repeats one identical call back-to-back"
      >
        <SettingsToggle
          enabled={safeConfig.notifications.loopDetection.enabled}
          onChange={(v) =>
            onLoopDetectionChange({
              ...safeConfig.notifications.loopDetection,
              enabled: v,
            })
          }
          disabled={saving || !safeConfig.notifications.enabled}
        />
      </SettingRow>
      <SettingRow
        label="Loop threshold"
        description="Identical back-to-back calls needed to ring the bell"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm text-claude-dark-text-secondary">
            {safeConfig.notifications.loopDetection.cycleThreshold}×
          </span>
          <input
            type="number"
            min={1}
            step={1}
            value={safeConfig.notifications.loopDetection.cycleThreshold}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              if (Number.isInteger(n) && n >= 1) {
                onLoopDetectionChange({
                  ...safeConfig.notifications.loopDetection,
                  cycleThreshold: n,
                });
              }
            }}
            disabled={saving || !safeConfig.notifications.loopDetection.enabled}
            className="w-20 rounded-md border border-claude-dark-border bg-surface px-2 py-1 text-sm text-claude-dark-text"
          />
        </div>
      </SettingRow>

      {/* Per-turn input budget (PreToolUse hook) */}
      <SettingsSectionHeader title="Turn Budget" />
      <SettingRow
        label="Limit per-turn re-read spend"
        description="A Claude Code hook denies tool calls once a turn re-reads more than the budget; the agent wraps up and reports"
      >
        <SettingsToggle
          enabled={safeConfig.notifications.turnBudget.enabled}
          onChange={(v) =>
            onTurnBudgetChange({
              ...safeConfig.notifications.turnBudget,
              enabled: v,
            })
          }
          disabled={saving || !safeConfig.notifications.enabled}
        />
      </SettingRow>
      <SettingRow
        label="Input tokens per turn"
        description="Corpus-calibrated default: your historical p95 is ~12.6M"
      >
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={100000}
            step={500000}
            value={safeConfig.notifications.turnBudget.maxInputTokensPerTurn}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              if (Number.isInteger(n) && n >= 100000) {
                onTurnBudgetChange({
                  ...safeConfig.notifications.turnBudget,
                  maxInputTokensPerTurn: n,
                });
              }
            }}
            disabled={saving || !safeConfig.notifications.turnBudget.enabled}
            className="w-32 rounded-md border border-claude-dark-border bg-surface px-2 py-1 text-sm text-claude-dark-text"
          />
        </div>
      </SettingRow>

      <SettingRow
        label="Snooze notifications"
        description={
          isSnoozed
            ? `Snoozed until ${new Date(safeConfig.notifications.snoozedUntil!).toLocaleTimeString()}`
            : 'Temporarily pause notifications'
        }
      >
        <div className="flex items-center gap-2">
          {isSnoozed ? (
            <button
              onClick={onClearSnooze}
              disabled={saving}
              className={`rounded-md bg-red-500/10 px-3 py-1.5 text-sm font-medium text-red-400 transition-all duration-150 hover:bg-red-500/20 ${saving ? 'cursor-not-allowed opacity-50' : ''} `}
            >
              Clear Snooze
            </button>
          ) : (
            <SettingsSelect
              value={0}
              options={[{ value: 0, label: 'Select duration...' }, ...SNOOZE_OPTIONS]}
              onChange={(v) => v !== 0 && onSnooze(v)}
              disabled={saving || !safeConfig.notifications.enabled}
              dropUp
            />
          )}
        </div>
      </SettingRow>

      <SettingsSectionHeader title="Ignored Repositories" />
      <p className="mb-3 text-xs" style={{ color: 'var(--color-text-muted)' }}>
        Notifications from these repositories will be ignored
      </p>
      {ignoredRepositoryItems.length > 0 ? (
        <div className="mb-3">
          {ignoredRepositoryItems.map((item) => (
            <SelectedRepositoryItem
              key={item.id}
              item={item}
              onRemove={() => onRemoveIgnoredRepository(item.id)}
              disabled={saving}
            />
          ))}
        </div>
      ) : (
        <div
          className="mb-3 rounded-md border border-dashed py-3 text-center"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
            No repositories ignored
          </p>
        </div>
      )}
      <RepositoryDropdown
        onSelect={onAddIgnoredRepository}
        excludeIds={excludedRepositoryIds}
        placeholder="Select repository to ignore..."
        disabled={saving}
        dropUp
      />
    </div>
  );
};
