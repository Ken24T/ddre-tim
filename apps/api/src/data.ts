import type { Activity, ActivityCatalogResponse, Department } from "@ddre/contracts";

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

export function getDepartmentCatalog(): Department[] {
  return knownDepartments.map((department) => ({ ...department }));
}