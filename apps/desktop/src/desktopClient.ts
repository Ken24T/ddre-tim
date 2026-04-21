import {
  activityCatalogResponseSchema,
  dashboardResponseSchema,
  syncAckSchema,
  syncBatchSchema,
  userSettingsSchema,
  userSettingsUpdateSchema,
  type ActivityCatalogResponse,
  type DashboardResponse,
  type SyncAck,
  type SyncBatch,
  type UserSettings,
  type UserSettingsUpdate
} from "@ddre/contracts";

interface HealthPayload {
  service: string;
  status: string;
  now: string;
}

interface DashboardQueryValues {
  department?: string;
  from?: string;
  to?: string;
  userIds?: string[];
}

const nativeApiBaseUrl = "http://127.0.0.1:4000";

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function getApiBaseUrl(): string {
  return nativeApiBaseUrl;
}

function getWebviewApiBaseUrl(): string {
  if (typeof window === "undefined") {
    return nativeApiBaseUrl;
  }

  if (isTauriRuntime()) {
    return nativeApiBaseUrl;
  }

  const { hostname, protocol } = window.location;

  if ((protocol === "http:" || protocol === "https:") && (hostname === "localhost" || hostname === "127.0.0.1")) {
    return "";
  }

  return nativeApiBaseUrl;
}

function resolveApiUrl(path: string): string {
  return `${getWebviewApiBaseUrl()}${path}`;
}

function buildDashboardUrl(query: DashboardQueryValues): string {
  const params = new URLSearchParams();

  if (query.department) {
    params.set("department", query.department);
  }

  if (query.from) {
    params.set("from", query.from);
  }

  if (query.to) {
    params.set("to", query.to);
  }

  for (const userId of query.userIds ?? []) {
    params.append("userId", userId);
  }

  const queryString = params.toString();

  return queryString.length > 0 ? `/v1/dashboard?${queryString}` : "/v1/dashboard";
}

async function fetchJson(input: RequestInfo | URL, init?: RequestInit): Promise<unknown> {
  const response = await fetch(input, init);

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(bodyText || `Request failed with status ${response.status}`);
  }

  return response.json();
}

export async function fetchHealth(): Promise<HealthPayload> {
  const payload = await fetchJson(resolveApiUrl("/health"));

  if (!payload || typeof payload !== "object") {
    throw new Error("Health response was not an object");
  }

  const { now, service, status } = payload as Record<string, unknown>;

  if (typeof now !== "string" || typeof service !== "string" || typeof status !== "string") {
    throw new Error("Health response was missing required fields");
  }

  return { now, service, status };
}

export async function fetchUserSettings(userId: string): Promise<UserSettings> {
  const payload = await fetchJson(resolveApiUrl(`/v1/users/${encodeURIComponent(userId)}/settings`));
  return userSettingsSchema.parse(payload);
}

export async function fetchActivityCatalog(): Promise<ActivityCatalogResponse> {
  const payload = await fetchJson(resolveApiUrl("/v1/activities"));
  return activityCatalogResponseSchema.parse(payload);
}

export async function fetchDashboardSnapshot(query: DashboardQueryValues): Promise<DashboardResponse> {
  const payload = await fetchJson(resolveApiUrl(buildDashboardUrl(query)));
  return dashboardResponseSchema.parse(payload);
}

export async function saveUserSettings(userId: string, update: UserSettingsUpdate): Promise<UserSettings> {
  const payload = await fetchJson(resolveApiUrl(`/v1/users/${encodeURIComponent(userId)}/settings`), {
    method: "PUT",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(userSettingsUpdateSchema.parse(update))
  });

  return userSettingsSchema.parse(payload);
}

export async function sendSyncBatch(batch: SyncBatch): Promise<SyncAck> {
  const payload = await fetchJson(resolveApiUrl("/v1/sync-batches"), {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(syncBatchSchema.parse(batch))
  });

  return syncAckSchema.parse(payload);
}

export type { HealthPayload };