import {
  activityCatalogEntryInputSchema,
  activityCatalogResponseSchema,
  activitySchema,
  departmentCatalogResponseSchema,
  type Activity,
  type ActivityCatalogEntryInput,
  type ActivityCatalogResponse,
  type Department,
  type DepartmentCatalogResponse
} from "@ddre/contracts";
import { Pool } from "pg";
import { ZodError, ZodIssueCode } from "zod";

export class ActivityCatalogNotFoundError extends Error {
  constructor(activityId: string) {
    super(`Activity repository entry '${activityId}' was not found.`);
    this.name = "ActivityCatalogNotFoundError";
  }
}

interface QueryResultRow {
  [columnName: string]: unknown;
}

interface Queryable {
  query<Row extends QueryResultRow>(text: string, params?: readonly unknown[]): Promise<{ rows: Row[] }>;
  end?(): Promise<void>;
}

interface ActivityRepositoryRow extends QueryResultRow {
  id: string;
  slug: string;
  name: string;
  color: string | null;
  department_id: string | null;
  department_ids: unknown;
  kind: string;
  is_system: boolean;
  is_active: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

interface CountRow extends QueryResultRow {
  count: number | string;
}

export interface ActivityRepositoryStore {
  getActivityCatalog(): Promise<ActivityCatalogResponse>;
  createActivityCatalogEntry(input: ActivityCatalogEntryInput): Promise<Activity>;
  updateActivityCatalogEntry(activityId: string, input: ActivityCatalogEntryInput): Promise<Activity>;
  close?(): Promise<void>;
}

export interface CreateActivityRepositoryStoreOptions {
  connectionString?: string;
  pool?: Queryable;
}

const knownDepartments: Department[] = [
  {
    id: "department-property-management",
    slug: "property-management",
    name: "Property Management",
    isActive: true
  },
  {
    id: "department-sales",
    slug: "sales",
    name: "Sales",
    isActive: true
  },
  {
    id: "department-administration",
    slug: "administration",
    name: "Administration",
    isActive: true
  },
  {
    id: "department-accounts",
    slug: "accounts",
    name: "Accounts",
    isActive: true
  },
  {
    id: "department-business-development",
    slug: "business-development",
    name: "Business Development",
    isActive: true
  },
  {
    id: "department-company",
    slug: "company",
    name: "Company",
    isActive: true
  },
  {
    id: "department-human-resources",
    slug: "human-resources",
    name: "Human Resources",
    isActive: true
  },
  {
    id: "department-office",
    slug: "office",
    name: "Office",
    isActive: true
  }
];

const knownDepartmentIds = new Set(knownDepartments.map((department) => department.id));

const initialKnownActivities: Activity[] = [
  {
    id: "activity-design",
    slug: "design",
    name: "Design",
    color: "#0D9488",
    departmentId: "department-business-development",
    departmentIds: ["department-business-development"],
    kind: "timed",
    isSystem: false,
    isActive: true
  },
  {
    id: "activity-development",
    slug: "development",
    name: "Development",
    color: "#1D4ED8",
    departmentId: "department-business-development",
    departmentIds: ["department-business-development"],
    kind: "timed",
    isSystem: false,
    isActive: true
  },
  {
    id: "activity-review",
    slug: "review",
    name: "Review",
    color: "#9333EA",
    departmentId: "department-property-management",
    departmentIds: ["department-property-management"],
    kind: "timed",
    isSystem: false,
    isActive: true
  },
  {
    id: "activity-admin",
    slug: "admin",
    name: "Admin",
    color: "#EA580C",
    departmentId: "department-administration",
    departmentIds: ["department-administration"],
    kind: "timed",
    isSystem: false,
    isActive: true
  }
];

function cloneActivity(activity: Activity): Activity {
  return {
    ...activity,
    departmentIds: activity.departmentIds ? [...activity.departmentIds] : undefined
  };
}

function cloneDepartment(department: Department): Department {
  return { ...department };
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function slugify(value: string): string {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function assertKnownDepartmentId(departmentId: string, path: Array<string | number>): void {
  if (knownDepartmentIds.has(departmentId)) {
    return;
  }

  throw new ZodError([
    {
      code: ZodIssueCode.custom,
      message: "departmentId must refer to a known department",
      path
    }
  ]);
}

function assertKnownDepartmentIds(departmentIds: string[], path: Array<string | number>): void {
  departmentIds.forEach((departmentId, index) => {
    assertKnownDepartmentId(departmentId, [...path, index]);
  });
}

function normalizeDepartmentIds(departmentIds: string[]): string[] {
  return Array.from(new Set(departmentIds.map((departmentId) => departmentId.trim()).filter((departmentId) => departmentId.length > 0)));
}

function getActivityDepartmentIds(activity: Pick<Activity, "departmentId" | "departmentIds">): string[] {
  if (activity.departmentIds && activity.departmentIds.length > 0) {
    return normalizeDepartmentIds(activity.departmentIds);
  }

  return activity.departmentId ? [activity.departmentId] : [];
}

function parseActivityRepositoryDepartmentIds(rawValue: unknown, fallbackDepartmentId?: string | null): string[] {
  if (Array.isArray(rawValue)) {
    return normalizeDepartmentIds(rawValue.filter((value): value is string => typeof value === "string"));
  }

  if (typeof rawValue === "string") {
    try {
      const parsed = JSON.parse(rawValue) as unknown;

      if (Array.isArray(parsed)) {
        return normalizeDepartmentIds(parsed.filter((value): value is string => typeof value === "string"));
      }
    } catch {
      return fallbackDepartmentId ? [fallbackDepartmentId] : [];
    }
  }

  return fallbackDepartmentId ? [fallbackDepartmentId] : [];
}

function assertUniqueActivitySlug(
  activities: Activity[],
  slug: string,
  path: Array<string | number>,
  excludeId?: string
): void {
  const duplicate = activities.find((activity) => activity.slug === slug && activity.id !== excludeId);

  if (!duplicate) {
    return;
  }

  throw new ZodError([
    {
      code: ZodIssueCode.custom,
      message: "activity names must be unique within the shared repository",
      path
    }
  ]);
}

function toIsoTimestamp(value: Date | string | undefined): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "string") {
    return new Date(value).toISOString();
  }

  return new Date().toISOString();
}

function buildActivityCatalogEntry(
  input: ActivityCatalogEntryInput,
  existingActivities: Activity[],
  existingId?: string
): Activity {
  const parsed = activityCatalogEntryInputSchema.parse(input);
  const normalizedName = normalizeWhitespace(parsed.name);
  const slug = slugify(normalizedName);
  const departmentIds = normalizeDepartmentIds(parsed.departmentIds);
  const primaryDepartmentId = departmentIds[0];

  assertKnownDepartmentIds(departmentIds, ["departmentIds"]);
  assertUniqueActivitySlug(existingActivities, slug, ["name"], existingId);

  return activitySchema.parse({
    id: existingId ?? `activity-${slug}`,
    slug,
    name: normalizedName,
    color: parsed.color,
    departmentId: primaryDepartmentId,
    departmentIds,
    kind: "timed",
    isSystem: false,
    isActive: parsed.isActive
  });
}

function buildRefreshedAt(activities: Activity[], timestamps: string[]): string {
  if (timestamps.length === 0 || activities.length === 0) {
    return new Date().toISOString();
  }

  return timestamps.reduce((latest, current) => (current > latest ? current : latest));
}

export function getDepartmentCatalog(): Department[] {
  return knownDepartments.map(cloneDepartment);
}

export function getDepartmentCatalogResponse(): DepartmentCatalogResponse {
  return departmentCatalogResponseSchema.parse({
    departments: getDepartmentCatalog(),
    refreshedAt: new Date().toISOString()
  });
}

class InMemoryActivityRepositoryStore implements ActivityRepositoryStore {
  private knownActivities = initialKnownActivities.map(cloneActivity);
  private catalogRefreshedAt = new Date().toISOString();

