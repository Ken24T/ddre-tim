import seedData from "../../../infra/seeds/ken-boyle-historical-tim-records.json" with { type: "json" };

interface HistoricalRecord {
  id: string;
  workDate: string;
  employeeName: string;
  departmentName: string;
  activityName: string;
  hours: number;
  sourceRowNumber: number;
}

interface HistoricalSeed {
  sourceFile: string;
  sheetName: string;
  employeeFilter: string;
  importedAt: string;
  recordCount: number;
  departments: string[];
  activities: string[];
  records: HistoricalRecord[];
}

interface SummaryCard {
  label: string;
  value: string;
  helper: string;
}

interface BreakdownRow {
  label: string;
  hours: number;
  dayCount: number;
  recordCount: number;
}

interface DailyRow {
  workDate: string;
  label: string;
  hours: number;
  departmentCount: number;
  topActivity: string;
}

interface MonthlyRow {
  monthKey: string;
  label: string;
  hours: number;
}

export interface DashboardData {
  employeeName: string;
  sourceFile: string;
  importedAt: string;
  dateRangeLabel: string;
  summaryCards: SummaryCard[];
  departmentBreakdown: BreakdownRow[];
  activityBreakdown: BreakdownRow[];
  recentDays: DailyRow[];
  monthlyTotals: MonthlyRow[];
}

const historicalSeed = seedData as HistoricalSeed;

function formatHours(value: number): string {
  return new Intl.NumberFormat("en-AU", {
    minimumFractionDigits: value % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2
  }).format(Number(value.toFixed(2)));
}

function formatDate(value: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-AU", options).format(new Date(`${value}T00:00:00Z`));
}

function sumHours(records: HistoricalRecord[]): number {
  return Number(records.reduce((total, record) => total + record.hours, 0).toFixed(2));
}

function buildBreakdown(rows: Map<string, HistoricalRecord[]>): BreakdownRow[] {
  return Array.from(rows.entries(), ([label, records]) => ({
    label,
    hours: sumHours(records),
    dayCount: new Set(records.map((record) => record.workDate)).size,
    recordCount: records.length
  })).sort((left, right) => right.hours - left.hours || left.label.localeCompare(right.label, "en-AU"));
}

function buildRecentDays(records: HistoricalRecord[]): DailyRow[] {
  const days = new Map<string, HistoricalRecord[]>();

  for (const record of records) {
    const dayRecords = days.get(record.workDate) ?? [];
    dayRecords.push(record);
    days.set(record.workDate, dayRecords);
  }

  return Array.from(days.entries(), ([workDate, dayRecords]) => {
    const activityHours = new Map<string, number>();

    for (const record of dayRecords) {
      activityHours.set(record.activityName, (activityHours.get(record.activityName) ?? 0) + record.hours);
    }

    const [topActivity] = Array.from(activityHours.entries()).sort((left, right) => {
      return right[1] - left[1] || left[0].localeCompare(right[0], "en-AU");
    })[0] ?? ["No activity", 0];

    return {
      workDate,
      label: formatDate(workDate, { day: "numeric", month: "short", year: "numeric" }),
      hours: sumHours(dayRecords),
      departmentCount: new Set(dayRecords.map((record) => record.departmentName)).size,
      topActivity
    };
  })
    .sort((left, right) => right.workDate.localeCompare(left.workDate))
    .slice(0, 12);
}

function buildMonthlyTotals(records: HistoricalRecord[]): MonthlyRow[] {
  const months = new Map<string, number>();

  for (const record of records) {
    const monthKey = record.workDate.slice(0, 7);
    months.set(monthKey, Number(((months.get(monthKey) ?? 0) + record.hours).toFixed(2)));
  }

  return Array.from(months.entries(), ([monthKey, hours]) => ({
    monthKey,
    label: formatDate(`${monthKey}-01`, { month: "short", year: "numeric" }),
    hours
  })).sort((left, right) => left.monthKey.localeCompare(right.monthKey));
}

function buildDashboardData(seed: HistoricalSeed): DashboardData {
  const records = [...seed.records].sort((left, right) => left.workDate.localeCompare(right.workDate));
  const firstDate = records[0]?.workDate ?? seed.importedAt.slice(0, 10);
  const lastDate = records[records.length - 1]?.workDate ?? seed.importedAt.slice(0, 10);
  const totalHours = sumHours(records);
  const workdayCount = new Set(records.map((record) => record.workDate)).size;
  const averageHoursPerDay = workdayCount === 0 ? 0 : Number((totalHours / workdayCount).toFixed(2));
  const departmentRecords = new Map<string, HistoricalRecord[]>();
  const activityRecords = new Map<string, HistoricalRecord[]>();

  for (const record of records) {
    const departmentBucket = departmentRecords.get(record.departmentName) ?? [];
    departmentBucket.push(record);
    departmentRecords.set(record.departmentName, departmentBucket);

    const activityBucket = activityRecords.get(record.activityName) ?? [];
    activityBucket.push(record);
    activityRecords.set(record.activityName, activityBucket);
  }

  return {
    employeeName: seed.employeeFilter,
    sourceFile: seed.sourceFile,
    importedAt: seed.importedAt,
    dateRangeLabel: `${formatDate(firstDate, { day: "numeric", month: "short", year: "numeric" })} to ${formatDate(lastDate, {
      day: "numeric",
      month: "short",
      year: "numeric"
    })}`,
    summaryCards: [
      {
        label: "Imported hours",
        value: formatHours(totalHours),
        helper: `${seed.recordCount} combined daily records`
      },
      {
        label: "Worked days",
        value: String(workdayCount),
        helper: `${formatHours(averageHoursPerDay)} average hours/day`
      },
      {
        label: "Departments",
        value: String(seed.departments.length),
        helper: `${seed.activities.length} activities captured`
      },
      {
        label: "Date span",
        value: `${firstDate.slice(0, 4)}-${lastDate.slice(0, 4)}`,
        helper: `${formatDate(firstDate, { day: "numeric", month: "short" })} to ${formatDate(lastDate, { day: "numeric", month: "short" })}`
      }
    ],
    departmentBreakdown: buildBreakdown(departmentRecords).slice(0, 8),
    activityBreakdown: buildBreakdown(activityRecords).slice(0, 8),
    recentDays: buildRecentDays(records),
    monthlyTotals: buildMonthlyTotals(records)
  };
}

export const dashboardData = buildDashboardData(historicalSeed);

export function formatHoursLabel(value: number): string {
  return `${formatHours(value)} h`;
}