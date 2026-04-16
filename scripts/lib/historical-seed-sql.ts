import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ImportedHistoricalRecord {
  id: string;
  userId?: string;
  workDate: string;
  employeeName: string;
  departmentName: string;
  activityName: string;
  hours: number;
  sourceRowNumber: number;
}

export interface ImportedHistoricalUser {
  id: string;
  displayName: string;
  isSynthetic: boolean;
}

export interface ImportedHistoricalSeed {
  sourceFile: string;
  sheetName: string;
  employeeFilter: string;
  importedAt: string;
  recordCount: number;
  users?: ImportedHistoricalUser[];
  departments: string[];
  activities: string[];
  records: ImportedHistoricalRecord[];
}

export interface HistoricalSeedSummary {
  departmentCount: number;
  activityCount: number;
  assignmentCount: number;
  recordCount: number;
  userCount: number;
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "../..");

export const defaultHistoricalSeedPath = resolve(repoRoot, "infra/seeds/ken-boyle-historical-tim-records.json");
export const defaultHistoricalSeedSqlPath = resolve(repoRoot, "infra/sql/010_seed_ken_boyle_historical.sql");

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeComparisonValue(value: string): string {
  return normalizeWhitespace(value).toLocaleLowerCase("en-AU");
}

function toProperCase(value: string): string {
  return normalizeWhitespace(value)
    .toLocaleLowerCase("en-AU")
    .replace(/(^|[ .'-])\p{L}/gu, (segment) => segment.toLocaleUpperCase("en-AU"));
}

function slugify(value: string): string {
  return normalizeWhitespace(value)
    .toLocaleLowerCase("en-AU")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildHistoricalUserId(displayName: string): string {
  return slugify(displayName);
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function toStableUuid(value: string): string {
  const hex = createHash("sha1").update(value).digest("hex").slice(0, 32).split("");

  hex[12] = "4";
  hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16] ?? "0", 16) % 4] ?? "8";

  return [
    hex.slice(0, 8).join(""),
    hex.slice(8, 12).join(""),
    hex.slice(12, 16).join(""),
    hex.slice(16, 20).join(""),
    hex.slice(20, 32).join("")
  ].join("-");
}

function formatSqlValue(value: boolean | number | string | null): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }

  return `'${escapeSqlLiteral(value)}'`;
}

function formatValues(rows: Array<Array<boolean | number | string | null>>): string {
  return rows
    .map((row) => `  (${row.map((value) => formatSqlValue(value)).join(", ")})`)
    .join(",\n");
}

function buildInsertStatement(
  tableName: string,
  columns: string[],
  rows: Array<Array<boolean | number | string | null>>,
  onConflictClause: string
): string {
  return [
    `insert into ${tableName} (${columns.join(", ")}) values`,
    formatValues(rows),
    onConflictClause
  ].join("\n");
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => normalizeWhitespace(value)).filter(Boolean))).sort((left, right) => {
    return left.localeCompare(right, "en-AU");
  });
}

function pickDefaultDepartmentName(records: ImportedHistoricalRecord[]): string {
  const departmentHours = new Map<string, number>();

  for (const record of records) {
    const key = normalizeWhitespace(record.departmentName);
    departmentHours.set(key, (departmentHours.get(key) ?? 0) + record.hours);
  }

  const [selectedDepartmentName] = Array.from(departmentHours.entries()).sort((left, right) => {
    return right[1] - left[1] || left[0].localeCompare(right[0], "en-AU");
  })[0] ?? ["Property Management", 0];

  return selectedDepartmentName;
}

function getSeedUsers(seed: ImportedHistoricalSeed): ImportedHistoricalUser[] {
  if (seed.users && seed.users.length > 0) {
    return uniqueSorted(seed.users.map((user) => user.displayName)).map((displayName) => {
      const existingUser = seed.users?.find((user) => normalizeComparisonValue(user.displayName) === normalizeComparisonValue(displayName));

      return {
        id: existingUser?.id || buildHistoricalUserId(displayName),
        displayName,
        isSynthetic: existingUser?.isSynthetic ?? false
      };
    });
  }

  return uniqueSorted(seed.records.map((record) => record.employeeName)).map((displayName) => ({
    id: buildHistoricalUserId(displayName),
    displayName,
    isSynthetic: false
  }));
}

function getRecordUserId(record: ImportedHistoricalRecord): string {
  return record.userId ?? buildHistoricalUserId(record.employeeName);
}

