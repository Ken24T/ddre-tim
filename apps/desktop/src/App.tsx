import { useEffect, useEffectEvent, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import type { Activity, ActivityEvent, Department, UserSettings, UserSettingsUpdate } from "@ddre/contracts";
import { fetchHealth, fetchUserSettings, getApiBaseUrl, saveUserSettings, sendSyncBatch, type HealthPayload } from "./desktopClient.js";
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
  title: string;
  subtitle: string;
  timestamp: string;
  status: "queued" | "sent" | "failed";
};

type TimedActivitySection = {
  id: string;
  label: string;
  kind: "department" | "shared";
  activities: Activity[];
};

const defaultUserId = "cinnamon-local-user";
const userIdStorageKey = "ddre.desktop.user-id";
const noteStorageKey = "ddre.desktop.last-note";
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

function buildSettingsUpdate(displayName: string, defaultDepartmentId: string): UserSettingsUpdate {
  return {
    displayName,
    defaultDepartmentId,
    activities: []
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
  const [activitySearch, setActivitySearch] = useState("");
  const [noteDraft, setNoteDraft] = useState(() => getStoredValue(noteStorageKey, ""));
  const [currentActivityId, setCurrentActivityId] = useState<string | null>(null);
  const [currentActivityStartedAt, setCurrentActivityStartedAt] = useState<string | null>(null);
  const [recentItems, setRecentItems] = useState<RecentItem[]>([]);
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

    setSettingsState((current) => {
      if (current.phase === "ready" || current.phase === "refreshing" || current.phase === "saving") {
        return { phase: "refreshing", data: current.data };
      }

      return { phase: "loading" };
    });

    async function loadSettings(): Promise<void> {
      try {
        const payload = await fetchUserSettings(userId);

        if (!cancelled) {
          setSettingsState({ phase: "ready", data: payload });
          setDisplayNameDraft(payload.displayName);
          setDefaultDepartmentIdDraft(payload.defaultDepartmentId);
          setCurrentActivityId((current) => current ?? payload.activities.find((activity) => activity.kind === "non-timed")?.id ?? null);
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
  }, [userId]);

  const handleTrayMenuEvent = useEffectEvent((payload: TrayMenuEvent) => {
    switch (payload.action) {
      case "open-settings": {
        settingsPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
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
  const healthLabel =
    healthState.phase === "ready" ? `${healthState.payload.service} ready` : healthState.phase === "error" ? "API unavailable" : "Checking API";
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
  const currentDepartment = departments.find((department) => department.id === (currentActivity?.departmentId ?? settings?.defaultDepartmentId));
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

  async function postEvent(event: ActivityEvent, optimisticItem: RecentItem): Promise<void> {
    setRecentItems((current) => [optimisticItem, ...current].slice(0, 6));
    if (desktopContext) {
      setSyncState({ phase: "sending", message: "Queueing tray action locally before sync." });

      try {
        const queuedStatus = await queueDesktopEvent(userId, event);

        if (!queuedStatus) {
          throw new Error("Native outbox did not return a queue status.");
        }

        setOutboxStatus(queuedStatus);
        setRecentItems((current) =>
          current.map((item) => (item.id === optimisticItem.id ? { ...item, status: "queued" } : item))
        );

        const flushedStatus = await flushNativeOutbox("Queued tray action locally. Attempting sync.");
        const delivered = flushedStatus && flushedStatus.pendingCount === 0;

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
      } catch (error) {
        setRecentItems((current) =>
          current.map((item) => (item.id === optimisticItem.id ? { ...item, status: "failed" } : item))
        );
        setSyncState({
          phase: "error",
          message: formatSyncError(error)
        });
      }

      return;
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

      setRecentItems((current) =>
        current.map((item) => (item.id === optimisticItem.id ? { ...item, status: "sent" } : item))
      );
      setSyncState({
        phase: "ready",
        message: `${ack.acceptedEventIds.length} event acknowledged by the API.`,
        at: ack.receivedAt
      });
    } catch (error) {
      setRecentItems((current) =>
        current.map((item) => (item.id === optimisticItem.id ? { ...item, status: "failed" } : item))
      );
      setSyncState({
        phase: "error",
        message: formatSyncError(error)
      });
    }
  }

  async function handleActivitySelect(activity: Activity): Promise<void> {
    if (timedActivitiesLocked && activity.kind === "timed") {
      return;
    }

    const occurredAt = new Date().toISOString();
    const selectedDepartmentName = formatActivityDepartmentSummary(
      getActivityDepartmentNames(activity, departments, activityDepartmentFallbackId)
    );
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

    await postEvent(nextEvent, {
      id: nextEvent.eventId,
      title: activity.kind === "non-timed" ? "Moved to Not Timed" : `Selected ${activity.name}`,
      subtitle: activity.kind === "non-timed" ? "Timing cleared from the Cinnamon tray menu" : `${selectedDepartmentName} from the tray menu`,
      timestamp: occurredAt,
      status: "sent"
    });
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

    await postEvent(noteEvent, {
      id: noteEvent.eventId,
      title: "Added note",
      subtitle: submittedNote,
      timestamp: occurredAt,
      status: "sent"
    });
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
        buildSettingsUpdate(displayNameDraft, defaultDepartmentIdDraft)
      );

      setSettingsState({ phase: "ready", data: payload });
      setDisplayNameDraft(payload.displayName);
      setDefaultDepartmentIdDraft(payload.defaultDepartmentId);
      setSaveMessage(`Settings saved. ${runtimeTrayPlatform.label} tray capture is ready to use.`);
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

          <div className="settings-actions">
            <button className="button button-primary" disabled={settingsState.phase === "loading" || settingsState.phase === "saving"} type="submit">
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
              <p className="tray-menu-label">Recent actions</p>
              <div className="recent-list">
                {recentItems.length > 0 ? recentItems.map((item) => (
                  <div className={`recent-item is-${item.status}`} key={item.id}>
                    <strong>{item.title}</strong>
                    <span>{item.subtitle}</span>
                    <small>{item.status === "queued" ? `${formatTimestamp(item.timestamp)} · queued locally` : formatTimestamp(item.timestamp)}</small>
                  </div>
                )) : <p className="empty-copy">Recent tray actions will appear here after the first selection or note.</p>}
              </div>
            </div>
          </div>
        </article>

        <article className="panel selector-panel">
          <div className="selector-header">
            <div>
              <p className="panel-label">Quick selector</p>
              <h2>Search and note</h2>
            </div>
            <small>{healthLabel}</small>
          </div>

          <label className="field">
            <span>Search timed activities</span>
            <input
              onChange={(event) => {
                setActivitySearch(event.target.value);
              }}
              placeholder="Filter the tray menu"
              type="search"
              value={activitySearch}
            />
          </label>

          <form className="note-form" onSubmit={(event) => { void handleNoteSubmit(event); }}>
            <label className="field">
              <span>Quick note</span>
              <textarea
                onChange={(event) => {
                  setNoteDraft(event.target.value);
                }}
                placeholder="Capture a short note"
                rows={3}
                value={noteDraft}
              />
            </label>
            <button className="button button-primary" disabled={!noteDraft.trim()} type="submit">Add note</button>
          </form>
        </article>
      </section>

    </main>
  );
}