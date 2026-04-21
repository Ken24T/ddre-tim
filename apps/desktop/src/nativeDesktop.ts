import type { ActivityEvent } from "@ddre/contracts";

export interface DesktopContext {
  platform: string;
  trayChannel: string;
}

export interface TrayMenuActivity {
  id: string;
  label: string;
  helper: string;
  active: boolean;
}

export interface TrayMenuActivitySection {
  id: string;
  label: string;
  activities: TrayMenuActivity[];
}

export interface TrayMenuState {
  currentActivityLabel: string;
  secondaryLabel: string;
  activitySections: TrayMenuActivitySection[];
  configured: boolean;
  autostartEnabled: boolean;
  autostartAvailable: boolean;
}

export interface TrayMenuEvent {
  action: "open-settings" | "refresh-activities" | "trigger-sync" | "toggle-autostart" | "select-activity";
  activityId?: string;
}

export interface OutboxStatus {
  pendingCount: number;
  lastSyncedAt: string | null;
  lastError: string | null;
}

export interface AutostartState {
  enabled: boolean;
  available: boolean;
  detail: string;
}

function isTauriHostAvailable(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invokeNative<T>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isTauriHostAvailable()) {
    return null;
  }

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

export async function getDesktopContext(): Promise<DesktopContext | null> {
  return invokeNative<DesktopContext>("get_desktop_context");
}

export async function listenForTrayEvents(
  channel: string,
  listener: (payload: TrayMenuEvent) => void
): Promise<() => void> {
  if (!isTauriHostAvailable()) {
    return () => {};
  }

  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<TrayMenuEvent>(channel, (event) => {
    if (event.payload) {
      listener(event.payload);
    }
  });

  return () => {
    void unlisten();
  };
}

export async function syncNativeTray(payload: TrayMenuState): Promise<void> {
  await invokeNative<void>("sync_tray_state", { payload });
}

export async function queueDesktopEvent(userId: string, event: ActivityEvent): Promise<OutboxStatus | null> {
  return invokeNative<OutboxStatus>("queue_activity_event", { userId, event });
}

export async function flushDesktopOutbox(apiBaseUrl: string, userId: string): Promise<OutboxStatus | null> {
  return invokeNative<OutboxStatus>("flush_outbox", { apiBaseUrl, userId });
}

export async function getDesktopOutboxStatus(userId: string): Promise<OutboxStatus | null> {
  return invokeNative<OutboxStatus>("get_outbox_status", { userId });
}

export async function getDesktopAutostartState(): Promise<AutostartState | null> {
  return invokeNative<AutostartState>("get_autostart_state");
}

export async function setDesktopAutostartEnabled(enabled: boolean): Promise<AutostartState | null> {
  return invokeNative<AutostartState>("set_autostart_enabled", { enabled });
}