  async getActivityCatalog(): Promise<ActivityCatalogResponse> {
    return activityCatalogResponseSchema.parse({
      activities: this.knownActivities.map(cloneActivity),
      refreshedAt: this.catalogRefreshedAt
    });
  }

  async createActivityCatalogEntry(input: ActivityCatalogEntryInput): Promise<Activity> {
    const activity = buildActivityCatalogEntry(input, this.knownActivities);

    this.knownActivities = [...this.knownActivities, activity];
    this.catalogRefreshedAt = new Date().toISOString();

    return cloneActivity(activity);
  }

  async updateActivityCatalogEntry(activityId: string, input: ActivityCatalogEntryInput): Promise<Activity> {
    const existingActivity = this.knownActivities.find((activity) => activity.id === activityId && !activity.isSystem);

    if (!existingActivity) {
      throw new ActivityCatalogNotFoundError(activityId);
    }

    const nextActivity = buildActivityCatalogEntry(input, this.knownActivities, existingActivity.id);

    this.knownActivities = this.knownActivities.map((activity) => (activity.id === activityId ? nextActivity : activity));
    this.catalogRefreshedAt = new Date().toISOString();

    return cloneActivity(nextActivity);
  }
}

class PostgresActivityRepositoryStore implements ActivityRepositoryStore {
  private initialized = false;

  constructor(private readonly pool: Queryable) {}

