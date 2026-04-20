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
import { activeTrayPlatform, trayPlatforms } from "./trayPlatforms.js";

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

const defaultUserId = "cinnamon-local-user";
const userIdStorageKey = "ddre.desktop.user-id";
const noteStorageKey = "ddre.desktop.last-note";
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

export default function App() {
  const [userId, setUserId] = useState(() => getStoredValue(userIdStorageKey, defaultUserId));
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
  const trayPanelRef = useRef<HTMLElement | null>(null);
  const settingsPanelRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(userIdStorageKey, userId);
  }, [userId]);

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
      case "open-main": {
        trayPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        break;
      }
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
  const timedActivityCatalog = allActivities.filter((activity) => activity.kind === "timed");
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
  const outboxTone = outboxStatus.lastError ? "error" : outboxStatus.pendingCount > 0 ? "sending" : desktopContext ? "ready" : "idle";
  const outboxHeading = desktopContext
    ? outboxStatus.pendingCount > 0
      ? `${formatPendingCount(outboxStatus.pendingCount)} queued`
      : "Outbox empty"
    : "Browser preview";
  const outboxDetail = desktopContext
    ? outboxStatus.lastError ?? (outboxStatus.lastSyncedAt ? `Last native flush ${formatTimestamp(outboxStatus.lastSyncedAt)}` : "Native queue is ready for tray actions.")
    : "The preview shell sends directly to the API until the Tauri host is running.";
  const desktopHostLabel = desktopContext ? "Native Tauri host" : "Browser shell preview";
  const desktopHostDetail = desktopContext
    ? "Native tray events, the local outbox, and Cinnamon autostart are available."
    : "Use the browser shell while Linux WebKit and libsoup headers are still being installed.";
  const activityDepartmentFallbackId = settings?.defaultDepartmentId || defaultDepartmentIdDraft || departments[0]?.id;
  const currentDepartment = departments.find((department) => department.id === (currentActivity?.departmentId ?? settings?.defaultDepartmentId));
  const onboardingCopy = settings?.isConfigured
    ? desktopContext
      ? "Cinnamon tray capture is ready. Native tray actions queue locally, flush through the API, and keep timed selection menu-first."
      : "Cinnamon tray capture preview is ready. Timed activities stay menu-first, with a quick selector available for long lists or notes."
    : "First run routes into settings before timed capture begins. Configure the user name and default department below while shared tray activities remain dashboard-managed.";

  const platformCards = useMemo(() => trayPlatforms, []);

  useEffect(() => {
    if (!desktopContext || !settings) {
      return;
    }

    const secondaryLabel = outboxStatus.pendingCount > 0
      ? `${formatPendingCount(outboxStatus.pendingCount)} queued locally`
      : syncState.phase === "ready"
        ? `Synced ${formatTimestamp(syncState.at)}`
        : syncState.message;

    const activities = [
      ...(nonTimedActivity ? [{
        id: nonTimedActivity.id,
        label: nonTimedActivity.name,
        helper: "Clear active timing",
        active: currentActivityId === nonTimedActivity.id
      }] : []),
      ...menuActivities.map((activity) => ({
        id: activity.id,
        label: activity.name,
        helper: formatActivityDepartmentSummary(
          getActivityDepartmentNames(activity, departments, activityDepartmentFallbackId)
        ),
        active: currentActivityId === activity.id
      }))
    ];

    void syncNativeTray({
      currentActivityLabel: currentActivity?.name ?? "Not Timed",
      secondaryLabel,
      activities,
      configured: settings.isConfigured,
      autostartEnabled: autostartState.enabled,
      autostartAvailable: autostartState.available
    });
  }, [
    autostartState.available,
    autostartState.enabled,
    currentActivity?.name,
    currentActivityId,
    departments,
    desktopContext,
    menuActivities,
    nonTimedActivity,
    outboxStatus.pendingCount,
    settings,
    syncState,
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

      if (status.pendingCount === 0) {
        setSyncState({
          phase: "ready",
          message: "Local outbox flushed to the API.",
          at: status.lastSyncedAt ?? new Date().toISOString()
        });
      } else if (status.lastError) {
        setSyncState({
          phase: "error",
          message: `${status.lastError} ${formatPendingCount(status.pendingCount)} still queued locally.`
        });
      } else {
        setSyncState({
          phase: "sending",
          message: `${formatPendingCount(status.pendingCount)} remain queued locally.`
        });
      }

      return status;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
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
          message: error instanceof Error ? error.message : String(error)
        });
      }

      return;
    }

    setSyncState({ phase: "sending", message: "Sending tray action to the API." });

    try {
      const ack = await sendSyncBatch({
        batchId: createIdentifier("batch"),
        userId,
        deviceId: activeTrayPlatform.id,
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
        message: error instanceof Error ? error.message : String(error)
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
          deviceId: activeTrayPlatform.id,
          occurredAt,
          recordedAt: occurredAt,
          type: "activity-cleared",
          idempotencyKey: createIdentifier("idempotency"),
          metadata: {
            target: activity.name,
            platform: activeTrayPlatform.id
          }
        }
      : {
          eventId: createIdentifier("event"),
          userId,
          deviceId: activeTrayPlatform.id,
          occurredAt,
          recordedAt: occurredAt,
          type: "activity-selected",
          activityId: activity.id,
          departmentId: activity.departmentId,
          idempotencyKey: createIdentifier("idempotency"),
          metadata: {
            activityName: activity.name,
            platform: activeTrayPlatform.id
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
      deviceId: activeTrayPlatform.id,
      occurredAt,
      recordedAt: occurredAt,
      type: "note-added",
      note: noteDraft.trim(),
      idempotencyKey: createIdentifier("idempotency"),
      metadata: {
        platform: activeTrayPlatform.id,
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
      setSaveMessage("Settings saved. Cinnamon tray capture is ready to use.");
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
          <h1>Cinnamon Tray Shell</h1>
          <p className="lead">{onboardingCopy}</p>
        </div>

        <div className="hero-meta">
          <div className="meta-card">
            <span>Desktop host</span>
            <strong>{desktopHostLabel}</strong>
            <small>{desktopHostDetail}</small>
          </div>

          <div className="meta-card">
            <span>Tray platform</span>
            <strong>{activeTrayPlatform.label}</strong>
            <small>{activeTrayPlatform.helper}</small>
          </div>

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
      </section>

      <section className="platform-grid">
        {platformCards.map((platform) => (
          <article className={`platform-card panel${platform.id === activeTrayPlatform.id ? " is-active" : ""}`} key={platform.id}>
            <div className="platform-card-header">
              <img alt={`${platform.label} tray icon`} className="platform-icon" src={platform.iconAsset} />
              <div>
                <p className="panel-label">{platform.status === "current" ? "Current slice" : "Queued platform"}</p>
                <h2>{platform.label}</h2>
              </div>
            </div>
            <p>{platform.trayNotes}</p>
            <small>{platform.helper}</small>
          </article>
        ))}
      </section>

      <section className="workspace-grid">
        <article className="panel tray-panel" ref={trayPanelRef}>
          <div className="tray-panel-header">
            <div className="tray-panel-title">
              <img alt="Cinnamon tray icon" className="tray-icon" src={activeTrayPlatform.iconAsset} />
              <div>
                <p className="panel-label">Cinnamon tray</p>
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

              <div className="menu-list">
                {filteredActivities.map((activity) => (
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
                    <small>{departments.find((department) => department.id === activity.departmentId)?.name ?? "Default department"}</small>
                  </button>
                ))}
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
              <h2>Long-list and notes window</h2>
            </div>
            <small>{healthLabel}</small>
          </div>

          <label className="field">
            <span>Search timed activities</span>
            <input
              onChange={(event) => {
                setActivitySearch(event.target.value);
              }}
              placeholder="Type to filter the tray menu"
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
                placeholder="Capture a short note alongside the current tray context"
                rows={4}
                value={noteDraft}
              />
            </label>
            <button className="button button-primary" disabled={!noteDraft.trim()} type="submit">Send note event</button>
          </form>

          <div className="selector-footer">
            <div>
              <p className="panel-label">Current mode</p>
              <strong>{settings?.isConfigured ? "Configured user" : "First-run onboarding"}</strong>
            </div>
            <p>{settings?.isConfigured ? "Timed activities can be selected from the Cinnamon tray immediately." : "Timed activities stay locked until the settings form below is saved once."}</p>
          </div>
        </article>
      </section>

      <section className="panel settings-panel" ref={settingsPanelRef}>
        <div className="settings-header">
          <div>
            <p className="panel-label">User settings</p>
            <h2>{settings?.isConfigured ? "Edit tray settings" : "First-run setup"}</h2>
          </div>
          <small>{settingsState.phase === "saving" ? "Saving to the API..." : saveMessage ?? "Backed by /v1/users/:userId/settings and mirrored into the native tray"}</small>
        </div>

        {settingsState.phase === "error" ? (
          <p className="error-copy">{settingsState.message}</p>
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
              onChange={(event) => {
                setDefaultDepartmentIdDraft(event.target.value);
              }}
              value={defaultDepartmentIdDraft}
            >
              {departments.map((department) => (
                <option key={department.id} value={department.id}>{department.name}</option>
              ))}
            </select>
          </label>

          <div className="settings-activities">
            <div className="settings-activities-header">
              <div>
                <p className="panel-label">Shared activity catalog</p>
                <strong>The dashboard manages shared tray activities. Desktop settings only control the user profile and default department.</strong>
              </div>
              <small>{timedActivityCatalog.length} repository entries</small>
            </div>

            <div className="settings-activity-overview">
              <p className="settings-activity-copy">
                Shared repository activities are read-only here. Inactive items stay out of new tray selections, and the
                system-managed Not Timed state stays pinned automatically.
              </p>

              <div className="settings-activity-list">
                {timedActivityCatalog.length > 0 ? timedActivityCatalog.map((activity) => {
                  const departmentNames = getActivityDepartmentNames(activity, departments, activityDepartmentFallbackId);

                  return (
                    <div className={`settings-activity-card${activity.isActive ? "" : " is-inactive"}`} key={activity.id}>
                      <div className="settings-activity-card-main">
                        <span
                          className="settings-activity-swatch"
                          style={{ "--activity-accent": activity.color ?? "#88CFC2" } as CSSProperties}
                        />
                        <div>
                          <strong>{activity.name}</strong>
                          <small>{departmentNames.length > 0 ? departmentNames.join(" / ") : "Default department"}</small>
                        </div>
                      </div>

                      <span className={`settings-activity-badge${activity.isActive ? "" : " is-inactive"}`}>
                        {activity.isActive ? "Active in tray" : "Inactive"}
                      </span>
                    </div>
                  );
                }) : <p className="empty-copy">No timed activities are currently available from the shared repository.</p>}
              </div>
            </div>
          </div>

          <div className="settings-actions">
            <button className="button button-primary" disabled={settingsState.phase === "loading" || settingsState.phase === "saving"} type="submit">
              {settingsState.phase === "saving" ? "Saving..." : settings?.isConfigured ? "Save settings" : "Finish first-run setup"}
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}