function assertImportedHistoricalSeed(value: unknown): asserts value is ImportedHistoricalSeed {
  if (!value || typeof value !== "object") {
    throw new Error("Historical seed file must contain an object payload.");
  }

  const candidate = value as Partial<ImportedHistoricalSeed>;

  if (!Array.isArray(candidate.records)) {
    throw new Error("Historical seed file is missing the records array.");
  }

  if (typeof candidate.employeeFilter !== "string" || !candidate.employeeFilter.trim()) {
    throw new Error("Historical seed file is missing employeeFilter.");
  }

  if (typeof candidate.importedAt !== "string" || !candidate.importedAt.trim()) {
    throw new Error("Historical seed file is missing importedAt.");
  }

  if (typeof candidate.sourceFile !== "string" || !candidate.sourceFile.trim()) {
    throw new Error("Historical seed file is missing sourceFile.");
  }
}

export async function readImportedHistoricalSeed(seedPath = defaultHistoricalSeedPath): Promise<ImportedHistoricalSeed> {
  const rawSeed = await readFile(seedPath, "utf8");
  const parsedSeed = JSON.parse(rawSeed) as unknown;

  assertImportedHistoricalSeed(parsedSeed);

  if (parsedSeed.recordCount !== parsedSeed.records.length) {
    throw new Error("Historical seed recordCount does not match the number of records.");
  }

  return parsedSeed;
}

