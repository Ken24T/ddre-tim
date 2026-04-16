import { z } from "zod";

const timestampSchema = z.string().datetime({ offset: true });
const calendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const yearMonthSchema = z.string().regex(/^\d{4}-\d{2}$/);
const reservedNonTimedActivitySlug = "not-timed";

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function toProperCase(value: string): string {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/(^|[ .'-])\p{L}/gu, (segment) => segment.toUpperCase());
}

export const displayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[\p{L} .'-]+$/u, "displayName must contain only letters and simple separators")
  .transform((value) => toProperCase(value));

export const activityKindSchema = z.enum(["timed", "non-timed"]);

export const departmentSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  isActive: z.boolean().default(true)
});

export const activitySchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  departmentId: z.string().min(1).optional(),
  kind: activityKindSchema.default("timed"),
  isSystem: z.boolean().default(false),
  isActive: z.boolean().default(true)
});

export const activityCatalogResponseSchema = z.object({
  activities: z.array(activitySchema),
  refreshedAt: timestampSchema
});

export const activityDraftSchema = z.object({
  name: z.string().trim().min(1).max(100),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  departmentId: z.string().min(1).optional(),
  isActive: z.boolean().default(true)
});

export const userSettingsSchema = z.object({
  userId: z.string().min(1),
  displayName: z.string().trim().max(100),
  isConfigured: z.boolean(),
  defaultDepartmentId: z.string().min(1),
  departments: z.array(departmentSchema),
  activities: z.array(activitySchema),
  updatedAt: timestampSchema
});

export const userSettingsUpdateSchema = z
  .object({
    displayName: displayNameSchema,
    defaultDepartmentId: z.string().min(1),
    activities: z.array(activityDraftSchema)
  })
  .superRefine((settings, context) => {
    const seenNames = new Set<string>();

    settings.activities.forEach((activity, index) => {
      const normalizedName = activity.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

      if (seenNames.has(normalizedName)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "activity names must be unique",
          path: ["activities", index, "name"]
        });
        return;
      }

      if (normalizedName === reservedNonTimedActivitySlug) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "the non-timed default activity is managed by the system",
          path: ["activities", index, "name"]
        });
        return;
      }

      seenNames.add(normalizedName);
    });
  });

export const activityEventTypeSchema = z.enum([
  "activity-selected",
  "activity-cleared",
  "note-added"
]);

export const activityEventSchema = z
  .object({
    eventId: z.string().min(1),
    userId: z.string().min(1),
    deviceId: z.string().min(1),
    occurredAt: timestampSchema,
    recordedAt: timestampSchema,
    type: activityEventTypeSchema,
    activityId: z.string().min(1).optional(),
    departmentId: z.string().min(1).optional(),
    note: z.string().trim().min(1).max(500).optional(),
    idempotencyKey: z.string().min(1),
    metadata: z.record(z.string()).default({})
  })
  .superRefine((event, context) => {
    if (event.type === "activity-selected" && !event.activityId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "activityId is required for activity-selected events",
        path: ["activityId"]
      });
    }
  });

export const syncBatchSchema = z
  .object({
    batchId: z.string().min(1),
    userId: z.string().min(1),
    deviceId: z.string().min(1),
    sentAt: timestampSchema,
    events: z.array(activityEventSchema).min(1)
  })
  .superRefine((batch, context) => {
    batch.events.forEach((event, index) => {
      if (event.userId !== batch.userId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "event userId must match the batch userId",
          path: ["events", index, "userId"]
        });
      }

      if (event.deviceId !== batch.deviceId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "event deviceId must match the batch deviceId",
          path: ["events", index, "deviceId"]
        });
      }
    });
  });

export const syncAckSchema = z.object({
  batchId: z.string().min(1),
  acceptedEventIds: z.array(z.string().min(1)),
  duplicateEventIds: z.array(z.string().min(1)),
  receivedAt: timestampSchema
});

export const dashboardQuerySchema = z
  .object({
    department: z.string().trim().min(1).optional(),
    from: calendarDateSchema.optional(),
    to: calendarDateSchema.optional(),
    userId: z.union([z.string().trim().min(1), z.array(z.string().trim().min(1))]).optional()
  })
  .superRefine((query, context) => {
    if (query.from && query.to && query.from > query.to) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "from must be before or equal to to",
        path: ["from"]
      });
    }
  })
  .transform(({ userId, ...query }) => ({
    ...query,
    userIds: Array.from(new Set((Array.isArray(userId) ? userId : userId ? [userId] : []).map((value) => value.trim())))
  }));

