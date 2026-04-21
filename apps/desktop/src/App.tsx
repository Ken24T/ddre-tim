import { useEffect, useEffectEvent, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import type { Activity, ActivityDraft, ActivityEvent, DashboardActivityDepartmentBreakdownRow, DashboardNote, Department, UserSettings, UserSettingsUpdate } from "@ddre/contracts";
import { fetchActivityCatalog, fetchDashboardSnapshot, fetchHealth, fetchUserSettings, getApiBaseUrl, saveUserSettings, sendSyncBatch, type HealthPayload } from "./desktopClient.js";
import {
  flushDesktopOutbox,
  getDesktopAutostartState,
  getDesktopContext,
  getDesktopOutboxStatus,
  listenForTrayEvents,
  queueDesktopEvent,
  setDesktopAutostartEnabled,
  syncNativeTray,
  type AutostartState,
  type DesktopContext,
  type OutboxStatus,
  type TrayMenuEvent
} from "./nativeDesktop.js";
import { activeTrayPlatform, trayPlatforms, type DesktopPlatformId } from "./trayPlatforms.js";

type HealthState =
  | { phase: "loading" }
  | { phase: "ready"; payload: HealthPayload }
  | { phase: "error"; message: string };

type SettingsState =
  | { phase: "loading" }
  | { phase: "refreshing"; data: UserSettings }
  | { phase: "ready"; data: UserSettings }
  | { phase: "saving"; data: UserSettings }
  | { phase: "error"; message: string };

type SyncState =
  | { phase: "idle"; message: string }
  | { phase: "sending"; message: string }
  | { phase: "ready"; message: string; at: string }
  | { phase: "error"; message: string };

type RecentItem = {
  id: string;
  sourceEventId: string;
  title: string;
  subtitle: string;
  timestamp: string;
  status: "queued" | "sent" | "failed";
  eventType: "activity-selected" | "activity-cleared" | "note-added";
  activityId?: string;
  activityName?: string;
  note?: string;
  history: RecentItemHistoryEntry[];
};

type RecentItemHistoryEntry = {
  kind: "corrected" | "deleted";
  at: string;
  previousActivityName?: string;
  nextActivityName?: string;
  previousNoteText?: string;
  nextNoteText?: string;
};

type TimedActivitySection = {
  id: string;
  label: string;
  kind: "department" | "shared";
  activities: Activity[];
};

type RecentActivityRollupState =
  | { phase: "loading" }
  | { phase: "refreshing"; rows: DashboardActivityDepartmentBreakdownRow[]; notes: DashboardNote[] }
  | { phase: "ready"; rows: DashboardActivityDepartmentBreakdownRow[]; notes: DashboardNote[] }
  | { phase: "error"; message: string };

const defaultUserId = "cinnamon-local-user";
const userIdStorageKey = "ddre.desktop.user-id";
const noteStorageKey = "ddre.desktop.last-note";
const recentActivitiesStorageKeyPrefix = "ddre.desktop.recent-activities";
const sharedAcrossDepartmentsSectionId = "shared-across-departments";
const defaultOutboxStatus: OutboxStatus = {
  pendingCount: 0,
  lastSyncedAt: null,
  lastError: null
};
const defaultAutostartState: AutostartState = {
  enabled: false,
  available: false,
  detail: "Autostart is available when the native Tauri host is running."
};

function getStoredValue(key: string, fallback: string): string {
  if (typeof window === "undefined") {
    return fallback;
  }

  return window.localStorage.getItem(key) ?? fallback;
}

function getRecentActivitiesStorageKey(userId: string): string {
  return `${recentActivitiesStorageKeyPrefix}:${userId}`;
}

function getStoredRecentItems(userId: string): RecentItem[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const rawValue = window.localStorage.getItem(getRecentActivitiesStorageKey(userId));

    if (!rawValue) {
      return [];
    }

    const parsed = JSON.parse(rawValue) as unknown;

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object") {
        return [];
      }

      const item = entry as Partial<RecentItem>;
      const status = item.status;
      const inferredEventType = typeof item.eventType === "string"
        ? item.eventType
        : item.title === "Moved to Not Timed"
          ? "activity-cleared"
          : item.title?.startsWith("Selected ")
            ? "activity-selected"
            : item.title === "Note added"
              ? "note-added"
            : null;
      const inferredActivityName = typeof item.activityName === "string"
        ? item.activityName
        : item.title === "Moved to Not Timed"
          ? "Not Timed"
          : item.title?.startsWith("Selected ")
            ? item.title.slice("Selected ".length)
            : undefined;

      if (
        typeof item.id !== "string"
        || typeof item.title !== "string"
        || typeof item.subtitle !== "string"
        || typeof item.timestamp !== "string"
        || (status !== "queued" && status !== "sent" && status !== "failed")
        || (inferredEventType !== "activity-selected" && inferredEventType !== "activity-cleared" && inferredEventType !== "note-added")
      ) {
        return [];
      }

      const history = Array.isArray(item.history)
        ? item.history.flatMap((historyEntry) => {
          if (!historyEntry || typeof historyEntry !== "object") {
            return [];
          }

          const typedEntry = historyEntry as Partial<RecentItemHistoryEntry>;

          if (
            (typedEntry.kind !== "corrected" && typedEntry.kind !== "deleted")
            || typeof typedEntry.at !== "string"
          ) {
            return [];
          }

          return [{
            kind: typedEntry.kind,
            at: typedEntry.at,
            previousActivityName: typeof typedEntry.previousActivityName === "string" ? typedEntry.previousActivityName : undefined,
            nextActivityName: typeof typedEntry.nextActivityName === "string" ? typedEntry.nextActivityName : undefined,
            previousNoteText: typeof typedEntry.previousNoteText === "string" ? typedEntry.previousNoteText : undefined,
            nextNoteText: typeof typedEntry.nextNoteText === "string" ? typedEntry.nextNoteText : undefined
          }];
        })
        : [];

      return [{
        id: item.id,
        sourceEventId: typeof item.sourceEventId === "string" ? item.sourceEventId : item.id,
        title: item.title,
        subtitle: item.subtitle,
        timestamp: item.timestamp,
        status,
        eventType: inferredEventType,
        activityId: typeof item.activityId === "string" ? item.activityId : undefined,
        activityName: inferredActivityName,
        note: typeof item.note === "string" ? item.note : undefined,
        history
      }];
    }).slice(0, 6);
  } catch {
    return [];
  }
}

function isRecentItemDeleted(item: RecentItem): boolean {
  return item.history.some((entry) => entry.kind === "deleted");
}

function hasRecentItemCorrections(item: RecentItem): boolean {
  return item.history.some((entry) => entry.kind === "corrected");
}

function formatHistorySnippet(value: string | undefined): string {
  if (!value) {
    return "note";
  }

  return value.length > 48 ? `${value.slice(0, 48).trimEnd()}...` : value;
}

function formatRecentItemHistoryEntry(entry: RecentItemHistoryEntry): string {
  if (entry.previousNoteText || entry.nextNoteText) {
    if (entry.kind === "deleted") {
      return `Deleted note "${formatHistorySnippet(entry.previousNoteText)}" at ${formatTimestamp(entry.at)}.`;
    }

    return `Corrected note from "${formatHistorySnippet(entry.previousNoteText)}" to "${formatHistorySnippet(entry.nextNoteText)}" at ${formatTimestamp(entry.at)}.`;
  }

  if (entry.kind === "deleted") {
    return `Deleted from live history at ${formatTimestamp(entry.at)}.`;
  }

  const previousLabel = entry.previousActivityName ?? "Previous activity";
  const nextLabel = entry.nextActivityName ?? "Updated activity";

  return `Corrected from ${previousLabel} to ${nextLabel} at ${formatTimestamp(entry.at)}.`;
}

function buildRecentActivityItem(
  activity: Activity,
  occurredAt: string,
  departments: Department[],
  defaultDepartmentId: string | undefined,
  status: RecentItem["status"],
  sourceEventId: string,
  history: RecentItemHistoryEntry[] = []
): RecentItem {
  if (activity.kind === "non-timed") {
    return {
      id: sourceEventId,
      sourceEventId,
      title: "Moved to Not Timed",
      subtitle: "Timing cleared from the Cinnamon tray menu",
      timestamp: occurredAt,
      status,
      eventType: "activity-cleared",
      activityName: activity.name,
      history
    };
  }

  return {
    id: sourceEventId,
    sourceEventId,
    title: `Selected ${activity.name}`,
    subtitle: `${formatActivityDepartmentSummary(getActivityDepartmentNames(activity, departments, defaultDepartmentId))} from the tray menu`,
    timestamp: occurredAt,
    status,
    eventType: "activity-selected",
    activityId: activity.id,
    activityName: activity.name,
    history
  };
}