export function buildHistoricalSeedSql(seed: ImportedHistoricalSeed): { sql: string; summary: HistoricalSeedSummary } {
  const importedAt = seed.importedAt;
  const seedUsers = getSeedUsers(seed);
  const userRows = seedUsers.map((user) => {
    const userRecords = seed.records.filter((record) => getRecordUserId(record) === user.id);
    const defaultDepartmentName = pickDefaultDepartmentName(userRecords);

    return {
      id: toStableUuid(`user:${user.id}`),
      displayName: toProperCase(user.displayName),
      normalizedDisplayName: normalizeComparisonValue(user.displayName),
      defaultDepartmentId: toStableUuid(`department:${slugify(defaultDepartmentName)}`),
      isActive: true,
      createdAt: importedAt,
      updatedAt: importedAt
    };
  });
  const userIdBySeedUserId = new Map(seedUsers.map((user, index) => [user.id, userRows[index]?.id ?? toStableUuid(`user:${user.id}`)]));
  const departmentNames = uniqueSorted(seed.departments.length > 0 ? seed.departments : seed.records.map((record) => record.departmentName));
  const activityNames = uniqueSorted(seed.activities.length > 0 ? seed.activities : seed.records.map((record) => record.activityName));
  const departmentRows = departmentNames.map((departmentName) => ({
    id: toStableUuid(`department:${slugify(departmentName)}`),
    slug: slugify(departmentName),
    name: departmentName,
    isActive: true,
    createdAt: importedAt,
    updatedAt: importedAt
  }));
  const activityRows = [
    {
      id: toStableUuid("activity:not-timed"),
      slug: "not-timed",
      name: "Not Timed",
      kind: "non-timed",
      isSystem: true,
      isActive: true,
      departmentId: null,
      createdByUserId: null,
      createdAt: importedAt,
      updatedAt: importedAt
    },
    ...activityNames.map((activityName) => ({
      id: toStableUuid(`activity:${slugify(activityName)}`),
      slug: slugify(activityName),
      name: activityName,
      kind: "timed",
      isSystem: false,
      isActive: true,
      departmentId: null,
      createdByUserId: null,
      createdAt: importedAt,
      updatedAt: importedAt
    }))
  ];
  const assignmentRows = userRows.flatMap((user) => {
    return activityRows.map((activity, index) => ({
      userId: user.id,
      activityId: activity.id,
      sortOrder: index,
      isHidden: false,
      createdAt: importedAt,
      updatedAt: importedAt
    }));
  });

  const historicalRows = seed.records.map((record) => ({
    id: toStableUuid(`historical:${record.id}`),
    sourceRecordKey: record.id,
    workDate: record.workDate,
    employeeName: toProperCase(record.employeeName),
    departmentName: normalizeWhitespace(record.departmentName),
    activityName: normalizeWhitespace(record.activityName),
    hours: record.hours,
    sourceFile: seed.sourceFile,
    sourceRowNumber: record.sourceRowNumber,
    importedAt,
    mappedUserId: userIdBySeedUserId.get(getRecordUserId(record)) ?? toStableUuid(`user:${getRecordUserId(record)}`),
    mappedDepartmentId: toStableUuid(`department:${slugify(record.departmentName)}`),
    mappedActivityId: toStableUuid(`activity:${slugify(record.activityName)}`),
    createdAt: importedAt
  }));

  const statements = [
    `-- Generated from ${seed.sourceFile} (${seed.sheetName}) for ${userRows.length} users`,
    "begin;",
    buildInsertStatement(
      "departments",
      ["id", "slug", "name", "is_active", "created_at", "updated_at"],
      departmentRows.map((department) => [
        department.id,
        department.slug,
        department.name,
        department.isActive,
        department.createdAt,
        department.updatedAt
      ]),
      [
        "on conflict (slug) do update",
        "set name = excluded.name,",
        "    is_active = excluded.is_active,",
        "    updated_at = excluded.updated_at;"
      ].join("\n")
    ),
    buildInsertStatement(
      "users",
      ["id", "display_name", "normalized_display_name", "default_department_id", "is_active", "created_at", "updated_at"],
      userRows.map((user) => [
        user.id,
        user.displayName,
        user.normalizedDisplayName,
        user.defaultDepartmentId,
        user.isActive,
        user.createdAt,
        user.updatedAt
      ]),
      [
        "on conflict (id) do update",
        "set display_name = excluded.display_name,",
        "    normalized_display_name = excluded.normalized_display_name,",
        "    default_department_id = excluded.default_department_id,",
        "    is_active = excluded.is_active,",
        "    updated_at = excluded.updated_at;"
      ].join("\n")
    ),
    buildInsertStatement(
      "activities",
      ["id", "slug", "name", "kind", "is_system", "is_active", "department_id", "created_by_user_id", "created_at", "updated_at"],
      activityRows.map((activity) => [
        activity.id,
        activity.slug,
        activity.name,
        activity.kind,
        activity.isSystem,
        activity.isActive,
        activity.departmentId,
        activity.createdByUserId,
        activity.createdAt,
        activity.updatedAt
      ]),
      [
        "on conflict (slug) do update",
        "set name = excluded.name,",
        "    kind = excluded.kind,",
        "    is_system = excluded.is_system,",
        "    is_active = excluded.is_active,",
        "    department_id = excluded.department_id,",
        "    created_by_user_id = excluded.created_by_user_id,",
        "    updated_at = excluded.updated_at;"
      ].join("\n")
    ),
    buildInsertStatement(
      "user_activity_assignments",
      ["user_id", "activity_id", "sort_order", "is_hidden", "created_at", "updated_at"],
      assignmentRows.map((assignment) => [
        assignment.userId,
        assignment.activityId,
        assignment.sortOrder,
        assignment.isHidden,
        assignment.createdAt,
        assignment.updatedAt
      ]),
      [
        "on conflict (user_id, activity_id) do update",
        "set sort_order = excluded.sort_order,",
        "    is_hidden = excluded.is_hidden,",
        "    updated_at = excluded.updated_at;"
      ].join("\n")
    ),
    buildInsertStatement(
      "historical_tim_daily_records",
      [
        "id",
        "source_record_key",
        "work_date",
        "employee_name",
        "department_name",
        "activity_name",
        "hours",
        "source_file",
        "source_row_number",
        "imported_at",
        "mapped_user_id",
        "mapped_department_id",
        "mapped_activity_id",
        "created_at"
      ],
      historicalRows.map((record) => [
        record.id,
        record.sourceRecordKey,
        record.workDate,
        record.employeeName,
        record.departmentName,
        record.activityName,
        record.hours,
        record.sourceFile,
        record.sourceRowNumber,
        record.importedAt,
        record.mappedUserId,
        record.mappedDepartmentId,
        record.mappedActivityId,
        record.createdAt
      ]),
      [
        "on conflict (source_record_key) do update",
        "set work_date = excluded.work_date,",
        "    employee_name = excluded.employee_name,",
        "    department_name = excluded.department_name,",
        "    activity_name = excluded.activity_name,",
        "    hours = excluded.hours,",
        "    source_file = excluded.source_file,",
        "    source_row_number = excluded.source_row_number,",
        "    imported_at = excluded.imported_at,",
        "    mapped_user_id = excluded.mapped_user_id,",
        "    mapped_department_id = excluded.mapped_department_id,",
        "    mapped_activity_id = excluded.mapped_activity_id;"
      ].join("\n")
    ),
    "commit;"
  ];

  return {
    sql: `${statements.join("\n\n")}\n`,
    summary: {
      departmentCount: departmentRows.length,
      activityCount: activityRows.length,
      assignmentCount: assignmentRows.length,
      recordCount: historicalRows.length,
      userCount: userRows.length
    }
  };
}