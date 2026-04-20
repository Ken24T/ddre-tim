import {
  userSettingsSchema,
  type Activity,
  type ActivityDraft,
  type Department,
  type UserSettings,
  type UserSettingsUpdate
} from "@ddre/contracts";
import { Pool } from "pg";
import { ZodError, ZodIssueCode } from "zod";
import {
  createActivityRepositoryStore,
  getDepartmentCatalog,
  type ActivityRepositoryStore
} from "./data.js";

const availableDepartments = getDepartmentCatalog();
const preferredDefaultDepartmentId = "department-property-management";
const defaultDepartmentId = availableDepartments.find(
  (department) => department.id === preferredDefaultDepartmentId
)?.id ?? availableDepartments[0]?.id ?? preferredDefaultDepartmentId;
const knownDepartmentIds = new Set(availableDepartments.map((department) => department.id));

interface QueryResultRow {
  [columnName: string]: unknown;
}

interface Queryable {
  query<Row extends QueryResultRow>(text: string, params?: readonly unknown[]): Promise<{ rows: Row[] }>;
  end?(): Promise<void>;
}

interface StoredSettingsRow extends QueryResultRow {
  settings_payload: unknown;
}

export interface UserSettingsStore {
  getUserSettings(userId: string): Promise<UserSettings>;
  upsertUserSettings(userId: string, settingsUpdate: UserSettingsUpdate): Promise<UserSettings>;
  close?(): Promise<void>;
}

export interface CreateUserSettingsStoreOptions {
  connectionString?: string;
  pool?: Queryable;
  activityRepositoryStore?: ActivityRepositoryStore;
}

const defaultNonTimedActivity: Activity = {
  id: "activity-not-timed",
  slug: "not-timed",
  name: "Not Timed",
  color: "#6B7280",
  kind: "non-timed",
  isSystem: true,
  isActive: true
};

function cloneUserSettings(settings: UserSettings): UserSettings {
  return {
    ...settings,
    departments: cloneDepartments(settings.departments),
    activities: settings.activities.map((activity) => ({ ...activity }))
  };
}