export const dashboardSummaryStatsSchema = z.object({
  totalHours: z.number().nonnegative(),
  workdayCount: z.number().int().nonnegative(),
  averageHoursPerDay: z.number().nonnegative(),
  userDayCount: z.number().int().nonnegative(),
  averageHoursPerUserDay: z.number().nonnegative(),
  selectedUserCount: z.number().int().nonnegative(),
  departmentCount: z.number().int().nonnegative(),
  activityCount: z.number().int().nonnegative(),
  recordCount: z.number().int().nonnegative()
});

export const dashboardUserOptionSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  isSelected: z.boolean(),
  totalHours: z.number().nonnegative(),
  recordCount: z.number().int().nonnegative()
});

export const dashboardFiltersSchema = z.object({
  availableDepartments: z.array(z.string().min(1)),
  selectedDepartment: z.string().min(1).nullable(),
  availableUsers: z.array(dashboardUserOptionSchema),
  selectedUserIds: z.array(z.string().min(1)),
  selectedFrom: calendarDateSchema,
  selectedTo: calendarDateSchema,
  minDate: calendarDateSchema,
  maxDate: calendarDateSchema
});

export const dashboardBreakdownRowSchema = z.object({
  label: z.string().min(1),
  hours: z.number().nonnegative(),
  dayCount: z.number().int().nonnegative(),
  recordCount: z.number().int().nonnegative()
});

export const dashboardUserBreakdownRowSchema = z.object({
  userId: z.string().min(1),
  label: z.string().min(1),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  hours: z.number().nonnegative(),
  dayCount: z.number().int().nonnegative(),
  recordCount: z.number().int().nonnegative()
});

export const dashboardRecentDaySchema = z.object({
  workDate: calendarDateSchema,
  label: z.string().min(1),
  hours: z.number().nonnegative(),
  departmentCount: z.number().int().nonnegative(),
  topActivity: z.string().min(1)
});

export const dashboardMonthlyTotalSchema = z.object({
  monthKey: yearMonthSchema,
  label: z.string().min(1),
  hours: z.number().nonnegative()
});

export const dashboardMonthlyUserSegmentSchema = z.object({
  userId: z.string().min(1),
  label: z.string().min(1),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  hours: z.number().nonnegative()
});

export const dashboardMonthlyUserTotalSchema = z.object({
  monthKey: yearMonthSchema,
  label: z.string().min(1),
  totalHours: z.number().nonnegative(),
  segments: z.array(dashboardMonthlyUserSegmentSchema)
});

export const dashboardResponseSchema = z.object({
  scopeLabel: z.string().min(1),
  employeeName: z.string().min(1),
  sourceFile: z.string().min(1),
  importedAt: timestampSchema,
  dateRangeLabel: z.string().min(1),
  filters: dashboardFiltersSchema,
  stats: dashboardSummaryStatsSchema,
  userBreakdown: z.array(dashboardUserBreakdownRowSchema),
  departmentBreakdown: z.array(dashboardBreakdownRowSchema),
  activityBreakdown: z.array(dashboardBreakdownRowSchema),
  recentDays: z.array(dashboardRecentDaySchema),
  monthlyTotals: z.array(dashboardMonthlyTotalSchema),
  monthlyUserTotals: z.array(dashboardMonthlyUserTotalSchema)
});

export type Activity = z.infer<typeof activitySchema>;
export type ActivityDraft = z.infer<typeof activityDraftSchema>;
export type ActivityCatalogResponse = z.infer<typeof activityCatalogResponseSchema>;
export type ActivityEvent = z.infer<typeof activityEventSchema>;
export type DashboardBreakdownRow = z.infer<typeof dashboardBreakdownRowSchema>;
export type DashboardFilters = z.infer<typeof dashboardFiltersSchema>;
export type DashboardMonthlyTotal = z.infer<typeof dashboardMonthlyTotalSchema>;
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;
export type DashboardRecentDay = z.infer<typeof dashboardRecentDaySchema>;
export type DashboardResponse = z.infer<typeof dashboardResponseSchema>;
export type DashboardSummaryStats = z.infer<typeof dashboardSummaryStatsSchema>;
export type DashboardUserBreakdownRow = z.infer<typeof dashboardUserBreakdownRowSchema>;
export type DashboardUserOption = z.infer<typeof dashboardUserOptionSchema>;
export type Department = z.infer<typeof departmentSchema>;
export type DashboardMonthlyUserSegment = z.infer<typeof dashboardMonthlyUserSegmentSchema>;
export type DashboardMonthlyUserTotal = z.infer<typeof dashboardMonthlyUserTotalSchema>;
export type SyncBatch = z.infer<typeof syncBatchSchema>;
export type SyncAck = z.infer<typeof syncAckSchema>;
export type UserSettings = z.infer<typeof userSettingsSchema>;
export type UserSettingsUpdate = z.infer<typeof userSettingsUpdateSchema>;