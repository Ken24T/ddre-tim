import { activityEventSchema, type ActivityEvent } from "@ddre/contracts";
import { readLocalStateJson, writeLocalStateJson } from "./localState.js";

interface StoredActivityEventState {
  events: ActivityEvent[];
}

export interface AppendActivityEventsResult {
  acceptedEventIds: string[];
  duplicateEventIds: string[];
}

export interface ActivityEventStore {
  appendEvents(events: ActivityEvent[]): Promise<AppendActivityEventsResult>;
  listEvents(): Promise<ActivityEvent[]>;
  close?(): Promise<void>;
}

class FileActivityEventStore implements ActivityEventStore {
  private readonly stateFileName = "activity-events.json";

  private async readState(): Promise<StoredActivityEventState> {
    const storedState = await readLocalStateJson<StoredActivityEventState>(this.stateFileName, { events: [] });

    return {
      events: storedState.events.map((event) => activityEventSchema.parse(event))
    };
  }

  private async writeState(state: StoredActivityEventState): Promise<void> {
    await writeLocalStateJson(this.stateFileName, state);
  }

  async appendEvents(events: ActivityEvent[]): Promise<AppendActivityEventsResult> {
    const state = await this.readState();
    const seenEventIds = new Set(state.events.map((event) => event.eventId));
    const acceptedEventIds: string[] = [];
    const duplicateEventIds: string[] = [];

    for (const event of events.map((entry) => activityEventSchema.parse(entry))) {
      if (seenEventIds.has(event.eventId)) {
        duplicateEventIds.push(event.eventId);
        continue;
      }

      state.events.push(event);
      seenEventIds.add(event.eventId);
      acceptedEventIds.push(event.eventId);
    }

    if (acceptedEventIds.length > 0) {
      await this.writeState(state);
    }

    return { acceptedEventIds, duplicateEventIds };
  }

  async listEvents(): Promise<ActivityEvent[]> {
    const state = await this.readState();
    return state.events;
  }
}

export function createActivityEventStore(): ActivityEventStore {
  return new FileActivityEventStore();
}