  private mapRow(row: ActivityRepositoryRow): Activity {
    const departmentIds = parseActivityRepositoryDepartmentIds(row.department_ids, row.department_id);

    return activitySchema.parse({
      id: row.id,
      slug: row.slug,
      name: row.name,
      color: row.color ?? undefined,
      departmentId: departmentIds[0] ?? row.department_id ?? undefined,
      departmentIds: departmentIds.length > 0 ? departmentIds : undefined,
      kind: row.kind === "non-timed" ? "non-timed" : "timed",
      isSystem: row.is_system,
      isActive: row.is_active
    });
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.pool.query(
      [
        "alter table if exists activity_repository_entries",
        "add column if not exists department_ids jsonb not null default '[]'::jsonb"
      ].join("\n")
    );

    await this.pool.query(
      [
        "update activity_repository_entries",
        "set department_ids = case",
        "  when department_id is null then '[]'::jsonb",
        "  else to_jsonb(array[department_id])",
        "end",
        "where department_id is not null and department_ids = '[]'::jsonb"
      ].join("\n")
    );

    const result = await this.pool.query<CountRow>("select count(*) as count from activity_repository_entries");
    const rowCount = Number(result.rows[0]?.count ?? 0);

    if (rowCount === 0) {
      const now = new Date().toISOString();

      for (const activity of initialKnownActivities) {
        await this.pool.query(
          [
            "insert into activity_repository_entries (id, slug, name, color, department_id, department_ids, kind, is_system, is_active, created_at, updated_at)",
            "values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10::timestamptz, $11::timestamptz)"
          ].join("\n"),
          [
            activity.id,
            activity.slug,
            activity.name,
            activity.color ?? null,
            activity.departmentId ?? null,
            JSON.stringify(getActivityDepartmentIds(activity)),
            activity.kind,
            activity.isSystem,
            activity.isActive,
            now,
            now
          ]
        );
      }
    }

    this.initialized = true;
  }

  private async readActivities(): Promise<{ activities: Activity[]; refreshedAt: string }> {
    await this.ensureInitialized();

    const result = await this.pool.query<ActivityRepositoryRow>(
      [
        "select id, slug, name, color, department_id, department_ids, kind, is_system, is_active, created_at, updated_at",
        "from activity_repository_entries",
        "order by is_active desc, is_system asc, name asc"
      ].join("\n")
    );

    const activities = result.rows.map((row) => this.mapRow(row));
    const refreshedAt = buildRefreshedAt(
      activities,
      result.rows.map((row) => toIsoTimestamp(row.updated_at ?? row.created_at))
    );

    return { activities, refreshedAt };
  }

  async getActivityCatalog(): Promise<ActivityCatalogResponse> {
    const { activities, refreshedAt } = await this.readActivities();

    return activityCatalogResponseSchema.parse({
      activities,
      refreshedAt
    });
  }

  async createActivityCatalogEntry(input: ActivityCatalogEntryInput): Promise<Activity> {
    const { activities } = await this.readActivities();
    const activity = buildActivityCatalogEntry(input, activities);
    const activityDepartmentIds = getActivityDepartmentIds(activity);
    const now = new Date().toISOString();

    await this.pool.query(
      [
        "insert into activity_repository_entries (id, slug, name, color, department_id, department_ids, kind, is_system, is_active, created_at, updated_at)",
        "values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10::timestamptz, $11::timestamptz)"
      ].join("\n"),
      [
        activity.id,
        activity.slug,
        activity.name,
        activity.color ?? null,
        activity.departmentId ?? null,
        JSON.stringify(activityDepartmentIds),
        activity.kind,
        activity.isSystem,
        activity.isActive,
        now,
        now
      ]
    );

    return cloneActivity(activity);
  }

  async updateActivityCatalogEntry(activityId: string, input: ActivityCatalogEntryInput): Promise<Activity> {
    const { activities } = await this.readActivities();
    const existingActivity = activities.find((activity) => activity.id === activityId && !activity.isSystem);

    if (!existingActivity) {
      throw new ActivityCatalogNotFoundError(activityId);
    }

    const nextActivity = buildActivityCatalogEntry(input, activities, existingActivity.id);
    const nextActivityDepartmentIds = getActivityDepartmentIds(nextActivity);
    const now = new Date().toISOString();

    await this.pool.query(
      [
        "update activity_repository_entries",
        "set slug = $2,",
        "    name = $3,",
        "    color = $4,",
        "    department_id = $5,",
        "    department_ids = $6::jsonb,",
        "    is_active = $7,",
        "    updated_at = $8::timestamptz",
        "where id = $1"
      ].join("\n"),
      [
        activityId,
        nextActivity.slug,
        nextActivity.name,
        nextActivity.color ?? null,
        nextActivity.departmentId ?? null,
        JSON.stringify(nextActivityDepartmentIds),
        nextActivity.isActive,
        now
      ]
    );

    return cloneActivity(nextActivity);
  }

  async close(): Promise<void> {
    await this.pool.end?.();
  }
}

export function createActivityRepositoryStore(
  options: CreateActivityRepositoryStoreOptions = {}
): ActivityRepositoryStore {
  if (options.pool) {
    return new PostgresActivityRepositoryStore(options.pool);
  }

  const connectionString = options.connectionString ?? process.env.DATABASE_URL;

  if (!connectionString) {
    return new InMemoryActivityRepositoryStore();
  }

  return new PostgresActivityRepositoryStore(new Pool({ connectionString }));
}