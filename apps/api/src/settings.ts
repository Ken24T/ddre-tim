import type { Activity, ActivityDraft, Department, UserSettings, UserSettingsUpdate } from "@ddre/contracts";
import { ZodError, ZodIssueCode } from "zod";
import { getActivityCatalog, getDepartmentCatalog } from "./data.js";

const settingsStore = new Map<string, UserSettings>();
const availableDepartments = getDepartmentCatalog();
const preferredDefaultDepartmentId = "department-property-management";
const defaultDepartmentId = availableDepartments.find(
  (department) => department.id === preferredDefaultDepartmentId
)?.id ?? availableDepartments[0]?.id ?? preferredDefaultDepartmentId;
const knownDepartmentIds = new Set(availableDepartments.map((department) => department.id));
const defaultNonTimedActivity: Activity = {
  id: "activity-not-timed",
  slug: "not-timed",
  name: "Not Timed",
  color: "#6B7280",
  kind: "non-timed",
  isSystem: true,
  isActive: true
};

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

function getDefaultActivities(defaultDepartmentIdForUser: string): Activity[] {
  return [
    { ...defaultNonTimedActivity },
    ...getActivityCatalog().activities.map((activity) => ({
      ...activity,
      departmentId: activity.kind === "timed" ? defaultDepartmentIdForUser : activity.departmentId
    }))
  ];
}

export function getUserSettings(userId: string): UserSettings {
  const existingSettings = settingsStore.get(userId);

  if (existingSettings) {
    return {
      ...existingSettings,
      departments: cloneDepartments(existingSettings.departments),
      activities: existingSettings.activities.map((activity) => ({ ...activity }))
    };
  }

  return {
    userId,
    displayName: "",
    isConfigured: false,
    defaultDepartmentId,
    departments: cloneDepartments(availableDepartments),
    activities: getDefaultActivities(defaultDepartmentId),
    updatedAt: new Date().toISOString()
  };
}

export function upsertUserSettings(
  userId: string,
  settingsUpdate: UserSettingsUpdate
): UserSettings {
  assertKnownDepartmentId(settingsUpdate.defaultDepartmentId, ["defaultDepartmentId"]);

  const storedSettings: UserSettings = {
    userId,
    displayName: settingsUpdate.displayName,
    isConfigured: true,
    defaultDepartmentId: settingsUpdate.defaultDepartmentId,
    departments: cloneDepartments(availableDepartments),
    activities: buildStoredActivities(settingsUpdate.activities, settingsUpdate.defaultDepartmentId),
    updatedAt: new Date().toISOString()
  };

  settingsStore.set(userId, storedSettings);

  return {
    ...storedSettings,
    departments: cloneDepartments(storedSettings.departments),
    activities: storedSettings.activities.map((activity) => ({ ...activity }))
  };
}