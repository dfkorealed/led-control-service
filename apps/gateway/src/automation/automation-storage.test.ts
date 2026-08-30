import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { automationTelemetryRecordsHash } from "./automation-telemetry-handoff";
import { createAutomationStorage } from "./automation-storage";
import { automationScope } from "./automation-test-fixtures";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("createAutomationStorage", () => {
  it("initializes one shared reserve before state and outbox and never rewrites it on normal commits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "automation-storage-"));
    directories.push(directory);
    const storage = createAutomationStorage({
      statePath: join(directory, "state.json"),
      telemetryOutboxPath: join(directory, "outbox.json"),
      scope: automationScope,
      telemetryMaxBytes: 8_192,
      headroomBytes: 8_192
    });

    await expect(storage.initialize()).resolves.toMatchObject({
      headroom: { mode: "ready" },
      telemetry: { mode: "ready" },
      state: { schemaVersion: 5 }
    });
    await storage.stateStore.updateControlState((state) => {
      state.currentByFixture["00000000-0000-4000-8000-000000000101"] = 20;
      return state;
    });
    const records = [{
      revision: 7,
      ruleId: "22222222-2222-4222-8222-222222222222",
      occurrenceKey: "occurrence-1",
      kind: "event_started" as const,
      occurredAt: "2026-08-30T01:00:00.000Z",
      payload: {}
    }];
    await storage.telemetryOutbox.appendBatch({
      handoffId: "11111111-1111-4111-8111-111111111111",
      recordsHash: automationTelemetryRecordsHash(records),
      records
    });

    expect(storage.headroom.snapshot()).toMatchObject({
      status: "available",
      counters: {
        normalWriteCount: 4,
        preallocationCount: 1,
        preallocatedBytes: 8_192,
        releaseCount: 0,
        retryCount: 0
      }
    });
    storage.headroom.stop();
  });
});
