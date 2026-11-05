/**
 * NotificationsSection - Notification settings including triggers and ignored repositories.
 */

import { useState } from 'react';

import {
  RepositoryDropdown,
  SelectedRepositoryItem,
} from '@renderer/components/common/RepositoryDropdown';
import { MIN_TURN_BUDGET } from '@shared/turnAccounting';

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

/** Toggle-row's numeric sibling: label/description + prefixed number input
 * (the loop/budget/silence threshold controls differ only in these props). */
const ThresholdRow = (props: {
  label: string;
  description: string;
  value: number;
  min: number;
  step: number;
  suffix?: string;
  widthClassName?: string;
  disabled: boolean;
  onChange: (value: number) => void;
}): JSX.Element => {
  const {
    label,
    description,
    value,
    min,
    step,
    suffix = '',
    widthClassName = 'w-20',
    disabled,
    onChange,
  } = props;
  return (
    <SettingRow label={label} description={description}>
      <div className="flex items-center gap-2">
        {suffix !== '' && (
          <span className="text-sm text-claude-dark-text-secondary">
            {value}
            {suffix}
          </span>
        )}
        <input
          type="number"
          min={min}
          step={step}
          value={value}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            if (Number.isInteger(n) && n >= min) onChange(n);
          }}
          disabled={disabled}
          className={`${widthClassName} rounded-md border border-claude-dark-border bg-surface px-2 py-1 text-sm text-claude-dark-text`}
        />
      </div>
    </SettingRow>
  );
};

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
  readonly onTurnBudgetChange: (value: {
    enabled: boolean;
    maxInputTokensPerTurn: number;
    enforce?: boolean;
  }) => void;
  readonly onSilenceChange: (value: { enabled: boolean; silenceMinutes: number }) => void;
  readonly onSubagentWatchChange: (value: {
    enabled: boolean;
    minutes: number;
    tokens: number;
    autoStop?: boolean;
  }) => void;
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
  onSilenceChange,
  onSubagentWatchChange,
  onSnooze,
  onClearSnooze,
  onAddIgnoredRepository,
  onRemoveIgnoredRepository,
  onAddTrigger,
  onUpdateTrigger,
  onRemoveTrigger,
}: NotificationsSectionProps): React.JSX.Element => {
  // draft state: type freely — commit only valid values, revert on blur
  const [budgetDraft, setBudgetDraft] = useState<string | null>(null);
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
      <ThresholdRow
        label="Loop threshold"
        description="Identical back-to-back calls needed to ring the bell"
        value={safeConfig.notifications.loopDetection.cycleThreshold}
        min={1}
        step={1}
        suffix="×"
        disabled={saving || !safeConfig.notifications.loopDetection.enabled}
        onChange={(n) =>
          onLoopDetectionChange({ ...safeConfig.notifications.loopDetection, cycleThreshold: n })
        }
      />

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
        description="Corpus-calibrated default (request-deduped): your historical p95 is ~6.7M"
      >
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={MIN_TURN_BUDGET}
            step={500000}
            value={budgetDraft ?? safeConfig.notifications.turnBudget.maxInputTokensPerTurn}
            onChange={(e) => {
              const raw = e.target.value;
              setBudgetDraft(raw);
              const n = parseInt(raw, 10);
              if (Number.isInteger(n) && n >= MIN_TURN_BUDGET) {
                onTurnBudgetChange({
                  ...safeConfig.notifications.turnBudget,
                  maxInputTokensPerTurn: n,
                });
              }
            }}
            onBlur={() => setBudgetDraft(null)}
            disabled={saving || !safeConfig.notifications.turnBudget.enabled}
            className="w-32 rounded-md border border-claude-dark-border bg-surface px-2 py-1 text-sm text-claude-dark-text"
          />
        </div>
      </SettingRow>

      {/* Silence bell (FileWatcher catch-up tick) */}
      <SettingsSectionHeader title="Silence Detection" />
      <SettingRow
        label="Ring when a session goes silent"
        description="No transcript writes for N minutes on a session that was recently active"
      >
        <SettingsToggle
          enabled={safeConfig.notifications.silenceDetection.enabled}
          onChange={(v) =>
            onSilenceChange({
              ...safeConfig.notifications.silenceDetection,
              enabled: v,
            })
          }
          disabled={saving || !safeConfig.notifications.enabled}
        />
      </SettingRow>
      <ThresholdRow
        label="Silence threshold"
        description="Minutes of no writes before the bell rings"
        value={safeConfig.notifications.silenceDetection.silenceMinutes}
        min={1}
        step={5}
        suffix=" min"
        disabled={saving || !safeConfig.notifications.silenceDetection.enabled}
        onChange={(n) =>
          onSilenceChange({ ...safeConfig.notifications.silenceDetection, silenceMinutes: n })
        }
      />

      {/* Subagent runaway watch (FileWatcher subagent feeds) */}
      <SettingsSectionHeader title="Subagent Watch" />
      <SettingRow
        label="Ring when a subagent runs away"
        description="Subagent transcript running past the span or burning past the token threshold"
      >
        <SettingsToggle
          enabled={safeConfig.notifications.subagentWatch.enabled}
          onChange={(v) =>
            onSubagentWatchChange({
              ...safeConfig.notifications.subagentWatch,
              enabled: v,
            })
          }
          disabled={saving || !safeConfig.notifications.enabled}
        />
      </SettingRow>
      <ThresholdRow
        label="Span threshold"
        description="Minutes a subagent transcript keeps growing before the bell"
        value={safeConfig.notifications.subagentWatch.minutes}
        min={1}
        step={5}
        suffix=" min"
        disabled={saving || !safeConfig.notifications.subagentWatch.enabled}
        onChange={(n) =>
          onSubagentWatchChange({ ...safeConfig.notifications.subagentWatch, minutes: n })
        }
      />
      <ThresholdRow
        label="Burn threshold"
        description="Billed tokens (in+out) before the bell"
        value={safeConfig.notifications.subagentWatch.tokens}
        min={100000}
        step={1000000}
        suffix=" tokens"
        disabled={saving || !safeConfig.notifications.subagentWatch.enabled}
        onChange={(n) =>
          onSubagentWatchChange({ ...safeConfig.notifications.subagentWatch, tokens: n })
        }
      />
      <SettingRow
        label="Auto-stop runaway subagents"
        description="After the bell, steer the parent session (via its inbox socket) to stop the subagent if it keeps growing. Needs the session to run this project's hooks."
      >
        <SettingsToggle
          enabled={safeConfig.notifications.subagentWatch.autoStop === true}
          onChange={(v) =>
            onSubagentWatchChange({
              ...safeConfig.notifications.subagentWatch,
              autoStop: v,
            })
          }
          disabled={saving || !safeConfig.notifications.subagentWatch.enabled}
        />
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
