import Fastify, { type FastifyInstance } from "fastify";
import {
  activityCatalogResponseSchema,
  syncAckSchema,
  syncBatchSchema,
  userSettingsSchema,
  userSettingsUpdateSchema
} from "@ddre/contracts";
import { ZodError } from "zod";
import { getActivityCatalog } from "./data.js";
import { createUserSettingsStore, type UserSettingsStore } from "./settings.js";

export interface BuildServerOptions {
  logger?: boolean;
  userSettingsStore?: UserSettingsStore;
}

export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const server = Fastify({ logger: options.logger ?? true });
  const seenEventIds = new Set<string>();
  const userParamsSchema = userSettingsSchema.pick({ userId: true });
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