function buildRecentNoteItem(
  note: string,
  occurredAt: string,
  activity: Activity | undefined,
  departments: Department[],
  defaultDepartmentId: string | undefined,
  status: RecentItem["status"],
  sourceEventId: string,
  history: RecentItemHistoryEntry[] = []
): RecentItem {
  const activityName = activity?.name ?? "Not Timed";
  const departmentSummary = activity
    ? formatActivityDepartmentSummary(getActivityDepartmentNames(activity, departments, defaultDepartmentId))
    : "Default department";

  return {
    id: sourceEventId,
    sourceEventId,
    title: "Note added",
    subtitle: `For ${activityName} · ${departmentSummary}`,
    timestamp: occurredAt,
    status,
    eventType: "note-added",
    activityId: activity?.id,
    activityName,
    note,
    history
  };
}

function slugifyActivityName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function createEmptyActivityDraft(defaultDepartmentId?: string): ActivityDraft {
  return {
    name: "",
    color: undefined,
    departmentId: defaultDepartmentId,
    isActive: true
  };
}

function buildCustomActivityDrafts(
  activities: Activity[],
  sharedActivitySlugs: ReadonlySet<string>,
  defaultDepartmentId: string
): ActivityDraft[] {
  return activities
    .filter((activity) => activity.kind === "timed" && !activity.isSystem && !sharedActivitySlugs.has(activity.slug))
    .sort((left, right) => left.name.localeCompare(right.name, "en-AU"))
    .map((activity) => ({
      name: activity.name,
      color: activity.color,
      departmentId: activity.departmentId ?? activity.departmentIds?.[0] ?? defaultDepartmentId,
      isActive: activity.isActive
    }));
}

function getCustomActivityValidationMessage(
  drafts: ActivityDraft[],
  sharedActivitySlugs: ReadonlySet<string>
): string | null {
  const seenCustomSlugs = new Set<string>();

  for (const draft of drafts) {
    if (!draft.name.trim()) {
      return "Give each personal activity a name before saving.";
    }

    if (draft.color && !/^#[0-9A-Fa-f]{6}$/.test(draft.color)) {
      return "Personal activity colors must use the #RRGGBB format.";
    }

    const slug = slugifyActivityName(draft.name);

    if (slug === "not-timed") {
      return "The Not Timed fallback stays system-managed.";
    }

    if (sharedActivitySlugs.has(slug)) {
      return "Personal activity names cannot duplicate the shared tray activities.";
    }

    if (seenCustomSlugs.has(slug)) {
      return "Personal activity names must be unique.";
    }

    seenCustomSlugs.add(slug);
  }

  return null;
}

function buildSettingsUpdate(displayName: string, defaultDepartmentId: string, activities: ActivityDraft[]): UserSettingsUpdate {
  return {
    displayName,
    defaultDepartmentId,
    activities: activities.map((activity) => ({
      name: activity.name.trim(),
      color: activity.color?.trim() || undefined,
      departmentId: activity.departmentId || defaultDepartmentId,
      isActive: activity.isActive ?? true
    }))
  };
}

function createIdentifier(prefix: string): string {
  return `${prefix}-${Math.random().toString(16).slice(2, 10)}-${Date.now().toString(16)}`;
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    hour: "numeric",
    minute: "2-digit",
    day: "numeric",
    month: "short"
  }).format(new Date(value));
}

function formatHoursLabel(value: number): string {
  return `${new Intl.NumberFormat("en-AU", {
    minimumFractionDigits: value % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2
  }).format(Number(value.toFixed(2)))} h`;
}

function formatCalendarDate(value: Date): string {
  const year = value.getFullYear();
  const month = `${value.getMonth() + 1}`.padStart(2, "0");
  const day = `${value.getDate()}`.padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function formatDisplayTime(value: string | null): string {
  if (!value) {
    return "Waiting for activity selection";
  }

  return `Started ${formatTimestamp(value)}`;
}

function getActivityTone(activity: Activity | undefined): string {
  if (!activity) {
    return "#88CFC2";
  }

  return activity.color ?? (activity.kind === "non-timed" ? "#8FA0B1" : "#88CFC2");
}

function formatPendingCount(value: number): string {
  return `${value} event${value === 1 ? "" : "s"}`;
}

function getExplicitActivityDepartmentIds(activity: Pick<Activity, "departmentId" | "departmentIds">): string[] {
  if (activity.departmentIds && activity.departmentIds.length > 0) {
    return Array.from(new Set(activity.departmentIds));
  }

  if (activity.departmentId) {
    return [activity.departmentId];
  }

  return [];
}

function getActivityDepartmentNames(
  activity: Activity,
  departments: Department[],
  defaultDepartmentId: string | undefined
): string[] {
  const departmentIds = activity.departmentIds && activity.departmentIds.length > 0
    ? activity.departmentIds
    : activity.departmentId
      ? [activity.departmentId]
      : defaultDepartmentId
        ? [defaultDepartmentId]
        : [];
  const names = departmentIds.map(
    (departmentId) => departments.find((department) => department.id === departmentId)?.name ?? "Default department"
  );

  return Array.from(new Set(names));
}

function formatActivityDepartmentSummary(names: string[]): string {
  if (names.length === 0) {
    return "Default department";
  }

  if (names.length <= 2) {
    return names.join(" / ");
  }

  return `${names[0]} +${names.length - 1} more`;
}

function getTimedActivitySectionId(activity: Pick<Activity, "departmentId" | "departmentIds">): string {
  const departmentIds = getExplicitActivityDepartmentIds(activity);

  return departmentIds.length === 1 ? departmentIds[0] : sharedAcrossDepartmentsSectionId;
}

function formatTimedActivitySectionLabel(sectionId: string, departments: Department[]): string {
  if (sectionId === sharedAcrossDepartmentsSectionId) {
    return "Shared Across Departments";
  }

  return departments.find((department) => department.id === sectionId)?.name ?? "Other Activities";
}

function formatTimedActivitySectionSummary(section: TimedActivitySection): string {
  const countLabel = `${section.activities.length} ${section.activities.length === 1 ? "activity" : "activities"}`;

  if (section.kind === "shared") {
    return `${countLabel} shared across departments`;
  }

  return countLabel;
}

function groupTimedActivitiesByDepartment(
  activities: Activity[],
  departments: Department[]
): TimedActivitySection[] {
  const sections = new Map<string, TimedActivitySection>();

  for (const activity of activities) {
    const sectionId = getTimedActivitySectionId(activity);
    const existingSection = sections.get(sectionId);

    if (existingSection) {
      existingSection.activities.push(activity);
      continue;
    }

    sections.set(sectionId, {
      id: sectionId,
      label: formatTimedActivitySectionLabel(sectionId, departments),
      kind: sectionId === sharedAcrossDepartmentsSectionId ? "shared" : "department",
      activities: [activity]
    });
  }

  const sectionRank: Record<TimedActivitySection["kind"], number> = {
    department: 0,
    shared: 1
  };

  return [...sections.values()]
    .map((section) => ({
      ...section,
      activities: [...section.activities].sort((left, right) => left.name.localeCompare(right.name, "en-AU"))
    }))
    .sort((left, right) => {
      if (sectionRank[left.kind] !== sectionRank[right.kind]) {
        return sectionRank[left.kind] - sectionRank[right.kind];
      }

      return left.label.localeCompare(right.label, "en-AU");
    });
}

function isKnownTrayPlatform(value: string): value is DesktopPlatformId {
  return trayPlatforms.some((platform) => platform.id === value);
}

function formatSyncIssueField(path: unknown): string | null {
  if (!Array.isArray(path)) {
    return null;
  }

  const field = [...path]
    .reverse()
    .find((segment) => typeof segment === "string" && segment !== "events");

  if (field === "activityId") {
    return "activity";
  }

  if (field === "departmentId") {
    return "department";
  }

  if (field === "note") {
    return "note";
  }

  return typeof field === "string" ? field : null;
}

function formatSyncErrorMessage(rawMessage: string | null): string | null {
  if (!rawMessage) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawMessage) as { message?: unknown; issues?: unknown };
    const message = typeof parsed.message === "string" ? parsed.message : null;

    if (!Array.isArray(parsed.issues)) {
      return message ?? rawMessage;
    }

    const summaries = Array.from(
      new Set(
        parsed.issues.flatMap((issue) => {
          if (!issue || typeof issue !== "object") {
            return [];
          }

          const typedIssue = issue as { message?: unknown; path?: unknown };
          const issueMessage = typeof typedIssue.message === "string" ? typedIssue.message : null;
          const field = formatSyncIssueField(typedIssue.path);

          if (field && issueMessage === "Expected string, received null") {
            return [`${field} was sent empty`];
          }

          if (field && issueMessage) {
            return [`${field}: ${issueMessage}`];
          }

          if (issueMessage) {
            return [issueMessage];
          }

          return [];
        })
      )
    );

    if (summaries.length === 0) {
      return message ?? rawMessage;
    }

    const visibleSummaries = summaries.slice(0, 3);
    const overflowCount = summaries.length - visibleSummaries.length;
    const suffix = overflowCount > 0 ? `; +${overflowCount} more` : "";

    return `${message ?? "Sync failed"}: ${visibleSummaries.join("; ")}${suffix}.`;
  } catch {
    return rawMessage;
  }
}

