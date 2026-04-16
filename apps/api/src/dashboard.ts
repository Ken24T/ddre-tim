import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  dashboardQuerySchema,
  dashboardResponseSchema,
  type DashboardBreakdownRow,
  type DashboardMonthlyUserTotal,
  type DashboardQuery,
  type DashboardRecentDay,
  type DashboardResponse,
  type DashboardUserBreakdownRow,
  type DashboardUserOption
} from "@ddre/contracts";
import { z } from "zod";

const userSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  isSynthetic: z.boolean()
});

const historicalRecordSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1).optional(),
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
  users: z.array(userSchema).optional(),
  departments: z.array(z.string().min(1)),
  activities: z.array(z.string().min(1)),
  records: z.array(historicalRecordSchema)
});

type HistoricalRecord = z.infer<typeof historicalRecordSchema>;
type HistoricalSeed = z.infer<typeof historicalSeedSchema>;
type HistoricalUser = z.infer<typeof userSchema>;

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(moduleDirectory, "../../..");
const historicalSeedPath = resolve(workspaceRoot, "infra/seeds/ken-boyle-historical-tim-records.json");
const userPalette = ["#EEF8FC", "#B9D9EA", "#92D0C8", "#6EA6CF", "#4B79B4", "#72BCB5"];

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

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeComparisonValue(value: string): string {
  return normalizeWhitespace(value).toLocaleLowerCase("en-AU");
}

