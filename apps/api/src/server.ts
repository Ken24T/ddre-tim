import Fastify, { type FastifyInstance } from "fastify";
import {
  activityCatalogEntryInputSchema,
  activityCatalogResponseSchema,
  activitySchema,
  dashboardResponseSchema,
  departmentCatalogResponseSchema,
  syncAckSchema,
  syncBatchSchema,
  userSettingsSchema,
  userSettingsUpdateSchema
} from "@ddre/contracts";
import { ZodError, z } from "zod";
import { getDashboardReadModel } from "./dashboard.js";
import {
  ActivityCatalogNotFoundError,
  createActivityCatalogEntry,
  getActivityCatalog,
  getDepartmentCatalogResponse,
  updateActivityCatalogEntry
} from "./data.js";
import { createUserSettingsStore, type UserSettingsStore } from "./settings.js";

export interface BuildServerOptions {
  logger?: boolean;
  userSettingsStore?: UserSettingsStore;
}

export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const server = Fastify({ logger: options.logger ?? true });
  const seenEventIds = new Set<string>();
  const userParamsSchema = userSettingsSchema.pick({ userId: true });
  const activityParamsSchema = z.object({ activityId: z.string().min(1) });
  const userSettingsStore = options.userSettingsStore ?? createUserSettingsStore();

  server.addHook("onClose", async () => {
    await userSettingsStore.close?.();
  });

  server.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      reply.status(400).send({
        message: "Validation failed",
        issues: error.issues
      });
      return;
    }

    if (error instanceof ActivityCatalogNotFoundError) {
      reply.status(404).send({ message: error.message });
      return;
    }

    request.log.error(error);
    reply.status(500).send({ message: "Internal server error" });
  });

  server.get("/health", async () => ({
    service: "ddre-api",
    status: "ok",
    now: new Date().toISOString()
  }));

  server.get("/v1/activities", async () => {
    return activityCatalogResponseSchema.parse(getActivityCatalog());
  });

  server.get("/v1/departments", async () => {
    return departmentCatalogResponseSchema.parse(getDepartmentCatalogResponse());
  });

  server.post("/v1/activities", async (request, reply) => {
    const activityInput = activityCatalogEntryInputSchema.parse(request.body);

    reply.status(201);

    return activitySchema.parse(createActivityCatalogEntry(activityInput));
  });

  server.put("/v1/activities/:activityId", async (request) => {
    const { activityId } = activityParamsSchema.parse(request.params);
    const activityInput = activityCatalogEntryInputSchema.parse(request.body);

    return activitySchema.parse(updateActivityCatalogEntry(activityId, activityInput));
  });

  server.get("/v1/dashboard", async (request) => {
    return dashboardResponseSchema.parse(await getDashboardReadModel(request.query));
  });

  server.get("/v1/users/:userId/settings", async (request) => {
    const { userId } = userParamsSchema.parse(request.params);

    return userSettingsSchema.parse(await userSettingsStore.getUserSettings(userId));
  });

  server.put("/v1/users/:userId/settings", async (request) => {
    const { userId } = userParamsSchema.parse(request.params);
    const settingsUpdate = userSettingsUpdateSchema.parse(request.body);

    return userSettingsSchema.parse(await userSettingsStore.upsertUserSettings(userId, settingsUpdate));
  });

  server.post("/v1/sync-batches", async (request, reply) => {
    const batch = syncBatchSchema.parse(request.body);
    const acceptedEventIds: string[] = [];
    const duplicateEventIds: string[] = [];

    for (const event of batch.events) {
      if (seenEventIds.has(event.eventId)) {
        duplicateEventIds.push(event.eventId);
        continue;
      }

      seenEventIds.add(event.eventId);
      acceptedEventIds.push(event.eventId);
    }

    reply.status(202);

    return syncAckSchema.parse({
      batchId: batch.batchId,
      acceptedEventIds,
      duplicateEventIds,
      receivedAt: new Date().toISOString()
    });
  });

  return server;
}