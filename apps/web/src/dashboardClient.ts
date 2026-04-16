export interface DashboardQueryValues {
  department?: string;
  from?: string;
  to?: string;
}

export interface DashboardSummaryStats {
  totalHours: number;
  workdayCount: number;
  averageHoursPerDay: number;
  departmentCount: number;
  activityCount: number;
  recordCount: number;
}

export interface DashboardFilters {
  availableDepartments: string[];
  selectedDepartment: string | null;
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

export interface DashboardRecentDay {
  workDate: string;
  label: string;
  hours: number;
  departmentCount: number;
  topActivity: string;
}

export interface DashboardMonthlyTotal {
  monthKey: string;
  label: string;
  hours: number;
}

export interface DashboardResponse {
  employeeName: string;
  sourceFile: string;
  importedAt: string;
  dateRangeLabel: string;
  filters: DashboardFilters;
  stats: DashboardSummaryStats;
  departmentBreakdown: DashboardBreakdownRow[];
  activityBreakdown: DashboardBreakdownRow[];
  recentDays: DashboardRecentDay[];
  monthlyTotals: DashboardMonthlyTotal[];
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
  const response = await fetch(buildDashboardUrl(query));

  if (!response.ok) {
    throw new Error(`Dashboard request failed with status ${response.status}`);
  }

  return (await response.json()) as DashboardResponse;
}