function buildFallbackUserId(displayName: string): string {
  return normalizeWhitespace(displayName)
    .toLocaleLowerCase("en-AU")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getRecordUserId(record: HistoricalRecord): string {
  return record.userId ?? buildFallbackUserId(record.employeeName);
}

function buildUsers(seed: HistoricalSeed): HistoricalUser[] {
  if (seed.users && seed.users.length > 0) {
    return [...seed.users].sort((left, right) => left.displayName.localeCompare(right.displayName, "en-AU"));
  }

  return Array.from(
    new Map(
      seed.records.map((record) => [
        getRecordUserId(record),
        {
          id: getRecordUserId(record),
          displayName: normalizeWhitespace(record.employeeName),
          isSynthetic: false
        }
      ])
    ).values()
  ).sort((left, right) => left.displayName.localeCompare(right.displayName, "en-AU"));
}

function buildUserColorMap(users: HistoricalUser[]): Map<string, string> {
  return new Map(
    users.map((user, index) => [user.id, userPalette[index % userPalette.length] ?? "#6EA6CF"])
  );
}

function buildScopeLabel(selectedUsers: HistoricalUser[], allUsers: HistoricalUser[]): string {
  if (selectedUsers.length === 0) {
    return "No users in scope";
  }

  if (selectedUsers.length === allUsers.length) {
    return "All users";
  }

  if (selectedUsers.length === 1) {
    return selectedUsers[0]?.displayName ?? "User";
  }

  return `${selectedUsers[0]?.displayName ?? "User"} + ${selectedUsers.length - 1} more`;
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

function buildUserBreakdown(
  rows: Map<string, HistoricalRecord[]>,
  userById: Map<string, HistoricalUser>,
  userColorById: Map<string, string>
): DashboardUserBreakdownRow[] {
  return Array.from(rows.entries(), ([userId, records]) => ({
    userId,
    label: userById.get(userId)?.displayName ?? records[0]?.employeeName ?? userId,
    color: userColorById.get(userId) ?? "#6EA6CF",
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

function buildMonthlyUserTotals(
  records: HistoricalRecord[],
  userById: Map<string, HistoricalUser>,
  userColorById: Map<string, string>
): DashboardMonthlyUserTotal[] {
  const months = new Map<string, Map<string, number>>();

  for (const record of records) {
    const monthKey = record.workDate.slice(0, 7);
    const userId = getRecordUserId(record);
    const monthBuckets = months.get(monthKey) ?? new Map<string, number>();

    monthBuckets.set(userId, Number(((monthBuckets.get(userId) ?? 0) + record.hours).toFixed(2)));
    months.set(monthKey, monthBuckets);
  }

  return Array.from(months.entries(), ([monthKey, values]) => ({
    monthKey,
    label: formatDate(`${monthKey}-01`, { month: "short", year: "numeric" }),
    totalHours: Number(Array.from(values.values()).reduce((total, value) => total + value, 0).toFixed(2)),
    segments: Array.from(values.entries())
      .map(([userId, hours]) => ({
        userId,
        label: userById.get(userId)?.displayName ?? userId,
        color: userColorById.get(userId) ?? "#6EA6CF",
        hours
      }))
      .sort((left, right) => right.hours - left.hours || left.label.localeCompare(right.label, "en-AU"))
  })).sort((left, right) => left.monthKey.localeCompare(right.monthKey));
}

function buildAvailableUsers(
  users: HistoricalUser[],
  records: HistoricalRecord[],
  userColorById: Map<string, string>,
  selectedUserIds: string[]
): DashboardUserOption[] {
  const recordsByUser = new Map<string, HistoricalRecord[]>();

  for (const record of records) {
    const userId = getRecordUserId(record);
    const bucket = recordsByUser.get(userId) ?? [];
    bucket.push(record);
    recordsByUser.set(userId, bucket);
  }

  return users.map((user) => {
    const userRecords = recordsByUser.get(user.id) ?? [];

    return {
      id: user.id,
      displayName: user.displayName,
      color: userColorById.get(user.id) ?? "#6EA6CF",
      isSelected: selectedUserIds.includes(user.id),
      totalHours: sumHours(userRecords),
      recordCount: userRecords.length
    };
  });
}

async function readHistoricalSeed(): Promise<HistoricalSeed> {
  const fileContents = await readFile(historicalSeedPath, "utf8");

  return historicalSeedSchema.parse(JSON.parse(fileContents));
}

export async function getDashboardReadModel(rawQuery: unknown): Promise<DashboardResponse> {
  const query = dashboardQuerySchema.parse(rawQuery) as DashboardQuery;
  const seed = await readHistoricalSeed();
  const users = buildUsers(seed);
  const userById = new Map(users.map((user) => [user.id, user]));
  const userColorById = buildUserColorMap(users);
  const allRecords = [...seed.records].sort((left, right) => left.workDate.localeCompare(right.workDate));
  const minDate = allRecords[0]?.workDate ?? seed.importedAt.slice(0, 10);
  const maxDate = allRecords[allRecords.length - 1]?.workDate ?? seed.importedAt.slice(0, 10);
  const availableDepartments = [...new Set(allRecords.map((record) => record.departmentName))].sort((left, right) => {
    return left.localeCompare(right, "en-AU");
  });
  const selectedDepartment = query.department && availableDepartments.includes(query.department) ? query.department : null;
  const selectedFrom = clampDate(query.from ?? minDate, minDate, maxDate);
  const selectedTo = clampDate(query.to ?? maxDate, minDate, maxDate);
  const scopedRecords = allRecords.filter((record) => {
    if (record.workDate < selectedFrom || record.workDate > selectedTo) {
      return false;
    }

    if (selectedDepartment && record.departmentName !== selectedDepartment) {
      return false;
    }

    return true;
  });
  const availableUsers = users.filter((user) => scopedRecords.some((record) => getRecordUserId(record) === user.id));
  const selectedUserIds = query.userIds.filter((userId) => availableUsers.some((user) => user.id === userId));
  const effectiveSelectedUserIds = selectedUserIds.length > 0 ? selectedUserIds : availableUsers.map((user) => user.id);
  const filteredRecords = scopedRecords.filter((record) => effectiveSelectedUserIds.includes(getRecordUserId(record)));
  const selectedUsers = availableUsers.filter((user) => effectiveSelectedUserIds.includes(user.id));
  const userRecords = new Map<string, HistoricalRecord[]>();
  const departmentRecords = new Map<string, HistoricalRecord[]>();
  const activityRecords = new Map<string, HistoricalRecord[]>();

  for (const record of filteredRecords) {
    const userBucket = userRecords.get(getRecordUserId(record)) ?? [];
    userBucket.push(record);
    userRecords.set(getRecordUserId(record), userBucket);

    const departmentBucket = departmentRecords.get(record.departmentName) ?? [];
    departmentBucket.push(record);
    departmentRecords.set(record.departmentName, departmentBucket);

    const activityBucket = activityRecords.get(record.activityName) ?? [];
    activityBucket.push(record);
    activityRecords.set(record.activityName, activityBucket);
  }

  const userBreakdown = buildUserBreakdown(userRecords, userById, userColorById);
  const departmentBreakdown = buildBreakdown(departmentRecords);
  const activityBreakdown = buildBreakdown(activityRecords);
  const totalHours = sumHours(filteredRecords);
  const workdayCount = new Set(filteredRecords.map((record) => record.workDate)).size;
  const userDayCount = new Set(filteredRecords.map((record) => `${getRecordUserId(record)}|${record.workDate}`)).size;
  const scopeLabel = buildScopeLabel(selectedUsers, availableUsers);
  const response: DashboardResponse = {
    scopeLabel,
    employeeName: scopeLabel,
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
      availableUsers: buildAvailableUsers(availableUsers, scopedRecords, userColorById, effectiveSelectedUserIds),
      selectedUserIds: effectiveSelectedUserIds,
      selectedFrom,
      selectedTo,
      minDate,
      maxDate
    },
    stats: {
      totalHours,
      workdayCount,
      averageHoursPerDay: workdayCount === 0 ? 0 : Number((totalHours / workdayCount).toFixed(2)),
      userDayCount,
      averageHoursPerUserDay: userDayCount === 0 ? 0 : Number((totalHours / userDayCount).toFixed(2)),
      selectedUserCount: selectedUsers.length,
      departmentCount: departmentBreakdown.length,
      activityCount: activityBreakdown.length,
      recordCount: filteredRecords.length
    },
    userBreakdown,
    departmentBreakdown,
    activityBreakdown,
    recentDays: buildRecentDays(filteredRecords),
    monthlyTotals: buildMonthlyTotals(filteredRecords),
    monthlyUserTotals: buildMonthlyUserTotals(filteredRecords, userById, userColorById)
  };

  return dashboardResponseSchema.parse(response);
}