import { z } from "zod";

const timestampSchema = z.string().datetime({ offset: true });
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

export type Activity = z.infer<typeof activitySchema>;
export type ActivityDraft = z.infer<typeof activityDraftSchema>;
export type ActivityCatalogResponse = z.infer<typeof activityCatalogResponseSchema>;
export type ActivityEvent = z.infer<typeof activityEventSchema>;
export type Department = z.infer<typeof departmentSchema>;
export type SyncBatch = z.infer<typeof syncBatchSchema>;
export type SyncAck = z.infer<typeof syncAckSchema>;
export type UserSettings = z.infer<typeof userSettingsSchema>;
export type UserSettingsUpdate = z.infer<typeof userSettingsUpdateSchema>;