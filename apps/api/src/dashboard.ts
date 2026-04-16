import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  dashboardQuerySchema,
  dashboardResponseSchema,
  type DashboardBreakdownRow,
  type DashboardQuery,
  type DashboardRecentDay,
  type DashboardResponse
} from "@ddre/contracts";
import { z } from "zod";

const historicalRecordSchema = z.object({
  id: z.string().min(1),
  workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  employeeName: z.string().min(1),
  departmentName: z.string().min(1),
  activityName: z.string().min(1),
  hours: z.number().nonnegative(),
  sourceRowNumber: z.number().int().nonnegative()
});

const historicalSeedSchema = z.object({
  sourceFile: z.string().min(1),
  sheetName: z.string().min(1),
  employeeFilter: z.string().min(1),
  importedAt: z.string().datetime({ offset: true }),
  recordCount: z.number().int().nonnegative(),
  departments: z.array(z.string().min(1)),
  activities: z.array(z.string().min(1)),
  records: z.array(historicalRecordSchema)
});

type HistoricalRecord = z.infer<typeof historicalRecordSchema>;
type HistoricalSeed = z.infer<typeof historicalSeedSchema>;

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(moduleDirectory, "../../..");
const historicalSeedPath = resolve(workspaceRoot, "infra/seeds/ken-boyle-historical-tim-records.json");

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

function clampDate(value: string, minDate: string, maxDate: string): string {
  if (value < minDate) {
    return minDate;
  }

  if (value > maxDate) {
    return maxDate;
  }

  return value;
}

function buildBreakdown(rows: Map<string, HistoricalRecord[]>): DashboardBreakdownRow[] {
  return Array.from(rows.entries(), ([label, records]) => ({
    label,
    hours: sumHours(records),
    dayCount: new Set(records.map((record) => record.workDate)).size,
    recordCount: records.length
  })).sort((left, right) => right.hours - left.hours || left.label.localeCompare(right.label, "en-AU"));
}

function buildRecentDays(records: HistoricalRecord[]): DashboardRecentDay[] {
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

function buildMonthlyTotals(records: HistoricalRecord[]): DashboardResponse["monthlyTotals"] {
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

async function readHistoricalSeed(): Promise<HistoricalSeed> {
  const fileContents = await readFile(historicalSeedPath, "utf8");

  return historicalSeedSchema.parse(JSON.parse(fileContents));
}

export async function getDashboardReadModel(rawQuery: unknown): Promise<DashboardResponse> {
  const query = dashboardQuerySchema.parse(rawQuery) as DashboardQuery;
  const seed = await readHistoricalSeed();
  const allRecords = [...seed.records].sort((left, right) => left.workDate.localeCompare(right.workDate));
  const minDate = allRecords[0]?.workDate ?? seed.importedAt.slice(0, 10);
  const maxDate = allRecords[allRecords.length - 1]?.workDate ?? seed.importedAt.slice(0, 10);
  const availableDepartments = [...new Set(allRecords.map((record) => record.departmentName))].sort((left, right) => {
    return left.localeCompare(right, "en-AU");
  });
  const selectedDepartment = query.department && availableDepartments.includes(query.department) ? query.department : null;
  const selectedFrom = clampDate(query.from ?? minDate, minDate, maxDate);
  const selectedTo = clampDate(query.to ?? maxDate, minDate, maxDate);
  const filteredRecords = allRecords.filter((record) => {
    if (record.workDate < selectedFrom || record.workDate > selectedTo) {
      return false;
    }

    if (selectedDepartment && record.departmentName !== selectedDepartment) {
      return false;
    }

    return true;
  });
  const departmentRecords = new Map<string, HistoricalRecord[]>();
  const activityRecords = new Map<string, HistoricalRecord[]>();

  for (const record of filteredRecords) {
    const departmentBucket = departmentRecords.get(record.departmentName) ?? [];
    departmentBucket.push(record);
    departmentRecords.set(record.departmentName, departmentBucket);

    const activityBucket = activityRecords.get(record.activityName) ?? [];
    activityBucket.push(record);
    activityRecords.set(record.activityName, activityBucket);
  }

  const departmentBreakdown = buildBreakdown(departmentRecords);
  const activityBreakdown = buildBreakdown(activityRecords);
  const totalHours = sumHours(filteredRecords);
  const workdayCount = new Set(filteredRecords.map((record) => record.workDate)).size;
  const response: DashboardResponse = {
    employeeName: seed.employeeFilter,
    sourceFile: seed.sourceFile,
    importedAt: seed.importedAt,
    dateRangeLabel: `${formatDate(selectedFrom, { day: "numeric", month: "short", year: "numeric" })} to ${formatDate(selectedTo, {
      day: "numeric",
      month: "short",
      year: "numeric"
    })}`,
    filters: {
      availableDepartments,
      selectedDepartment,
      selectedFrom,
      selectedTo,
      minDate,
      maxDate
    },
    stats: {
      totalHours,
      workdayCount,
      averageHoursPerDay: workdayCount === 0 ? 0 : Number((totalHours / workdayCount).toFixed(2)),
      departmentCount: departmentBreakdown.length,
      activityCount: activityBreakdown.length,
      recordCount: filteredRecords.length
    },
    departmentBreakdown,
    activityBreakdown,
    recentDays: buildRecentDays(filteredRecords),
    monthlyTotals: buildMonthlyTotals(filteredRecords)
  };

  return dashboardResponseSchema.parse(response);
}