function formatSyncError(error: unknown): string {
  if (error instanceof Error) {
    return formatSyncErrorMessage(error.message) ?? error.message;
  }

  return formatSyncErrorMessage(String(error)) ?? String(error);
}

export default function App() {
  const [userId, setUserId] = useState(() => getStoredValue(userIdStorageKey, defaultUserId));
  const [settingsReloadKey, setSettingsReloadKey] = useState(0);
  const [healthState, setHealthState] = useState<HealthState>({ phase: "loading" });
  const [settingsState, setSettingsState] = useState<SettingsState>({ phase: "loading" });
  const [syncState, setSyncState] = useState<SyncState>({ phase: "idle", message: "No tray actions have been synced yet." });
  const [displayNameDraft, setDisplayNameDraft] = useState("");
  const [defaultDepartmentIdDraft, setDefaultDepartmentIdDraft] = useState("");
  const [sharedActivitySlugs, setSharedActivitySlugs] = useState<string[]>([]);
  const [customActivityDrafts, setCustomActivityDrafts] = useState<ActivityDraft[]>([]);
  const [activitySearch, setActivitySearch] = useState("");
  const [noteDraft, setNoteDraft] = useState(() => getStoredValue(noteStorageKey, ""));
  const [currentActivityId, setCurrentActivityId] = useState<string | null>(null);
  const [currentActivityStartedAt, setCurrentActivityStartedAt] = useState<string | null>(null);
  const [recentItems, setRecentItems] = useState<RecentItem[]>(() => getStoredRecentItems(getStoredValue(userIdStorageKey, defaultUserId)));
  const [recentActivityRollupState, setRecentActivityRollupState] = useState<RecentActivityRollupState>({ phase: "loading" });
  const [editingRecentItemId, setEditingRecentItemId] = useState<string | null>(null);
  const [editingRecentActivityId, setEditingRecentActivityId] = useState("");
  const [editingRecentNoteText, setEditingRecentNoteText] = useState("");
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [desktopContext, setDesktopContext] = useState<DesktopContext | null>(null);
  const [outboxStatus, setOutboxStatus] = useState<OutboxStatus>(defaultOutboxStatus);
  const [autostartState, setAutostartState] = useState<AutostartState>(defaultAutostartState);
  const [openTimedActivitySections, setOpenTimedActivitySections] = useState<Record<string, boolean>>({});
  const trayPanelRef = useRef<HTMLElement | null>(null);
  const settingsPanelRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(userIdStorageKey, userId);
  }, [settingsReloadKey, userId]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(noteStorageKey, noteDraft);
  }, [noteDraft]);

  useEffect(() => {
    setRecentItems(getStoredRecentItems(userId));
    setEditingRecentItemId(null);
    setEditingRecentActivityId("");
    setEditingRecentNoteText("");
  }, [userId]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(getRecentActivitiesStorageKey(userId), JSON.stringify(recentItems));
  }, [recentItems, userId]);

  useEffect(() => {
    let cancelled = false;

    async function loadHealth(): Promise<void> {
      try {
        const payload = await fetchHealth();

        if (!cancelled) {
          setHealthState({ phase: "ready", payload });
        }
      } catch (error) {
        if (!cancelled) {
          setHealthState({
            phase: "error",
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }

    void loadHealth();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const today = formatCalendarDate(new Date());

    setRecentActivityRollupState((current) => {
      if (current.phase === "ready" || current.phase === "refreshing") {
        return { phase: "refreshing", rows: current.rows, notes: current.notes };
      }

      return { phase: "loading" };
    });

    async function loadRecentActivityRollup(): Promise<void> {
      try {
        const payload = await fetchDashboardSnapshot({
          from: today,
          to: today,
          userIds: [userId]
        });

        if (!cancelled) {
          setRecentActivityRollupState({
            phase: "ready",
            rows: payload.activityDepartmentBreakdown,
            notes: payload.notes
          });
        }
      } catch (error) {
        if (!cancelled) {
          setRecentActivityRollupState({
            phase: "error",
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }

    void loadRecentActivityRollup();

    return () => {
      cancelled = true;
    };
  }, [outboxStatus.lastSyncedAt, syncState.phase === "ready" ? syncState.at : null, userId]);

  useEffect(() => {
    let cancelled = false;

    setSettingsState((current) => {
      if (current.phase === "ready" || current.phase === "refreshing" || current.phase === "saving") {
        return { phase: "refreshing", data: current.data };
      }

      return { phase: "loading" };
    });

    async function loadSettings(): Promise<void> {
      try {
        const [payload, activityCatalog] = await Promise.all([
          fetchUserSettings(userId),
          fetchActivityCatalog()
        ]);
        const sharedTimedActivitySlugs = new Set(
          activityCatalog.activities
            .filter((activity) => activity.kind === "timed" && !activity.isSystem)
            .map((activity) => activity.slug)
        );

        if (!cancelled) {
          setSettingsState({ phase: "ready", data: payload });
          setDisplayNameDraft(payload.displayName);
          setDefaultDepartmentIdDraft(payload.defaultDepartmentId);
          setSharedActivitySlugs([...sharedTimedActivitySlugs].sort((left, right) => left.localeCompare(right, "en-AU")));
          setCustomActivityDrafts(buildCustomActivityDrafts(payload.activities, sharedTimedActivitySlugs, payload.defaultDepartmentId));
          setCurrentActivityId((current) => {
            if (current && payload.activities.some((activity) => activity.id === current)) {
              return current;
            }

            return payload.activities.find((activity) => activity.kind === "non-timed")?.id ?? null;
          });
        }
      } catch (error) {
        if (!cancelled) {
          setSettingsState({
            phase: "error",
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }

    void loadSettings();

    return () => {
      cancelled = true;
    };
  }, [settingsReloadKey, userId]);

  const handleTrayMenuEvent = useEffectEvent((payload: TrayMenuEvent) => {
    switch (payload.action) {
      case "open-settings": {
        settingsPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        break;
      }
      case "refresh-activities": {
        setSaveMessage(null);
        setSettingsReloadKey((current) => current + 1);
        break;
      }
      case "trigger-sync": {
        void flushNativeOutbox("Flushing the local outbox to the API.");
        break;
      }
      case "toggle-autostart": {
        void toggleAutostart();
        break;
      }
      case "select-activity": {
        const selectedActivity = allActivities.find((activity) => activity.id === payload.activityId);

        if (selectedActivity) {
          void handleActivitySelect(selectedActivity);
        }

        break;
      }
      default:
        break;
    }
  });

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    async function loadDesktopBridge(): Promise<void> {
      const context = await getDesktopContext();

      if (cancelled) {
        return;
      }

      setDesktopContext(context);

      if (!context) {
        setOutboxStatus(defaultOutboxStatus);
        setAutostartState(defaultAutostartState);
        return;
      }

      const [outbox, autostart] = await Promise.all([
        getDesktopOutboxStatus(userId),
        getDesktopAutostartState()
      ]);

      if (cancelled) {
        return;
      }

      if (outbox) {
        setOutboxStatus(outbox);
      }

      if (autostart) {
        setAutostartState(autostart);
      }

      unsubscribe = await listenForTrayEvents(context.trayChannel, handleTrayMenuEvent);

      if (cancelled) {
        unsubscribe();
      }
    }

    void loadDesktopBridge();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [userId]);

  const settings = settingsState.phase === "ready" || settingsState.phase === "refreshing" || settingsState.phase === "saving"
    ? settingsState.data
    : null;
  const departments = settings?.departments ?? [];
  const allActivities = settings?.activities ?? [];
  const activeActivities = allActivities.filter((activity) => activity.isActive);
  const menuActivities = activeActivities.filter((activity) => activity.kind === "timed");
  const nonTimedActivity = activeActivities.find((activity) => activity.kind === "non-timed") ?? allActivities.find((activity) => activity.kind === "non-timed");
  const currentActivity = activeActivities.find((activity) => activity.id === currentActivityId) ?? allActivities.find((activity) => activity.id === currentActivityId);
  const searchTerm = activitySearch.trim().toLowerCase();
  const filteredActivities = menuActivities.filter((activity) => {
    if (!searchTerm) {
      return true;
    }

    return activity.name.toLowerCase().includes(searchTerm);
  });
  const filteredActivitySections = useMemo(
    () => groupTimedActivitiesByDepartment(filteredActivities, departments),
    [departments, filteredActivities]
  );
  const timedActivitiesLocked = !settings || !settings.isConfigured;
  const selectorStatusLabel = healthState.phase === "error"
    ? "API unavailable"
    : timedActivitiesLocked
      ? "Finish setup to unlock timed capture"
      : "Select a result to start timing";
  const syncTone = syncState.phase === "error" ? "error" : outboxStatus.pendingCount > 0 || syncState.phase === "sending" ? "sending" : syncState.phase === "ready" ? "ready" : "idle";
  const syncHeading = outboxStatus.pendingCount > 0
    ? "Queued locally"
    : syncState.phase === "ready"
      ? "API synced"
      : syncState.phase === "sending"
        ? "Sending"
        : syncState.phase === "error"
          ? "Attention needed"
          : "Waiting";
  const syncDetail = syncState.phase === "ready" ? `${syncState.message} at ${formatTimestamp(syncState.at)}` : syncState.message;
  const formattedOutboxError = formatSyncErrorMessage(outboxStatus.lastError);
  const outboxTone = outboxStatus.lastError ? "error" : outboxStatus.pendingCount > 0 ? "sending" : desktopContext ? "ready" : "idle";
  const outboxHeading = desktopContext
    ? outboxStatus.pendingCount > 0
      ? `${formatPendingCount(outboxStatus.pendingCount)} queued`
      : "Outbox empty"
    : "Browser preview";
  const outboxDetail = desktopContext
    ? formattedOutboxError ?? (outboxStatus.lastSyncedAt ? `Last native flush ${formatTimestamp(outboxStatus.lastSyncedAt)}` : "Native queue is ready for tray actions.")
    : "The preview shell sends directly to the API until the Tauri host is running.";
  const runtimeTrayPlatform = desktopContext && isKnownTrayPlatform(desktopContext.platform)
    ? trayPlatforms.find((platform) => platform.id === desktopContext.platform) ?? activeTrayPlatform
    : activeTrayPlatform;
  const runningCompatibilitySlice = Boolean(desktopContext && runtimeTrayPlatform.id !== "cinnamon");
  const desktopHostLabel = desktopContext ? "Native Tauri host" : "Browser shell preview";
  const desktopHostDetail = desktopContext
    ? runningCompatibilitySlice
      ? `${runtimeTrayPlatform.label} session detected. Native tray events and the local outbox are available for validation.`
      : "Native tray events, the local outbox, and autostart are available."
    : "Browser preview only. Native tray features require the Tauri host.";
  const diagnosticsDetail = runningCompatibilitySlice
    ? `${runtimeTrayPlatform.label} diagnostics, autostart, and local test controls.`
    : "Runtime diagnostics, autostart, and local test controls.";
  const activityDepartmentFallbackId = settings?.defaultDepartmentId || defaultDepartmentIdDraft || departments[0]?.id;
  const sharedActivitySlugSet = useMemo(() => new Set(sharedActivitySlugs), [sharedActivitySlugs]);
  const customActivityValidationMessage = useMemo(
    () => getCustomActivityValidationMessage(customActivityDrafts, sharedActivitySlugSet),
    [customActivityDrafts, sharedActivitySlugSet]
  );
  const currentDepartment = departments.find((department) => department.id === (currentActivity?.departmentId ?? settings?.defaultDepartmentId));
  const currentRollupDepartmentNames = useMemo(() => {
    if (!currentActivity || currentActivity.kind !== "timed") {
      return new Set<string>();
    }

    const names = new Set<string>();

    if (currentActivity.departmentId) {
      names.add(departments.find((department) => department.id === currentActivity.departmentId)?.name ?? "Default department");
    } else {
      names.add("Default department");
    }

    if (currentDepartment?.name) {
      names.add(currentDepartment.name);
    }

    return names;
  }, [currentActivity, currentDepartment?.name, departments]);
  const currentTimedActivitySectionId = currentActivity && currentActivity.kind === "timed"
    ? getTimedActivitySectionId(currentActivity)
    : null;
  const trayActivitySections = useMemo(
    () => groupTimedActivitiesByDepartment(menuActivities, departments).map((section) => ({
      id: section.id,
      label: section.label,
      activities: section.activities.map((activity) => ({
        id: activity.id,
        label: activity.name,
        helper: formatActivityDepartmentSummary(
          getActivityDepartmentNames(activity, departments, activityDepartmentFallbackId)
        ),
        active: currentActivityId === activity.id
      }))
    })),
    [activityDepartmentFallbackId, currentActivityId, departments, menuActivities]
  );
  const forceOpenTimedActivitySections = searchTerm.length > 0;
  const hasDepartmentOptions = departments.length > 0;
  const defaultDepartmentSelectValue = hasDepartmentOptions && departments.some((department) => department.id === defaultDepartmentIdDraft)
    ? defaultDepartmentIdDraft
    : "";
  const canSaveSettings = Boolean(defaultDepartmentSelectValue)
    && displayNameDraft.trim().length > 0
    && settingsState.phase !== "loading"
    && settingsState.phase !== "saving"
    && customActivityValidationMessage === null;
  const recentTimedActivityOptions = useMemo(
    () => allActivities.filter((activity) => activity.kind === "timed" && activity.isActive),
    [allActivities]
  );
  const quickActionActivities = useMemo(() => {
    if (searchTerm) {
      return filteredActivities.slice(0, 6);
    }

    const preferredDepartmentName = currentDepartment?.name
      ?? departments.find((department) => department.id === activityDepartmentFallbackId)?.name
      ?? "Default department";

    return [...menuActivities]
      .sort((left, right) => {
        const leftDepartmentNames = getActivityDepartmentNames(left, departments, activityDepartmentFallbackId);
        const rightDepartmentNames = getActivityDepartmentNames(right, departments, activityDepartmentFallbackId);
        const leftScore = (left.id === currentActivityId ? 4 : 0) + (leftDepartmentNames.includes(preferredDepartmentName) ? 2 : 0);
        const rightScore = (right.id === currentActivityId ? 4 : 0) + (rightDepartmentNames.includes(preferredDepartmentName) ? 2 : 0);

        if (rightScore !== leftScore) {
          return rightScore - leftScore;
        }

        return left.name.localeCompare(right.name, "en-AU");
      })
      .slice(0, 6);
  }, [activityDepartmentFallbackId, currentActivityId, currentDepartment?.name, departments, filteredActivities, menuActivities, searchTerm]);
  const noteContextLabel = currentActivity?.name ?? "Not Timed";
  const noteContextDetail = currentActivityStartedAt
    ? formatDisplayTime(currentActivityStartedAt)
    : currentActivity?.kind === "non-timed"
      ? "No timer running right now"
      : "Notes stay with the current session";
  const recentActivityRollupRows = recentActivityRollupState.phase === "ready" || recentActivityRollupState.phase === "refreshing"
    ? recentActivityRollupState.rows
    : [];
  const todaysNotes = recentActivityRollupState.phase === "ready" || recentActivityRollupState.phase === "refreshing"
    ? recentActivityRollupState.notes
    : [];
  const onboardingCopy = settings?.isConfigured
    ? desktopContext
      ? runningCompatibilitySlice
        ? `${runtimeTrayPlatform.label} validation ready. Tray actions queue locally and flush through the API.`
        : "Tray capture ready. Actions queue locally and flush through the API."
      : "Browser preview ready. Use search and note capture below."
    : "Finish your name and default department below before timed capture starts.";
  const trayPanelLabel = runtimeTrayPlatform.id === "cinnamon" ? "Cinnamon tray" : `${runtimeTrayPlatform.label} tray`;

  const platformCards = useMemo(() => trayPlatforms, []);

  useEffect(() => {
    setOpenTimedActivitySections((current) => {
      const sectionIds = filteredActivitySections.map((section) => section.id);

      if (sectionIds.length === 0) {
        return Object.keys(current).length === 0 ? current : {};
      }

      const defaultOpenIds = new Set<string>();

      if (currentTimedActivitySectionId && sectionIds.includes(currentTimedActivitySectionId)) {
        defaultOpenIds.add(currentTimedActivitySectionId);
      }

      if (settings?.defaultDepartmentId && sectionIds.includes(settings.defaultDepartmentId)) {
        defaultOpenIds.add(settings.defaultDepartmentId);
      }

      if (defaultOpenIds.size === 0) {
        defaultOpenIds.add(sectionIds[0]);
      }

      let changed = false;
      const next: Record<string, boolean> = {};

      for (const sectionId of sectionIds) {
        if (sectionId in current) {
          next[sectionId] = current[sectionId] ?? false;
        } else {
          next[sectionId] = defaultOpenIds.has(sectionId);
          changed = true;
        }
      }

      if (!changed) {
        const currentIds = Object.keys(current);
        changed = currentIds.length !== sectionIds.length || currentIds.some((sectionId) => !(sectionId in next));
      }

      return changed ? next : current;
    });
  }, [currentTimedActivitySectionId, filteredActivitySections, settings?.defaultDepartmentId]);

  useEffect(() => {
    if (!desktopContext || !settings) {
      return;
    }

    const secondaryLabel = outboxStatus.pendingCount > 0
      ? `${formatPendingCount(outboxStatus.pendingCount)} queued locally`
      : syncState.phase === "ready"
        ? `Synced ${formatTimestamp(syncState.at)}`
        : syncState.message;

    void syncNativeTray({
      currentActivityLabel: currentActivity?.name ?? "Not Timed",
      secondaryLabel,
      activitySections: trayActivitySections,
      configured: settings.isConfigured,
      autostartEnabled: autostartState.enabled,
      autostartAvailable: autostartState.available
    });
  }, [
    autostartState.available,
    autostartState.enabled,
    currentActivity?.name,
    currentActivityId,
    desktopContext,
    nonTimedActivity,
    outboxStatus.pendingCount,
    settings,
    syncState,
    trayActivitySections,
    timedActivitiesLocked
  ]);

  async function refreshNativeOutbox(): Promise<OutboxStatus | null> {
    if (!desktopContext) {
      return null;
    }

    const status = await getDesktopOutboxStatus(userId);

    if (status) {
      setOutboxStatus(status);
    }

    return status;
  }

  async function flushNativeOutbox(message: string): Promise<OutboxStatus | null> {
    if (!desktopContext) {
      return null;
    }

    setSyncState({ phase: "sending", message });

    try {
      const status = await flushDesktopOutbox(getApiBaseUrl(), userId);

      if (!status) {
        throw new Error("Native flush did not return an outbox status.");
      }

      setOutboxStatus(status);
      const syncErrorMessage = formatSyncErrorMessage(status.lastError);

      if (status.pendingCount === 0) {
        setSyncState({
          phase: "ready",
          message: "Local outbox flushed to the API.",
          at: status.lastSyncedAt ?? new Date().toISOString()
        });
      } else if (syncErrorMessage) {
        setSyncState({
          phase: "error",
          message: `${syncErrorMessage} ${formatPendingCount(status.pendingCount)} still queued locally.`
        });
      } else {
        setSyncState({
          phase: "sending",
          message: `${formatPendingCount(status.pendingCount)} remain queued locally.`
        });
      }

      return status;
    } catch (error) {
      const reason = formatSyncError(error);
      const status = await refreshNativeOutbox();
      setSyncState({
        phase: "error",
        message: `${reason} Events remain in the local outbox.`
      });
      return status;
    }
  }

  async function toggleAutostart(): Promise<void> {
    if (!desktopContext || !autostartState.available) {
      return;
    }

    const nextState = await setDesktopAutostartEnabled(!autostartState.enabled);

    if (nextState) {
      setAutostartState(nextState);
    }
  }

  function resolveRecentItemActivity(item: RecentItem): Activity | undefined {
    return allActivities.find((activity) => activity.id === item.activityId)
      ?? (item.activityName
        ? allActivities.find((activity) => activity.kind === "timed" && activity.name === item.activityName)
        : undefined);
  }

  function getLatestVisibleRecentItem(items: RecentItem[]): RecentItem | undefined {
    return items.find((item) => item.eventType !== "note-added" && !isRecentItemDeleted(item));
  }

  async function postEvent(event: ActivityEvent, optimisticItem?: RecentItem): Promise<RecentItem["status"]> {
    if (optimisticItem) {
      setRecentItems((current) => [optimisticItem, ...current].slice(0, 6));
    }

    if (desktopContext) {
      setSyncState({ phase: "sending", message: "Queueing tray action locally before sync." });

      try {
        const queuedStatus = await queueDesktopEvent(userId, event);

        if (!queuedStatus) {
          throw new Error("Native outbox did not return a queue status.");
        }

        setOutboxStatus(queuedStatus);
        if (optimisticItem) {
          setRecentItems((current) =>
            current.map((item) => (item.id === optimisticItem.id ? { ...item, status: "queued" } : item))
          );
        }

        const flushedStatus = await flushNativeOutbox("Queued tray action locally. Attempting sync.");
        const delivered = flushedStatus && flushedStatus.pendingCount === 0;

        if (optimisticItem) {
          setRecentItems((current) =>
            current.map((item) => {
              if (item.id !== optimisticItem.id) {
                return item;
              }

              return {
                ...item,
                status: delivered ? "sent" : "queued"
              };
            })
          );
        }

        return delivered ? "sent" : "queued";
      } catch (error) {
        if (optimisticItem) {
          setRecentItems((current) =>
            current.map((item) => (item.id === optimisticItem.id ? { ...item, status: "failed" } : item))
          );
        }
        setSyncState({
          phase: "error",
          message: formatSyncError(error)
        });

        return "failed";
      }
    }

    setSyncState({ phase: "sending", message: "Sending tray action to the API." });

    try {
      const ack = await sendSyncBatch({
        batchId: createIdentifier("batch"),
        userId,
        deviceId: runtimeTrayPlatform.id,
        sentAt: new Date().toISOString(),
        events: [event]
      });

      if (optimisticItem) {
        setRecentItems((current) =>
          current.map((item) => (item.id === optimisticItem.id ? { ...item, status: "sent" } : item))
        );
      }
      setSyncState({
        phase: "ready",
        message: `${ack.acceptedEventIds.length} event acknowledged by the API.`,
        at: ack.receivedAt
      });

      return "sent";
    } catch (error) {
      if (optimisticItem) {
        setRecentItems((current) =>
          current.map((item) => (item.id === optimisticItem.id ? { ...item, status: "failed" } : item))
        );
      }
      setSyncState({
        phase: "error",
        message: formatSyncError(error)
      });

      return "failed";
    }
  }

  async function handleActivitySelect(activity: Activity): Promise<void> {
    if (timedActivitiesLocked && activity.kind === "timed") {
      return;
    }

    const occurredAt = new Date().toISOString();
    const nextCurrentActivityId = activity.id;
    const nextEvent: ActivityEvent = activity.kind === "non-timed"
      ? {
          eventId: createIdentifier("event"),
          userId,
          deviceId: runtimeTrayPlatform.id,
          occurredAt,
          recordedAt: occurredAt,
          type: "activity-cleared",
          idempotencyKey: createIdentifier("idempotency"),
          metadata: {
            target: activity.name,
            platform: runtimeTrayPlatform.id
          }
        }
      : {
          eventId: createIdentifier("event"),
          userId,
          deviceId: runtimeTrayPlatform.id,
          occurredAt,
          recordedAt: occurredAt,
          type: "activity-selected",
          activityId: activity.id,
          departmentId: activity.departmentId,
          idempotencyKey: createIdentifier("idempotency"),
          metadata: {
            activityName: activity.name,
            platform: runtimeTrayPlatform.id
          }
        };

    setCurrentActivityId(nextCurrentActivityId);
    setCurrentActivityStartedAt(occurredAt);

    await postEvent(
      nextEvent,
      buildRecentActivityItem(activity, occurredAt, departments, activityDepartmentFallbackId, "sent", nextEvent.eventId)
    );
  }

  async function handleNoteSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (!noteDraft.trim()) {
      return;
    }

    const occurredAt = new Date().toISOString();
    const noteEvent: ActivityEvent = {
      eventId: createIdentifier("event"),
      userId,
      deviceId: runtimeTrayPlatform.id,
      occurredAt,
      recordedAt: occurredAt,
      type: "note-added",
      note: noteDraft.trim(),
      idempotencyKey: createIdentifier("idempotency"),
      metadata: {
        platform: runtimeTrayPlatform.id,
        currentActivityId: currentActivityId ?? "none"
      }
    };

    const submittedNote = noteDraft.trim();
    setNoteDraft("");

    await postEvent(
      noteEvent,
      buildRecentNoteItem(
        submittedNote,
        occurredAt,
        currentActivity ?? nonTimedActivity,
        departments,
        activityDepartmentFallbackId,
        "sent",
        noteEvent.eventId
      )
    );
  }

  async function handleRecentItemEditSave(item: RecentItem): Promise<void> {
    if (item.eventType === "note-added") {
      const nextNoteText = editingRecentNoteText.trim();

      if (!nextNoteText || nextNoteText === item.note?.trim()) {
        return;
      }

      const occurredAt = new Date().toISOString();
      const correctionEvent: ActivityEvent = {
        eventId: createIdentifier("event"),
        userId,
        deviceId: runtimeTrayPlatform.id,
        occurredAt,
        recordedAt: occurredAt,
        type: "note-corrected",
        note: nextNoteText,
        relatedEventId: item.sourceEventId,
        idempotencyKey: createIdentifier("idempotency"),
        metadata: {
          platform: runtimeTrayPlatform.id,
          currentActivityId: item.activityId ?? "none"
        }
      };

      const result = await postEvent(correctionEvent);

      if (result === "failed") {
        return;
      }

      const correctionHistoryEntry: RecentItemHistoryEntry = {
        kind: "corrected",
        at: occurredAt,
        previousNoteText: item.note,
        nextNoteText: nextNoteText
      };

      setRecentItems((current) => current.map((currentItem) => {
        if (currentItem.id !== item.id) {
          return currentItem;
        }

        return buildRecentNoteItem(
          nextNoteText,
          item.timestamp,
          resolveRecentItemActivity(item),
          departments,
          activityDepartmentFallbackId,
          result,
          item.sourceEventId,
          [...currentItem.history, correctionHistoryEntry]
        );
      }));
      setEditingRecentItemId(null);
      setEditingRecentActivityId("");
      setEditingRecentNoteText("");
      return;
    }

    const nextActivity = recentTimedActivityOptions.find((activity) => activity.id === editingRecentActivityId);

    if (!nextActivity) {
      return;
    }

    const occurredAt = new Date().toISOString();
    const correctionEvent: ActivityEvent = {
      eventId: createIdentifier("event"),
      userId,
      deviceId: runtimeTrayPlatform.id,
      occurredAt,
      recordedAt: occurredAt,
      type: "activity-corrected",
      activityId: nextActivity.id,
      departmentId: nextActivity.departmentId,
      relatedEventId: item.sourceEventId,
      idempotencyKey: createIdentifier("idempotency"),
      metadata: {
        activityName: nextActivity.name,
        platform: runtimeTrayPlatform.id
      }
    };

    const result = await postEvent(correctionEvent);

    if (result === "failed") {
      return;
    }

    const correctionHistoryEntry: RecentItemHistoryEntry = {
      kind: "corrected",
      at: occurredAt,
      previousActivityName: item.activityName,
      nextActivityName: nextActivity.name
    };

    setRecentItems((current) => current.map((currentItem) => {
      if (currentItem.id !== item.id) {
        return currentItem;
      }

      return buildRecentActivityItem(
        nextActivity,
        item.timestamp,
        departments,
        activityDepartmentFallbackId,
        result,
        item.sourceEventId,
        [...currentItem.history, correctionHistoryEntry]
      );
    }));
    setEditingRecentItemId(null);
    setEditingRecentActivityId("");
    setEditingRecentNoteText("");

    if (getLatestVisibleRecentItem(recentItems)?.id === item.id) {
      setCurrentActivityId(nextActivity.id);
      setCurrentActivityStartedAt(item.timestamp);
    }
  }

  async function handleRecentItemDelete(item: RecentItem): Promise<void> {
    const occurredAt = new Date().toISOString();
    const deleteEvent: ActivityEvent = {
      eventId: createIdentifier("event"),
      userId,
      deviceId: runtimeTrayPlatform.id,
      occurredAt,
      recordedAt: occurredAt,
      type: item.eventType === "note-added" ? "note-deleted" : "activity-deleted",
      relatedEventId: item.sourceEventId,
      idempotencyKey: createIdentifier("idempotency"),
      metadata: {
        activityName: item.activityName ?? item.title,
        platform: runtimeTrayPlatform.id
      }
    };

    const result = await postEvent(deleteEvent);

    if (result === "failed") {
      return;
    }

    const deleteHistoryEntry: RecentItemHistoryEntry = {
      kind: "deleted",
      at: occurredAt,
      previousActivityName: item.activityName,
      previousNoteText: item.note
    };

    const updatedItems = recentItems.map((currentItem) => {
      if (currentItem.id !== item.id) {
        return currentItem;
      }

      return {
        ...currentItem,
        status: result,
        history: [...currentItem.history, deleteHistoryEntry]
      };
    });
    setRecentItems(updatedItems);

    if (editingRecentItemId === item.id) {
      setEditingRecentItemId(null);
      setEditingRecentActivityId("");
      setEditingRecentNoteText("");
    }

    if (getLatestVisibleRecentItem(recentItems)?.id === item.id) {
      const fallbackItem = getLatestVisibleRecentItem(updatedItems);
      const fallbackActivity = fallbackItem ? resolveRecentItemActivity(fallbackItem) : undefined;

      if (fallbackItem?.eventType === "activity-selected" && fallbackActivity) {
        setCurrentActivityId(fallbackActivity.id);
        setCurrentActivityStartedAt(fallbackItem.timestamp);
      } else {
        setCurrentActivityId(nonTimedActivity?.id ?? null);
        setCurrentActivityStartedAt(fallbackItem?.timestamp ?? null);
      }
    }
  }

  async function handleSaveSettings(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (!settings) {
      return;
    }

    setSaveMessage(null);
    setSettingsState({ phase: "saving", data: settings });

    try {
      const payload = await saveUserSettings(
        userId,
        buildSettingsUpdate(displayNameDraft, defaultDepartmentIdDraft, customActivityDrafts)
      );

      setSettingsState({ phase: "ready", data: payload });
      setDisplayNameDraft(payload.displayName);
      setDefaultDepartmentIdDraft(payload.defaultDepartmentId);
      setCustomActivityDrafts(buildCustomActivityDrafts(payload.activities, sharedActivitySlugSet, payload.defaultDepartmentId));
      setSaveMessage(`Settings saved. ${runtimeTrayPlatform.label} tray capture is ready with ${customActivityDrafts.length} personal activit${customActivityDrafts.length === 1 ? "y" : "ies"}.`);
    } catch (error) {
      setSettingsState({
        phase: "error",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return (
    <main className="shell">
      <section className="hero panel">
        <div className="hero-copy">
          <p className="eyebrow">Desktop capture</p>
          <h1>{runningCompatibilitySlice ? `${runtimeTrayPlatform.label} Tray Shell` : "Cinnamon Tray Shell"}</h1>
          <p className="lead">{onboardingCopy}</p>
        </div>
      </section>

      <section className="panel settings-panel" ref={settingsPanelRef}>
        <div className="settings-header">
          <div>
            <p className="panel-label">User settings</p>
            <h2>{settings?.isConfigured ? "Edit tray settings" : "First-run setup"}</h2>
          </div>
          <small>{settingsState.phase === "saving" ? "Saving to the API..." : saveMessage ?? "Saved to the API and mirrored into the tray."}</small>
        </div>

        {settingsState.phase === "error" ? (
          <div className="settings-error-row">
            <p className="error-copy">{settingsState.message}</p>
            <button
              className="button"
              onClick={() => {
                setSaveMessage(null);
                setSettingsReloadKey((current) => current + 1);
              }}
              type="button"
            >
              Retry settings load
            </button>
          </div>
        ) : null}

        <form className="settings-form" onSubmit={(event) => { void handleSaveSettings(event); }}>
          <label className="field">
            <span>Display name</span>
            <input
              maxLength={100}
              onChange={(event) => {
                setDisplayNameDraft(event.target.value);
              }}
              placeholder="Enter the user’s name"
              type="text"
              value={displayNameDraft}
            />
          </label>

          <label className="field">
            <span>Default department</span>
            <select
              disabled={!hasDepartmentOptions || settingsState.phase === "loading" || settingsState.phase === "refreshing" || settingsState.phase === "saving"}
              onChange={(event) => {
                setDefaultDepartmentIdDraft(event.target.value);
              }}
              value={defaultDepartmentSelectValue}
            >
              <option value="" disabled>
                {settingsState.phase === "error"
                  ? "Retry settings load to see departments"
                  : settingsState.phase === "loading" || settingsState.phase === "refreshing"
                    ? "Loading departments..."
                    : hasDepartmentOptions
                      ? "Select a default department"
                      : "No departments available"}
              </option>
              {departments.map((department) => (
                <option key={department.id} value={department.id}>{department.name}</option>
              ))}
            </select>
          </label>

          <section className="draft-activity-section">
            <div className="draft-activity-toolbar">
              <div>
                <p className="panel-label">Personal timed activities</p>
                <p className="field-help">These stay private to this user and sit alongside the {sharedActivitySlugs.length} shared tray activities.</p>
              </div>
              <button
                className="button"
                disabled={!hasDepartmentOptions || settingsState.phase === "loading" || settingsState.phase === "saving"}
                onClick={() => {
                  setCustomActivityDrafts((current) => [
                    ...current,
                    createEmptyActivityDraft(defaultDepartmentIdDraft || departments[0]?.id)
                  ]);
                }}
                type="button"
              >
                Add personal activity
              </button>
            </div>

            <div className="draft-activity-list">
              {customActivityDrafts.length > 0 ? customActivityDrafts.map((activity, index) => (
                <div className="draft-activity-row" key={`draft-activity-${index}`}> 
                  <label className="field">
                    <span>Name</span>
                    <input
                      maxLength={100}
                      onChange={(event) => {
                        const nextName = event.target.value;
                        setCustomActivityDrafts((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, name: nextName } : item));
                      }}
                      placeholder="Enter an activity name"
                      type="text"
                      value={activity.name}
                    />
                  </label>

                  <label className="field">
                    <span>Department</span>
                    <select
                      disabled={!hasDepartmentOptions}
                      onChange={(event) => {
                        const nextDepartmentId = event.target.value;
                        setCustomActivityDrafts((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, departmentId: nextDepartmentId } : item));
                      }}
                      value={activity.departmentId ?? defaultDepartmentIdDraft}
                    >
                      {departments.map((department) => (
                        <option key={`${department.id}-${index}`} value={department.id}>{department.name}</option>
                      ))}
                    </select>
                  </label>

                  <label className="field color-field">
                    <span>Color</span>
                    <input
                      onChange={(event) => {
                        const nextColor = event.target.value;
                        setCustomActivityDrafts((current) => current.map((item, itemIndex) => itemIndex === index ? {
                          ...item,
                          color: nextColor.trim() || undefined
                        } : item));
                      }}
                      placeholder="#6EA6CF"
                      type="text"
                      value={activity.color ?? ""}
                    />
                  </label>

                  <label className="toggle-field">
                    <input
                      checked={activity.isActive ?? true}
                      onChange={(event) => {
                        const nextChecked = event.target.checked;
                        setCustomActivityDrafts((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, isActive: nextChecked } : item));
                      }}
                      type="checkbox"
                    />
                    <span>Active in tray</span>
                  </label>

                  <button
                    className="button button-danger"
                    onClick={() => {
                      setCustomActivityDrafts((current) => current.filter((_, itemIndex) => itemIndex !== index));
                    }}
                    type="button"
                  >
                    Remove
                  </button>
                </div>
              )) : <p className="empty-copy">No personal timed activities yet. Add one here and it will appear in the tray after saving.</p>}
            </div>

            <p className={customActivityValidationMessage ? "error-copy" : "field-help"}>
              {customActivityValidationMessage ?? "Use this section for user-specific tray activities that should not live in the shared dashboard catalog."}
            </p>
          </section>

          <div className="settings-actions">
            <button className="button button-primary" disabled={!canSaveSettings} type="submit">
              {settingsState.phase === "saving" ? "Saving..." : settings?.isConfigured ? "Save settings" : "Finish setup"}
            </button>
          </div>
        </form>
      </section>

      <details className="diagnostics-panel panel">
        <summary className="diagnostics-summary">
          <div>
            <p className="eyebrow">Diagnostics</p>
            <strong>Runtime details</strong>
            <small>{diagnosticsDetail}</small>
          </div>
        </summary>

        <div className="diagnostics-body">
          <div className="hero-meta diagnostics-grid">
            <div className={`meta-card is-${syncTone}`}>
              <span>Sync status</span>
              <strong>{syncHeading}</strong>
              <small>{syncDetail}</small>
            </div>

            <div className={`meta-card is-${outboxTone}`}>
              <span>Local outbox</span>
              <strong>{outboxHeading}</strong>
              <small>{outboxDetail}</small>
              <div className="meta-card-actions">
                <button
                  className="button"
                  disabled={!desktopContext}
                  onClick={() => {
                    void flushNativeOutbox("Flushing the local outbox to the API.");
                  }}
                  type="button"
                >
                  Flush outbox
                </button>
              </div>
            </div>

            <div className="meta-card">
              <span>Desktop host</span>
              <strong>{desktopHostLabel}</strong>
              <small>{desktopHostDetail}</small>
            </div>

            <div className="meta-card">
              <span>Tray platform</span>
              <strong>{runtimeTrayPlatform.label}</strong>
              <small>{runningCompatibilitySlice ? "Detected from the native desktop session" : runtimeTrayPlatform.helper}</small>
            </div>

            <div className="meta-card">
              <span>Session autostart</span>
              <strong>{autostartState.enabled ? "Enabled" : autostartState.available ? "Disabled" : "Unavailable"}</strong>
              <small>{autostartState.detail}</small>
              <div className="meta-card-actions">
                <button
                  className="button"
                  disabled={!desktopContext || !autostartState.available}
                  onClick={() => {
                    void toggleAutostart();
                  }}
                  type="button"
                >
                  {autostartState.enabled ? "Disable autostart" : "Enable autostart"}
                </button>
              </div>
            </div>

            <div className="meta-card">
              <span>Local user key</span>
              <label>
                <input
                  onChange={(event) => {
                    setUserId(event.target.value.trim() || defaultUserId);
                  }}
                  type="text"
                  value={userId}
                />
              </label>
              <small>Use different keys locally to preview multiple desktop users.</small>
            </div>
          </div>

          <section className="platform-grid diagnostics-platform-grid">
            {platformCards.map((platform) => (
              <article className={`platform-card panel${platform.id === runtimeTrayPlatform.id ? " is-active" : ""}`} key={platform.id}>
                <div className="platform-card-header">
                  <img alt={`${platform.label} tray icon`} className="platform-icon" src={platform.iconAsset} />
                  <div>
                    <p className="panel-label">{platform.id === runtimeTrayPlatform.id && desktopContext ? "Active session" : platform.status === "current" ? "Current slice" : "Queued platform"}</p>
                    <h2>{platform.label}</h2>
                  </div>
                </div>
                <p>{platform.trayNotes}</p>
                <small>{platform.helper}</small>
              </article>
            ))}
          </section>
        </div>
      </details>

      <section className="workspace-grid">
        <article className="panel tray-panel" ref={trayPanelRef}>
          <div className="tray-panel-header">
            <div className="tray-panel-title">
              <img alt={`${runtimeTrayPlatform.label} tray icon`} className="tray-icon" src={runtimeTrayPlatform.iconAsset} />
              <div>
                <p className="panel-label">{trayPanelLabel}</p>
                <h2>{currentActivity?.name ?? "Not Timed"}</h2>
              </div>
            </div>
            <div className="tray-status-pill" style={{ "--tray-accent": getActivityTone(currentActivity) } as CSSProperties}>
              <strong>{currentDepartment?.name ?? "Awaiting settings"}</strong>
              <small>{formatDisplayTime(currentActivityStartedAt)}</small>
            </div>
          </div>

          <div className="tray-menu-shell">
            <div className="tray-menu-section">
              <p className="tray-menu-label">Pinned actions</p>
              <button
                className="menu-action"
                disabled={!nonTimedActivity}
                onClick={() => {
                  if (!nonTimedActivity) {
                    return;
                  }

                  void handleActivitySelect(nonTimedActivity);
                }}
                type="button"
              >
                <span>Not Timed</span>
                <small>Clear active timing</small>
              </button>
            </div>

            <div className="tray-menu-section">
              <div className="tray-menu-label-row">
                <p className="tray-menu-label">Timed activities</p>
                <small>{timedActivitiesLocked ? "Finish setup to unlock" : `${filteredActivities.length} visible`}</small>
              </div>

              <div className="department-activity-list">
                {filteredActivitySections.map((section) => {
                  const isSectionOpen = forceOpenTimedActivitySections || (openTimedActivitySections[section.id] ?? false);

                  return (
                    <section className={`department-activity-group${isSectionOpen ? " is-open" : ""}`} key={section.id}>
                      <button
                        aria-expanded={isSectionOpen}
                        className={`department-activity-toggle${isSectionOpen ? " is-open" : ""}`}
                        onClick={() => {
                          if (forceOpenTimedActivitySections) {
                            return;
                          }

                          setOpenTimedActivitySections((current) => ({
                            ...current,
                            [section.id]: !(current[section.id] ?? false)
                          }));
                        }}
                        type="button"
                      >
                        <div className="department-activity-toggle-copy">
                          <strong>{section.label}</strong>
                          <small>{formatTimedActivitySectionSummary(section)}</small>
                        </div>

                        <div className="department-activity-toggle-meta">
                          <small>{section.activities.length}</small>
                          <span className="department-activity-toggle-indicator">{isSectionOpen ? "−" : "+"}</span>
                        </div>
                      </button>

                      {isSectionOpen ? (
                        <div className="menu-list">
                          {section.activities.map((activity) => (
                            <button
                              className={`menu-action${currentActivityId === activity.id ? " is-active" : ""}`}
                              disabled={timedActivitiesLocked}
                              key={activity.id}
                              onClick={() => {
                                void handleActivitySelect(activity);
                              }}
                              type="button"
                            >
                              <span>{activity.name}</span>
                              <small>{formatActivityDepartmentSummary(getActivityDepartmentNames(activity, departments, activityDepartmentFallbackId))}</small>
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </section>
                  );
                })}

                {!filteredActivities.length ? <p className="empty-copy">No timed activities match the current selector search.</p> : null}
              </div>
            </div>

            <div className="tray-menu-section">
              <p className="tray-menu-label">Recent activities</p>
              <p className="tray-menu-sublabel">Today rolled up by activity and department</p>
              <div className="recent-rollup-list">
                {recentActivityRollupState.phase === "error" ? (
                  <p className="error-copy">{recentActivityRollupState.message}</p>
                ) : recentActivityRollupState.phase === "loading" && recentActivityRollupRows.length === 0 ? (
                  <p className="empty-copy">Loading today's rolled-up totals from the API.</p>
                ) : recentActivityRollupRows.length > 0 ? (
                  recentActivityRollupRows.map((row) => {
                    const isActiveRow = currentActivity?.kind === "timed"
                      && row.activityName === currentActivity.name
                      && currentRollupDepartmentNames.has(row.departmentName);

                    return (
                      <div className={`recent-rollup-item${isActiveRow ? " is-active" : ""}`} key={row.label}>
                        <div className="recent-rollup-copy">
                          <strong>{row.activityName}</strong>
                          <span>{row.departmentName}</span>
                          <small>{isActiveRow ? "Active now" : "Synced daily total"}</small>
                        </div>

                        <div className="recent-rollup-meta">
                          <strong>{formatHoursLabel(row.hours)}</strong>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <p className="empty-copy">Today's rolled-up totals will appear here after synced tray activity reaches the API.</p>
                )}
              </div>

              <p className="tray-menu-sublabel">Today's notes</p>
              <div className="today-note-list">
                {recentActivityRollupState.phase === "error" ? (
                  <p className="error-copy">{recentActivityRollupState.message}</p>
                ) : todaysNotes.length > 0 ? (
                  todaysNotes.map((note) => (
                    <div className="today-note-item" key={note.eventId}>
                      <div className="today-note-copy">
                        <strong>{note.note}</strong>
                        <span>{note.activityName} · {note.departmentName}</span>
                        <small>Synced at {formatTimestamp(note.occurredAt)}</small>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="empty-copy">Today's synced notes will appear here after note events reach the API.</p>
                )}
              </div>

              <p className="tray-menu-sublabel">Recent changes</p>
              <div className="recent-list">
                {recentItems.length > 0 ? recentItems.map((item) => (
                  <div className={`recent-item is-${item.status}${isRecentItemDeleted(item) ? " is-deleted" : ""}`} key={item.id}>
                    <div className="recent-item-header">
                      <div className="recent-item-copy">
                        <div className="recent-item-badges">
                          {item.eventType === "note-added" ? <span className="recent-item-badge recent-item-badge-note">Note</span> : null}
                          {hasRecentItemCorrections(item) ? <span className="recent-item-badge">Edited</span> : null}
                          {isRecentItemDeleted(item) ? <span className="recent-item-badge recent-item-badge-danger">Deleted</span> : null}
                        </div>
                        <strong>{item.title}</strong>
                        {item.note ? <p className="recent-item-note">{item.note}</p> : null}
                        <span>{item.subtitle}</span>
                        <small>{item.status === "queued" ? `${formatTimestamp(item.timestamp)} · queued locally` : formatTimestamp(item.timestamp)}</small>
                        {item.history.length > 0 ? (
                          <div className="recent-item-history">
                            {[...item.history].reverse().map((entry) => (
                              <small key={`${entry.kind}-${entry.at}`}>{formatRecentItemHistoryEntry(entry)}</small>
                            ))}
                          </div>
                        ) : null}
                      </div>

                      <div className="recent-item-actions">
                        {(item.eventType === "activity-selected" || item.eventType === "note-added") && !isRecentItemDeleted(item) ? (
                          <button
                            className="button"
                            onClick={() => {
                              setEditingRecentItemId(item.id);

                              if (item.eventType === "note-added") {
                                setEditingRecentActivityId("");
                                setEditingRecentNoteText(item.note ?? "");
                                return;
                              }

                              const selectedActivity = resolveRecentItemActivity(item);

                              setEditingRecentActivityId(selectedActivity?.id ?? recentTimedActivityOptions[0]?.id ?? "");
                              setEditingRecentNoteText("");
                            }}
                            type="button"
                          >
                            Edit
                          </button>
                        ) : null}

                        {!isRecentItemDeleted(item) ? (
                          <button
                            className="button button-danger"
                            onClick={() => {
                              void handleRecentItemDelete(item);
                            }}
                            type="button"
                          >
                            Delete
                          </button>
                        ) : null}
                      </div>
                    </div>

                    {editingRecentItemId === item.id && !isRecentItemDeleted(item) ? (
                      <div className="recent-item-editor">
                        {item.eventType === "note-added" ? (
                          <label className="field">
                            <span>Correct note</span>
                            <textarea
                              maxLength={500}
                              onChange={(event) => {
                                setEditingRecentNoteText(event.target.value);
                              }}
                              rows={3}
                              value={editingRecentNoteText}
                            />
                          </label>
                        ) : (
                          <label className="field">
                            <span>Correct to</span>
                            <select
                              onChange={(event) => {
                                setEditingRecentActivityId(event.target.value);
                              }}
                              value={editingRecentActivityId}
                            >
                              {recentTimedActivityOptions.map((activity) => (
                                <option key={`recent-edit-${activity.id}`} value={activity.id}>{activity.name}</option>
                              ))}
                            </select>
                          </label>
                        )}

                        <div className="recent-item-editor-actions">
                          <button
                            className="button button-primary"
                            disabled={item.eventType === "note-added" ? !editingRecentNoteText.trim() : !editingRecentActivityId}
                            onClick={() => {
                              void handleRecentItemEditSave(item);
                            }}
                            type="button"
                          >
                            {item.eventType === "note-added" ? "Save note" : "Save change"}
                          </button>

                          <button
                            className="button"
                            onClick={() => {
                              setEditingRecentItemId(null);
                              setEditingRecentActivityId("");
                              setEditingRecentNoteText("");
                            }}
                            type="button"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                )) : <p className="empty-copy">Recent tray activity changes will appear here after the first selection.</p>}
              </div>
            </div>
          </div>
        </article>

        <article className="panel selector-panel">
          <div className="selector-header">
            <div>
              <p className="panel-label">Quick actions</p>
              <h2>Start activity or add note</h2>
            </div>
            <small>{selectorStatusLabel}</small>
          </div>

          <p className="field-help selector-intro">
            Start timing directly from this panel, or add a timestamped note without switching the current activity.
          </p>

          <section className="selector-section">
            <div className="selector-section-header">
              <div className="selector-section-copy">
                <p className="tray-menu-label">Start activity</p>
                <strong>{searchTerm ? "Matching activities" : "Suggested activities"}</strong>
              </div>
              <small>
                {timedActivitiesLocked
                  ? "Setup required"
                  : searchTerm
                    ? `${filteredActivities.length} match${filteredActivities.length === 1 ? "" : "es"}`
                    : `${quickActionActivities.length} quick picks`}
              </small>
            </div>

            <label className="field">
              <span>Find a timed activity</span>
              <input
                onChange={(event) => {
                  setActivitySearch(event.target.value);
                }}
                placeholder="Type to search timed activities"
                type="search"
                value={activitySearch}
              />
            </label>

            <p className="field-help">
              {timedActivitiesLocked
                ? "Finish setup first, then choose a result here to start timing."
                : searchTerm
                  ? "Select a result below to switch your active timer immediately."
                  : "Choose a quick pick below, or type to narrow the list."}
            </p>

            <div className="menu-list quick-start-list">
              {quickActionActivities.length > 0 ? quickActionActivities.map((activity) => {
                const activityDepartmentSummary = formatActivityDepartmentSummary(
                  getActivityDepartmentNames(activity, departments, activityDepartmentFallbackId)
                );
                const isActive = currentActivityId === activity.id;

                return (
                  <button
                    className={`menu-action quick-start-action${isActive ? " is-active" : ""}`}
                    disabled={timedActivitiesLocked}
                    key={`quick-start-${activity.id}`}
                    onClick={() => {
                      setActivitySearch("");
                      void handleActivitySelect(activity);
                    }}
                    type="button"
                  >
                    <div className="quick-start-action-copy">
                      <strong>{activity.name}</strong>
                      <small>{activityDepartmentSummary}</small>
                    </div>
                    <span className="quick-start-action-state">{isActive ? "Active" : "Start"}</span>
                  </button>
                );
              }) : (
                <p className="empty-copy">
                  {searchTerm ? "No timed activities match this search." : "Suggested activities will appear here once setup is complete."}
                </p>
              )}
            </div>
          </section>

          <section className="selector-section">
            <div className="selector-section-header">
              <div className="selector-section-copy">
                <p className="tray-menu-label">Add note</p>
                <strong>{noteContextLabel}</strong>
              </div>
              <small>{noteContextDetail}</small>
            </div>

            <p className="field-help">Adds a timestamped note without changing the current activity.</p>

            <form className="note-form" onSubmit={(event) => { void handleNoteSubmit(event); }}>
              <label className="field">
                <span>Note for this session</span>
                <textarea
                  onChange={(event) => {
                    setNoteDraft(event.target.value);
                  }}
                  placeholder="Add a short note for the current session"
                  rows={3}
                  value={noteDraft}
                />
              </label>
              <button className="button button-primary" disabled={!noteDraft.trim()} type="submit">Add note</button>
            </form>
          </section>
        </article>
      </section>

    </main>
  );
}