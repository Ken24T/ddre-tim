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
import { ZodError, ZodIssueCode } from "zod";

export class ActivityCatalogNotFoundError extends Error {
  constructor(activityId: string) {
    super(`Activity repository entry '${activityId}' was not found.`);
    this.name = "ActivityCatalogNotFoundError";
  }
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
    kind: "timed",
    isSystem: false,
    isActive: true
  }
];

let knownActivities = initialKnownActivities.map((activity) => ({ ...activity }));
let catalogRefreshedAt = new Date().toISOString();

function cloneActivity(activity: Activity): Activity {
  return { ...activity };
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

function assertUniqueActivitySlug(slug: string, path: Array<string | number>, excludeId?: string): void {
  const duplicate = knownActivities.find((activity) => activity.slug === slug && activity.id !== excludeId);

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

function touchCatalog(): void {
  catalogRefreshedAt = new Date().toISOString();
}

function buildActivityCatalogEntry(input: ActivityCatalogEntryInput, existingId?: string): Activity {
  const parsed = activityCatalogEntryInputSchema.parse(input);
  const normalizedName = normalizeWhitespace(parsed.name);
  const slug = slugify(normalizedName);

  assertKnownDepartmentId(parsed.departmentId, ["departmentId"]);
  assertUniqueActivitySlug(slug, ["name"], existingId);

  return activitySchema.parse({
    id: existingId ?? `activity-${slug}`,
    slug,
    name: normalizedName,
    color: parsed.color,
    departmentId: parsed.departmentId,
    kind: "timed",
    isSystem: false,
    isActive: parsed.isActive
  });
}

export function getActivityCatalog(): ActivityCatalogResponse {
  return activityCatalogResponseSchema.parse({
    activities: knownActivities.map(cloneActivity),
    refreshedAt: catalogRefreshedAt
  });
}

export function getDepartmentCatalog(): Department[] {
  return knownDepartments.map((department) => ({ ...department }));
}

export function getDepartmentCatalogResponse(): DepartmentCatalogResponse {
  return departmentCatalogResponseSchema.parse({
    departments: getDepartmentCatalog(),
    refreshedAt: catalogRefreshedAt
  });
}

export function createActivityCatalogEntry(input: ActivityCatalogEntryInput): Activity {
  const activity = buildActivityCatalogEntry(input);

  knownActivities = [...knownActivities, activity];
  touchCatalog();

  return cloneActivity(activity);
}

export function updateActivityCatalogEntry(activityId: string, input: ActivityCatalogEntryInput): Activity {
  const existingActivity = knownActivities.find((activity) => activity.id === activityId && !activity.isSystem);

  if (!existingActivity) {
    throw new ActivityCatalogNotFoundError(activityId);
  }

  const nextActivity = buildActivityCatalogEntry(input, existingActivity.id);

  knownActivities = knownActivities.map((activity) => (activity.id === activityId ? nextActivity : activity));
  touchCatalog();

  return cloneActivity(nextActivity);
}