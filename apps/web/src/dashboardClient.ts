export interface DashboardQueryValues {
  department?: string;
  from?: string;
  to?: string;
  userIds?: string[];
}

export interface DashboardSummaryStats {
  totalHours: number;
  workdayCount: number;
  averageHoursPerDay: number;
  userDayCount: number;
  averageHoursPerUserDay: number;
  selectedUserCount: number;
  departmentCount: number;
  activityCount: number;
  recordCount: number;
}

export interface DashboardUserOption {
  id: string;
  displayName: string;
  color: string;
  isSelected: boolean;
  totalHours: number;
  recordCount: number;
}

export interface DashboardFilters {
  availableDepartments: string[];
  selectedDepartment: string | null;
  availableUsers: DashboardUserOption[];
  selectedUserIds: string[];
  selectedFrom: string;
  selectedTo: string;
  minDate: string;
  maxDate: string;
}

export interface DashboardBreakdownRow {
  label: string;
  hours: number;
  dayCount: number;
  recordCount: number;
}

export interface DashboardDepartmentUserSegment {
  userId: string;
  label: string;
  color: string;
  hours: number;
}

export interface DashboardDepartmentUserRow {
  label: string;
  totalHours: number;
  dayCount: number;
  recordCount: number;
  segments: DashboardDepartmentUserSegment[];
}

export type DashboardActivityUserSegment = DashboardDepartmentUserSegment;

export type DashboardActivityUserRow = DashboardDepartmentUserRow;

export interface DashboardUserBreakdownRow {
  userId: string;
  label: string;
  color: string;
  hours: number;
  dayCount: number;
  recordCount: number;
}

export interface DashboardRecentDay {
  workDate: string;
  label: string;
  hours: number;
  departmentCount: number;
  topActivity: string;
}

export interface DashboardNote {
  eventId: string;
  userId: string;
  employeeName: string;
  workDate: string;
  occurredAt: string;
  note: string;
  activityName: string;
  departmentName: string;
  deviceId: string;
}

export interface DashboardMonthlyTotal {
  monthKey: string;
  label: string;
  hours: number;
}

export interface DashboardMonthlyUserSegment {
  userId: string;
  label: string;
  color: string;
  hours: number;
}

export interface DashboardMonthlyUserTotal {
  monthKey: string;
  label: string;
  totalHours: number;
  segments: DashboardMonthlyUserSegment[];
}

export interface DashboardResponse {
  scopeLabel: string;
  employeeName: string;
  sourceFile: string;
  importedAt: string;
  dateRangeLabel: string;
  filters: DashboardFilters;
  stats: DashboardSummaryStats;
  userBreakdown: DashboardUserBreakdownRow[];
  departmentBreakdown: DashboardBreakdownRow[];
  departmentUserBreakdown: DashboardDepartmentUserRow[];
  activityBreakdown: DashboardBreakdownRow[];
  activityUserBreakdown: DashboardActivityUserRow[];
  notes: DashboardNote[];
  recentDays: DashboardRecentDay[];
  monthlyTotals: DashboardMonthlyTotal[];
  monthlyUserTotals: DashboardMonthlyUserTotal[];
}

export interface ActivityRepositoryEntry {
  id: string;
  slug: string;
  name: string;
  color?: string;
  departmentId?: string;
  departmentIds?: string[];
  kind: "timed" | "non-timed";
  isSystem: boolean;
  isActive: boolean;
}

export interface ActivityCatalogResponse {
  activities: ActivityRepositoryEntry[];
  refreshedAt: string;
}

export interface DepartmentRepositoryEntry {
  id: string;
  slug: string;
  name: string;
  isActive: boolean;
}

export interface DepartmentCatalogResponse {
  departments: DepartmentRepositoryEntry[];
  refreshedAt: string;
}

export interface ActivityRepositoryMutation {
  name: string;
  color?: string;
  departmentIds: string[];
  isActive: boolean;
}

interface HealthPayload {
  service: string;
  status: string;
  now: string;
}

const defaultApiBaseUrl = "http://127.0.0.1:4000";

function getApiBaseUrl(): string {
  const configuredBaseUrl = import.meta.env.VITE_DDRE_API_BASE_URL;

  if (configuredBaseUrl === "same-origin") {
    return "";
  }

  if (configuredBaseUrl) {
    return configuredBaseUrl.replace(/\/$/, "");
  }

  return import.meta.env.DEV ? "" : defaultApiBaseUrl;
}

function resolveApiUrl(path: string): string {
  return `${getApiBaseUrl()}${path}`;
}

async function readErrorMessage(response: Response, fallbackMessage: string): Promise<string> {
  const responseText = await response.text();

  if (!responseText) {
    return fallbackMessage;
  }

  try {
    const payload = JSON.parse(responseText) as {
      message?: unknown;
      issues?: Array<{ message?: unknown }>;
    };
    const issueMessage = payload.issues?.find((issue) => typeof issue.message === "string")?.message;

    if (typeof issueMessage === "string") {
      return issueMessage;
    }

    if (typeof payload.message === "string") {
      return payload.message;
    }
  } catch {
    return responseText;
  }

  return fallbackMessage;
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

function formatHours(value: number): string {
  return new Intl.NumberFormat("en-AU", {
    minimumFractionDigits: value % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2
  }).format(Number(value.toFixed(2)));
}

export function formatHoursLabel(value: number): string {
  return `${formatHours(value)} h`;
}

export function formatTimestamp(value: string): string {
  try {
    return new Intl.DateTimeFormat("en-AU", {
      dateStyle: "medium",
      timeStyle: "medium"
    }).format(new Date(value));
  } catch {
    return value;
  }
}

export async function fetchDashboardSnapshot(query: DashboardQueryValues): Promise<DashboardResponse> {
  const response = await fetch(resolveApiUrl(buildDashboardUrl(query)));

  if (!response.ok) {
    throw new Error(`Dashboard request failed with status ${response.status}`);
  }

  return (await response.json()) as DashboardResponse;
}

export async function fetchHealth(): Promise<HealthPayload> {
  const response = await fetch(resolveApiUrl("/health"));

  if (!response.ok) {
    throw new Error(`Health check failed with status ${response.status}`);
  }

  return (await response.json()) as HealthPayload;
}

export async function fetchActivityCatalog(): Promise<ActivityCatalogResponse> {
  const response = await fetch(resolveApiUrl("/v1/activities"));

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, `Activity repository request failed with status ${response.status}`));
  }

  return (await response.json()) as ActivityCatalogResponse;
}

export async function fetchDepartmentCatalog(): Promise<DepartmentCatalogResponse> {
  const response = await fetch(resolveApiUrl("/v1/departments"));

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, `Department catalog request failed with status ${response.status}`));
  }

  return (await response.json()) as DepartmentCatalogResponse;
}

export async function createActivityRepositoryEntry(
  payload: ActivityRepositoryMutation
): Promise<ActivityRepositoryEntry> {
  const response = await fetch(resolveApiUrl("/v1/activities"), {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, `Activity repository create failed with status ${response.status}`));
  }

  return (await response.json()) as ActivityRepositoryEntry;
}

export async function updateActivityRepositoryEntry(
  activityId: string,
  payload: ActivityRepositoryMutation
): Promise<ActivityRepositoryEntry> {
  const response = await fetch(resolveApiUrl(`/v1/activities/${encodeURIComponent(activityId)}`), {
    method: "PUT",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, `Activity repository update failed with status ${response.status}`));
  }

  return (await response.json()) as ActivityRepositoryEntry;
}
