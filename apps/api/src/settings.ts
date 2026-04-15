import type { Activity, ActivityDraft, UserSettings, UserSettingsUpdate } from "@ddre/contracts";
import { getActivityCatalog } from "./data.js";

const settingsStore = new Map<string, UserSettings>();
const defaultNonTimedActivity: Activity = {
  id: "activity-not-timed",
  slug: "not-timed",
  name: "Not Timed",
  color: "#6B7280",
  kind: "non-timed",
  isSystem: true,
  isActive: true
};

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildStoredActivities(activityDrafts: ActivityDraft[]): Activity[] {
  return [
    { ...defaultNonTimedActivity },
    ...activityDrafts.map((activityDraft) => {
      const normalizedName = activityDraft.name.trim();
      const slug = slugify(normalizedName);

      return {
        id: `activity-${slug}`,
        slug,
        name: normalizedName,
        color: activityDraft.color,
        kind: "timed" as const,
        isSystem: false,
        isActive: activityDraft.isActive ?? true
      };
    })
  ];
}

function getDefaultActivities(): Activity[] {
  return [{ ...defaultNonTimedActivity }, ...getActivityCatalog().activities.map((activity) => ({ ...activity }))];
}

export function getUserSettings(userId: string): UserSettings {
  const existingSettings = settingsStore.get(userId);

  if (existingSettings) {
    return {
      ...existingSettings,
      activities: existingSettings.activities.map((activity) => ({ ...activity }))
    };
  }

  return {
    userId,
    displayName: "",
    isConfigured: false,
    activities: getDefaultActivities(),
    updatedAt: new Date().toISOString()
  };
}

export function upsertUserSettings(
  userId: string,
  settingsUpdate: UserSettingsUpdate
): UserSettings {
  const storedSettings: UserSettings = {
    userId,
    displayName: settingsUpdate.displayName,
    isConfigured: true,
    activities: buildStoredActivities(settingsUpdate.activities),
    updatedAt: new Date().toISOString()
  };

  settingsStore.set(userId, storedSettings);

  return {
    ...storedSettings,
    activities: storedSettings.activities.map((activity) => ({ ...activity }))
  };
}