function cloneDepartments(departments: Department[]): Department[] {
  return departments.map((department) => ({ ...department }));
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

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildStoredActivities(activityDrafts: ActivityDraft[], defaultDepartmentIdForUser: string): Activity[] {
  return [
    { ...defaultNonTimedActivity },
    ...activityDrafts.map((activityDraft, index) => {
      const normalizedName = activityDraft.name.trim();
      const slug = slugify(normalizedName);
      const departmentId = activityDraft.departmentId ?? defaultDepartmentIdForUser;

      assertKnownDepartmentId(departmentId, ["activities", index, "departmentId"]);

      return {
        id: `activity-${slug}`,
        slug,
        name: normalizedName,
        color: activityDraft.color,
        departmentId,
        kind: "timed" as const,
        isSystem: false,
        isActive: activityDraft.isActive ?? true
      };
    })
  ];
}

async function getDefaultActivities(
  defaultDepartmentIdForUser: string,
  activityRepositoryStore: ActivityRepositoryStore
): Promise<Activity[]> {
  const activityCatalog = await activityRepositoryStore.getActivityCatalog();

  return [
    { ...defaultNonTimedActivity },
    ...activityCatalog.activities.map((activity) => ({
      ...activity,
      departmentId: activity.kind === "timed" ? activity.departmentId ?? defaultDepartmentIdForUser : activity.departmentId
    }))
  ];
}

async function createDefaultUserSettings(
  userId: string,
  activityRepositoryStore: ActivityRepositoryStore
): Promise<UserSettings> {
  return {
    userId,
    displayName: "",
    isConfigured: false,
    defaultDepartmentId,
    departments: cloneDepartments(availableDepartments),
    activities: await getDefaultActivities(defaultDepartmentId, activityRepositoryStore),
    updatedAt: new Date().toISOString()
  };
}

function createStoredUserSettings(userId: string, settingsUpdate: UserSettingsUpdate): UserSettings {
  assertKnownDepartmentId(settingsUpdate.defaultDepartmentId, ["defaultDepartmentId"]);

  return {
    userId,
    displayName: settingsUpdate.displayName,
    isConfigured: true,
    defaultDepartmentId: settingsUpdate.defaultDepartmentId,
    departments: cloneDepartments(availableDepartments),
    activities: buildStoredActivities(settingsUpdate.activities, settingsUpdate.defaultDepartmentId),
    updatedAt: new Date().toISOString()
  };
}

function parseStoredUserSettings(value: unknown): UserSettings {
  const rawValue = typeof value === "string" ? JSON.parse(value) : value;
  return userSettingsSchema.parse(rawValue);
}

class InMemoryUserSettingsStore implements UserSettingsStore {
  private readonly settingsStore = new Map<string, UserSettings>();

  constructor(private readonly activityRepositoryStore: ActivityRepositoryStore) {}

  async getUserSettings(userId: string): Promise<UserSettings> {
    const existingSettings = this.settingsStore.get(userId);

    if (!existingSettings) {
      return createDefaultUserSettings(userId, this.activityRepositoryStore);
    }

    return cloneUserSettings(existingSettings);
  }

  async upsertUserSettings(userId: string, settingsUpdate: UserSettingsUpdate): Promise<UserSettings> {
    const storedSettings = createStoredUserSettings(userId, settingsUpdate);
    this.settingsStore.set(userId, storedSettings);

    return cloneUserSettings(storedSettings);
  }
}

class PostgresUserSettingsStore implements UserSettingsStore {
  constructor(
    private readonly pool: Queryable,
    private readonly activityRepositoryStore: ActivityRepositoryStore,
    private readonly ownsActivityRepositoryStore = false
  ) {}

  async getUserSettings(userId: string): Promise<UserSettings> {
    const result = await this.pool.query<StoredSettingsRow>(
      "select settings_payload from user_settings_snapshots where user_id = $1",
      [userId]
    );

    if (result.rows.length === 0) {
      return createDefaultUserSettings(userId, this.activityRepositoryStore);
    }

    return cloneUserSettings(parseStoredUserSettings(result.rows[0].settings_payload));
  }

  async upsertUserSettings(userId: string, settingsUpdate: UserSettingsUpdate): Promise<UserSettings> {
    const storedSettings = createStoredUserSettings(userId, settingsUpdate);

    await this.pool.query(
      [
        "insert into user_settings_snapshots (user_id, settings_payload, updated_at)",
        "values ($1, $2::jsonb, $3::timestamptz)",
        "on conflict (user_id) do update",
        "set settings_payload = excluded.settings_payload,",
        "    updated_at = excluded.updated_at"
      ].join("\n"),
      [userId, JSON.stringify(storedSettings), storedSettings.updatedAt]
    );

    return cloneUserSettings(storedSettings);
  }

  async close(): Promise<void> {
    await this.pool.end?.();

    if (this.ownsActivityRepositoryStore) {
      await this.activityRepositoryStore.close?.();
    }
  }
}

export function createUserSettingsStore(options: CreateUserSettingsStoreOptions = {}): UserSettingsStore {
  const sharedActivityRepositoryStore = options.activityRepositoryStore;

  if (options.pool) {
    return new PostgresUserSettingsStore(
      options.pool,
      sharedActivityRepositoryStore ?? createActivityRepositoryStore({ pool: options.pool })
    );
  }

  const connectionString = options.connectionString ?? process.env.DATABASE_URL;

  if (!connectionString) {
    return new InMemoryUserSettingsStore(sharedActivityRepositoryStore ?? createActivityRepositoryStore());
  }

  const activityRepositoryStore = sharedActivityRepositoryStore ?? createActivityRepositoryStore({ connectionString });

  return new PostgresUserSettingsStore(
    new Pool({ connectionString }),
    activityRepositoryStore,
    sharedActivityRepositoryStore === undefined
  );
}