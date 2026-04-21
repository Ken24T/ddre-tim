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
import { readLocalStateJson, writeLocalStateJson } from "./localState.js";

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

interface StoredUserSettingsState {
  users: Record<string, UserSettings>;
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
    activities: settings.activities.map((activity) => ({
      ...activity,
      departmentIds: activity.departmentIds ? [...activity.departmentIds] : undefined
    }))
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

function getSharedActivitySlugs(activities: Activity[]): Set<string> {
  return new Set(activities.filter((activity) => !activity.isSystem && activity.kind === "timed").map((activity) => activity.slug));
}

function buildStoredCustomActivities(
  activityDrafts: ActivityDraft[],
  defaultDepartmentIdForUser: string,
  sharedActivitySlugs: ReadonlySet<string>
): Activity[] {
  return activityDrafts.flatMap((activityDraft, index) => {
    const normalizedName = activityDraft.name.trim();
    const slug = slugify(normalizedName);

    if (slug === defaultNonTimedActivity.slug || sharedActivitySlugs.has(slug)) {
      return [];
    }

    const departmentId = activityDraft.departmentId ?? defaultDepartmentIdForUser;

    assertKnownDepartmentId(departmentId, ["activities", index, "departmentId"]);

    return [
      {
        id: `activity-${slug}`,
        slug,
        name: normalizedName,
        color: activityDraft.color,
        departmentId,
        departmentIds: [departmentId],
        kind: "timed" as const,
        isSystem: false,
        isActive: activityDraft.isActive ?? true
      }
    ];
  });
}

function normalizeStoredCustomActivity(
  activity: Activity,
  defaultDepartmentIdForUser: string,
  sharedActivitySlugs: ReadonlySet<string>
): Activity | null {
  if (activity.isSystem || activity.slug === defaultNonTimedActivity.slug || sharedActivitySlugs.has(activity.slug)) {
    return null;
  }

  const departmentId = activity.departmentId ?? activity.departmentIds?.[0] ?? defaultDepartmentIdForUser;

  assertKnownDepartmentId(departmentId, ["activities", activity.id, "departmentId"]);

  return {
    ...activity,
    departmentId,
    departmentIds: [departmentId],
    kind: "timed",
    isSystem: false
  };
}

async function getDefaultActivities(
  defaultDepartmentIdForUser: string,
  activityRepositoryStore: ActivityRepositoryStore
): Promise<Activity[]> {
  const activityCatalog = await activityRepositoryStore.getActivityCatalog();

  return [
    { ...defaultNonTimedActivity },
    ...activityCatalog.activities.map((activity) => {
      const activityDepartmentIds = activity.departmentIds && activity.departmentIds.length > 0
        ? [...activity.departmentIds]
        : activity.departmentId
          ? [activity.departmentId]
          : [];
      const primaryDepartmentId =
        activity.kind === "timed"
          ? activity.departmentId ?? activityDepartmentIds[0] ?? defaultDepartmentIdForUser
          : activity.departmentId;

      return {
        ...activity,
        departmentId: primaryDepartmentId,
        departmentIds: activityDepartmentIds.length > 0 ? activityDepartmentIds : undefined
      };
    })
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

async function hydrateUserSettings(
  settings: UserSettings,
  activityRepositoryStore: ActivityRepositoryStore
): Promise<UserSettings> {
  const sharedActivities = await getDefaultActivities(settings.defaultDepartmentId, activityRepositoryStore);
  const sharedActivitySlugs = getSharedActivitySlugs(sharedActivities);
  const seenCustomSlugs = new Set<string>();
  const customActivities: Activity[] = [];

  for (const activity of settings.activities) {
    const normalizedActivity = normalizeStoredCustomActivity(activity, settings.defaultDepartmentId, sharedActivitySlugs);

    if (!normalizedActivity || seenCustomSlugs.has(normalizedActivity.slug)) {
      continue;
    }

    seenCustomSlugs.add(normalizedActivity.slug);
    customActivities.push(normalizedActivity);
  }

  return {
    ...settings,
    departments: cloneDepartments(availableDepartments),
    activities: [...sharedActivities, ...customActivities]
  };
}

async function createStoredUserSettings(
  userId: string,
  settingsUpdate: UserSettingsUpdate,
  activityRepositoryStore: ActivityRepositoryStore
): Promise<UserSettings> {
  assertKnownDepartmentId(settingsUpdate.defaultDepartmentId, ["defaultDepartmentId"]);

  const sharedActivities = await getDefaultActivities(settingsUpdate.defaultDepartmentId, activityRepositoryStore);
  const sharedActivitySlugs = getSharedActivitySlugs(sharedActivities);

  return {
    userId,
    displayName: settingsUpdate.displayName,
    isConfigured: true,
    defaultDepartmentId: settingsUpdate.defaultDepartmentId,
    departments: cloneDepartments(availableDepartments),
    activities: buildStoredCustomActivities(
      settingsUpdate.activities,
      settingsUpdate.defaultDepartmentId,
      sharedActivitySlugs
    ),
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

    return hydrateUserSettings(existingSettings, this.activityRepositoryStore);
  }

  async upsertUserSettings(userId: string, settingsUpdate: UserSettingsUpdate): Promise<UserSettings> {
    const storedSettings = await createStoredUserSettings(userId, settingsUpdate, this.activityRepositoryStore);
    this.settingsStore.set(userId, storedSettings);

    return hydrateUserSettings(storedSettings, this.activityRepositoryStore);
  }
}

class FileUserSettingsStore implements UserSettingsStore {
  private readonly stateFileName = "user-settings.json";

  constructor(private readonly activityRepositoryStore: ActivityRepositoryStore) {}

  private async readState(): Promise<StoredUserSettingsState> {
    const storedState = await readLocalStateJson<StoredUserSettingsState>(this.stateFileName, { users: {} });
    const users = Object.fromEntries(
      Object.entries(storedState.users).map(([userId, settings]) => [userId, userSettingsSchema.parse(settings)])
    );

    return { users };
  }

  private async writeState(state: StoredUserSettingsState): Promise<void> {
    await writeLocalStateJson(this.stateFileName, state);
  }

  async getUserSettings(userId: string): Promise<UserSettings> {
    const state = await this.readState();
    const existingSettings = state.users[userId];

    if (!existingSettings) {
      return createDefaultUserSettings(userId, this.activityRepositoryStore);
    }

    return hydrateUserSettings(existingSettings, this.activityRepositoryStore);
  }

  async upsertUserSettings(userId: string, settingsUpdate: UserSettingsUpdate): Promise<UserSettings> {
    const state = await this.readState();
    const storedSettings = await createStoredUserSettings(userId, settingsUpdate, this.activityRepositoryStore);

    state.users[userId] = storedSettings;
    await this.writeState(state);

    return hydrateUserSettings(storedSettings, this.activityRepositoryStore);
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

    return hydrateUserSettings(parseStoredUserSettings(result.rows[0].settings_payload), this.activityRepositoryStore);
  }

  async upsertUserSettings(userId: string, settingsUpdate: UserSettingsUpdate): Promise<UserSettings> {
    const storedSettings = await createStoredUserSettings(userId, settingsUpdate, this.activityRepositoryStore);

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

    return hydrateUserSettings(storedSettings, this.activityRepositoryStore);
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
    return new FileUserSettingsStore(sharedActivityRepositoryStore ?? createActivityRepositoryStore());
  }

  const activityRepositoryStore = sharedActivityRepositoryStore ?? createActivityRepositoryStore({ connectionString });

  return new PostgresUserSettingsStore(
    new Pool({ connectionString }),
    activityRepositoryStore,
    sharedActivityRepositoryStore === undefined
  );
}