import type { Activity, ActivityCatalogResponse } from "@ddre/contracts";

const knownActivities: Activity[] = [
  {
    id: "activity-design",
    slug: "design",
    name: "Design",
    color: "#0D9488",
    kind: "timed",
    isSystem: false,
    isActive: true
  },
  {
    id: "activity-development",
    slug: "development",
    name: "Development",
    color: "#1D4ED8",
    kind: "timed",
    isSystem: false,
    isActive: true
  },
  {
    id: "activity-review",
    slug: "review",
    name: "Review",
    color: "#9333EA",
    kind: "timed",
    isSystem: false,
    isActive: true
  },
  {
    id: "activity-admin",
    slug: "admin",
    name: "Admin",
    color: "#EA580C",
    kind: "timed",
    isSystem: false,
    isActive: true
  }
];

export function getActivityCatalog(): ActivityCatalogResponse {
  return {
    activities: knownActivities,
    refreshedAt: new Date().toISOString()
  };
}