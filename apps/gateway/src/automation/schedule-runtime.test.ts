import type {
  AutomationExecutionFixtureResultV1,
  AutomationSnapshotV1,
  LightingScheduleSnapshotV1,
  VehicleEventRuleSnapshotV1
} from "@led-control/shared";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeJsonAtomic } from "../mesh/mesh-store-file";
import { FileAutomationStateStore } from "./automation-state-store";
import { SystemClockTrustProvider } from "./clock-trust-provider";
import { automationSnapshot } from "./automation-test-fixtures";
import {
  ScheduleRuntime,
  type DesiredLightingAction,
  type ManualOverrideInput
} from "./schedule-runtime";

const directories: string[] = [];
const fixtureId = "00000000-0000-4000-8000-000000000101";
const sourceFixtureId = "00000000-0000-4000-8000-000000000102";
const scheduleId = "00000000-0000-4000-8000-000000000103";
const vehicleRuleId = "00000000-0000-4000-8000-000000000104";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ScheduleRuntime", () => {
  it("starts a common-engine occurrence and restores its persisted pre-state at the end", async () => {
    const test = await runtimeFixture("2026-08-30T00:59:00.000Z");
    await test.runtime.recordFixtureState(fixtureId, 20);
    await activate(test.runtime, snapshot({ schedules: [dailySchedule()] }));

    test.wall.set("2026-08-30T01:00:00.000Z");
    await test.runtime.tick();

    expect(test.execute).toHaveBeenLastCalledWith([
      expect.objectContaining({
        fixtureId,
        brightnessPercent: 40,
        sourceType: "schedule",
        sourceId: scheduleId,
        occurrenceKey: `${scheduleId}:2026-08-30`
      })
    ]);
    expect(test.store.read().activeOccurrences[scheduleId]).toMatchObject({
      key: `${scheduleId}:2026-08-30`,
      preBrightness: { [fixtureId]: 20 }
    });

    test.wall.set("2026-08-30T02:00:00.000Z");
    await test.runtime.tick();

    expect(test.execute).toHaveBeenLastCalledWith([
      expect.objectContaining({ fixtureId, brightnessPercent: 20, sourceType: "current" })
    ]);
    expect(test.store.read()).toMatchObject({
      activeOccurrences: {},
      baseBrightnessByFixture: {},
      lastDesiredByFixture: { [fixtureId]: 20 }
    });
  });

  it("does not issue a duplicate mesh action when restarting inside the same occurrence", async () => {
    const test = await runtimeFixture("2026-08-30T01:30:00.000Z");
    await test.runtime.recordFixtureState(fixtureId, 20);
    const activeSnapshot = snapshot({ schedules: [dailySchedule()] });
    await activate(test.runtime, activeSnapshot);
    expect(test.execute).toHaveBeenCalledTimes(1);

    const restartedExecute = vi.fn(executeSuccessfully);
    const restarted = new ScheduleRuntime({
      store: new FileAutomationStateStore(test.path),
      wallClock: test.wall.now,
      monotonicClock: test.monotonic.now,
      clockTrust: test.trust,
      execute: restartedExecute
    });
    await restarted.initialize();
    await activate(restarted, activeSnapshot);

    expect(restartedExecute).not.toHaveBeenCalled();
    expect(restarted.state().activeOccurrences[scheduleId]?.key).toBe(`${scheduleId}:2026-08-30`);
  });

  it("retries a transition after a pre-send failure and deduplicates only its successful terminal commit", async () => {
    const test = await runtimeFixture("2026-08-30T01:30:00.000Z");
    await test.runtime.recordFixtureState(fixtureId, 20);
    test.execute.mockRejectedValueOnce(new Error("adapter unavailable before send"));

    await activate(test.runtime, snapshot({ schedules: [dailySchedule()] }));

    expect(test.runtime.state()).toMatchObject({
      lastDesiredByFixture: { [fixtureId]: 20 },
      transitionsByFixture: {
        [fixtureId]: { phase: "terminal", status: "failed", brightnessPercent: 40 }
      }
    });

    await test.runtime.tick();
    expect(test.execute).toHaveBeenCalledTimes(2);
    expect(test.runtime.state()).toMatchObject({
      lastDesiredByFixture: { [fixtureId]: 40 },
      transitionsByFixture: {
        [fixtureId]: { phase: "terminal", status: "succeeded", brightnessPercent: 40 }
      }
    });

    await test.runtime.tick();
    expect(test.execute).toHaveBeenCalledTimes(2);
  });

  it("resolves a post-send persisted pending transition from matching observed state without duplicate RF", async () => {
    const test = await runtimeFixture("2026-08-30T01:30:00.000Z");
    await test.runtime.recordFixtureState(fixtureId, 20);
    await test.store.update((state) => {
      state.transitionsByFixture[fixtureId] = {
        phase: "pending",
        brightnessPercent: 40,
        sourceType: "schedule",
        sourceId: scheduleId,
        occurrenceKey: `${scheduleId}:2026-08-30`,
        attempt: 1,
        startedAt: "2026-08-30T01:30:00.000Z",
        status: null,
        terminalAt: null
      };
      return state;
    });
    const execute = vi.fn(executeSuccessfully);
    const restarted = new ScheduleRuntime({
      store: new FileAutomationStateStore(test.path),
      wallClock: test.wall.now,
      monotonicClock: test.monotonic.now,
      clockTrust: test.trust,
      execute
    });

    await restarted.initialize();
    await activate(restarted, snapshot({ schedules: [dailySchedule()] }));

    expect(execute).not.toHaveBeenCalled();
    await restarted.recordFixtureState(fixtureId, 40);

    expect(execute).not.toHaveBeenCalled();
    expect(restarted.state().transitionsByFixture[fixtureId]).toMatchObject({
      phase: "terminal",
      status: "succeeded",
      attempt: 1
    });
  });

  it("retries a pre-send persisted pending transition only after observed state differs", async () => {
    const test = await runtimeFixture("2026-08-30T01:30:00.000Z");
    await test.runtime.recordFixtureState(fixtureId, 20);
    await persistPendingSchedule(test.store);
    const execute = vi.fn(executeSuccessfully);
    const restarted = new ScheduleRuntime({
      store: new FileAutomationStateStore(test.path),
      wallClock: test.wall.now,
      monotonicClock: test.monotonic.now,
      clockTrust: test.trust,
      execute
    });

    await restarted.initialize();
    await activate(restarted, snapshot({ schedules: [dailySchedule()] }));
    expect(execute).not.toHaveBeenCalled();

    await restarted.recordFixtureState(fixtureId, 20);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(restarted.state().transitionsByFixture[fixtureId]).toMatchObject({
      phase: "terminal",
      status: "succeeded",
      attempt: 2
    });
  });

  it.each([
    ["post-send", 40, 0],
    ["pre-send", 20, 1]
  ] as const)("classifies a migrated v2 %s pending transition from observed state", async (_case, observed, expectedRf) => {
    const directory = await mkdtemp(join(tmpdir(), "schedule-runtime-v2-pending-"));
    directories.push(directory);
    const path = join(directory, "state.json");
    await writeJsonAtomic(path, legacyV2PendingScheduleState());
    const execute = vi.fn(executeSuccessfully);
    const runtime = new ScheduleRuntime({
      store: new FileAutomationStateStore(path),
      wallClock: () => new Date("2026-08-30T01:30:00.000Z"),
      monotonicClock: () => 1_000,
      clockTrust: { isTrusted: async () => true },
      execute
    });

    await runtime.initialize();
    await activate(runtime, snapshot({ schedules: [dailySchedule()] }));
    expect(execute).not.toHaveBeenCalled();

    await runtime.recordFixtureState(fixtureId, observed);

    expect(execute).toHaveBeenCalledTimes(expectedRf);
    expect(runtime.state().transitionsByFixture[fixtureId]).toMatchObject({
      phase: "terminal",
      status: "succeeded",
      brightnessPercent: 40
    });
  });

  it.each([
    ["matching", 40, 0],
    ["different", 20, 1]
  ] as const)("classifies v1 desired from %s observed state before RF", async (_case, observed, expectedRf) => {
    const directory = await mkdtemp(join(tmpdir(), "schedule-runtime-v1-"));
    directories.push(directory);
    const path = join(directory, "state.json");
    await writeJsonAtomic(path, legacyActiveScheduleState());
    const execute = vi.fn(executeSuccessfully);
    const runtime = new ScheduleRuntime({
      store: new FileAutomationStateStore(path),
      wallClock: () => new Date("2026-08-30T01:30:00.000Z"),
      monotonicClock: () => 1_000,
      clockTrust: { isTrusted: async () => true },
      execute
    });

    await runtime.initialize();
    await activate(runtime, snapshot({ schedules: [dailySchedule()] }));
    expect(execute).not.toHaveBeenCalled();

    await runtime.recordFixtureState(fixtureId, observed);

    expect(execute).toHaveBeenCalledTimes(expectedRf);
    expect(runtime.state().unverifiedDesiredByFixture).toEqual({});
    expect(runtime.state().lastDesiredByFixture[fixtureId]).toBe(40);
  });

  it("does not deduplicate a failed terminal even when it observed the requested brightness", async () => {
    const test = await runtimeFixture("2026-08-30T01:30:00.000Z");
    await test.runtime.recordFixtureState(fixtureId, 20);
    test.execute.mockResolvedValueOnce([{
      fixtureId,
      status: "failed",
      brightnessPercent: 40,
      faultCode: "state_mismatch",
      errorCode: "state_mismatch",
      occurredAt: "2026-08-30T01:30:00.000Z"
    }]);

    await activate(test.runtime, snapshot({ schedules: [dailySchedule()] }));
    expect(test.runtime.state().lastDesiredByFixture[fixtureId]).toBe(20);

    await test.runtime.tick();
    expect(test.execute).toHaveBeenCalledTimes(2);
    expect(test.runtime.state().lastDesiredByFixture[fixtureId]).toBe(40);
  });

  it("uses observed state after terminal durability uncertainty to avoid duplicate post-send RF", async () => {
    const directory = await mkdtemp(join(tmpdir(), "schedule-runtime-uncertain-"));
    directories.push(directory);
    const path = join(directory, "state.json");
    let injectTerminalUncertainty = true;
    const store = new FileAutomationStateStore(path, async (target, value) => {
      const transition = (value as { transitionsByFixture?: Record<string, { phase?: string }> })
        .transitionsByFixture?.[fixtureId];
      if (injectTerminalUncertainty && transition?.phase === "terminal") {
        injectTerminalUncertainty = false;
        await writeJsonAtomic(target, value, {
          syncParentDirectory: async () => { throw new Error("injected terminal fsync uncertainty"); }
        });
        return;
      }
      await writeJsonAtomic(target, value);
    });
    const execute = vi.fn(executeSuccessfully);
    const runtime = new ScheduleRuntime({
      store,
      wallClock: () => new Date("2026-08-30T01:30:00.000Z"),
      monotonicClock: () => 1_000,
      clockTrust: { isTrusted: async () => true },
      execute
    });
    await runtime.initialize();
    await runtime.recordFixtureState(fixtureId, 20);
    const desired = await runtime.recompute(snapshot({ schedules: [dailySchedule()] }));

    await expect(runtime.applyDesiredState(desired, {})).rejects.toMatchObject({
      code: "automation_state_commit_uncertain"
    });
    expect(execute).toHaveBeenCalledTimes(1);

    const restartedExecute = vi.fn(executeSuccessfully);
    const restarted = new ScheduleRuntime({
      store: new FileAutomationStateStore(path),
      wallClock: () => new Date("2026-08-30T01:30:01.000Z"),
      monotonicClock: () => 2_000,
      clockTrust: { isTrusted: async () => true },
      execute: restartedExecute
    });
    await restarted.initialize();
    await activate(restarted, snapshot({ schedules: [dailySchedule()] }));

    expect(restartedExecute).not.toHaveBeenCalled();
    await restarted.recordFixtureState(fixtureId, 40);
    expect(restartedExecute).not.toHaveBeenCalled();
    expect(restarted.state().lastDesiredByFixture[fixtureId]).toBe(40);
  });

  it.each([
    ["write_failed", 40, 1],
    ["write_failed", 20, 2],
    ["commit_uncertain", 40, 1],
    ["commit_uncertain", 20, 2]
  ] as const)(
    "fences same-process RF after %s terminal persistence until brightness %s is observed",
    async (failure, observedBrightness, expectedRf) => {
      const directory = await mkdtemp(join(tmpdir(), "schedule-runtime-terminal-fence-"));
      directories.push(directory);
      const path = join(directory, "state.json");
      const wall = fakeWall("2026-08-30T00:59:00.000Z");
      let inject = true;
      const store = new FileAutomationStateStore(path, async (target, value) => {
        const transition = (value as { transitionsByFixture?: Record<string, { phase?: string }> })
          .transitionsByFixture?.[fixtureId];
        if (inject && transition?.phase === "terminal") {
          inject = false;
          if (failure === "write_failed") throw new Error("injected terminal write failure");
          await writeJsonAtomic(target, value, {
            syncParentDirectory: async () => { throw new Error("injected terminal fsync uncertainty"); }
          });
          return;
        }
        await writeJsonAtomic(target, value);
      });
      const execute = vi.fn(executeSuccessfully);
      const runtime = new ScheduleRuntime({
        store,
        wallClock: wall.now,
        monotonicClock: () => 1_000,
        clockTrust: { isTrusted: async () => true },
        execute
      });
      await runtime.initialize();
      await runtime.recordFixtureState(fixtureId, 20);
      await activate(runtime, snapshot({ schedules: [dailySchedule()] }));
      wall.set("2026-08-30T01:30:00.000Z");

      await expect(runtime.tick()).rejects.toBeDefined();
      expect(execute).toHaveBeenCalledTimes(1);

      await runtime.tick();
      expect(execute).toHaveBeenCalledTimes(1);

      await runtime.recordFixtureState(fixtureId, observedBrightness);
      expect(execute).toHaveBeenCalledTimes(expectedRf);
      expect(runtime.state().transitionsByFixture[fixtureId]).toMatchObject({
        phase: "terminal",
        status: "succeeded",
        brightnessPercent: 40
      });
    }
  );

  it("freezes only new schedule boundaries while the wall clock is untrusted", async () => {
    const test = await runtimeFixture("2026-08-30T00:59:00.000Z");
    await test.runtime.recordFixtureState(fixtureId, 20);
    await activate(test.runtime, snapshot({ schedules: [dailySchedule()] }));

    test.trust.trusted = false;
    test.wall.set("2026-08-30T01:10:00.000Z");
    await test.runtime.tick();

    expect(test.execute).not.toHaveBeenCalled();
    expect(test.store.read().activeOccurrences).toEqual({});

    await test.runtime.prepareManualOverride(manualOverride(60, "2026-08-30T01:30:00.000Z"));
    expect(test.store.read().manualOverrides[fixtureId]).toMatchObject({ brightnessPercent: 60 });
    expect(test.store.read()).toMatchObject({
      lastDesiredByFixture: { [fixtureId]: 20 },
      transitionsByFixture: { [fixtureId]: { phase: "pending", brightnessPercent: 60 } }
    });
  });

  it("expires vehicle hold from monotonic time even while the wall clock is untrusted", async () => {
    const test = await runtimeFixture("2026-08-30T01:00:00.000Z");
    await test.runtime.recordFixtureState(fixtureId, 20);
    await activate(test.runtime, snapshot({ vehicleEventRules: [vehicleRule(80, 60)] }));

    await test.runtime.recordVehicleSensorState(sourceFixtureId, true);
    expect(test.execute).toHaveBeenLastCalledWith([
      expect.objectContaining({ fixtureId, brightnessPercent: 80, sourceType: "vehicle_event_rule" })
    ]);
    await test.runtime.recordVehicleSensorState(sourceFixtureId, false);

    test.trust.trusted = false;
    test.monotonic.advance(59_000);
    await test.runtime.tick();
    expect(test.execute).toHaveBeenCalledTimes(1);

    test.monotonic.advance(1_001);
    await test.runtime.tick();
    expect(test.execute).toHaveBeenLastCalledWith([
      expect.objectContaining({ fixtureId, brightnessPercent: 20, sourceType: "current" })
    ]);
  });

  it("ignores an initial or repeated vehicle Low instead of creating or extending a hold", async () => {
    const test = await runtimeFixture("2026-08-30T01:00:00.000Z");
    await test.runtime.recordFixtureState(fixtureId, 20);
    await activate(test.runtime, snapshot({ vehicleEventRules: [vehicleRule(80, 5)] }));

    await test.runtime.recordVehicleSensorState(sourceFixtureId, false);
    expect(test.execute).not.toHaveBeenCalled();
    expect(test.runtime.state().vehicleRules).toEqual({});

    await test.runtime.recordVehicleSensorState(sourceFixtureId, true);
    await test.runtime.recordVehicleSensorState(sourceFixtureId, false);
    test.monotonic.advance(4_000);
    await test.runtime.recordVehicleSensorState(sourceFixtureId, false);
    test.monotonic.advance(1_001);
    await test.runtime.tick();

    expect(test.execute).toHaveBeenLastCalledWith([
      expect.objectContaining({ fixtureId, brightnessPercent: 20, sourceType: "current" })
    ]);
  });

  it("expires a timed manual override while schedule boundaries are clock-untrusted", async () => {
    const test = await runtimeFixture("2026-08-30T01:00:00.000Z");
    await test.runtime.recordFixtureState(fixtureId, 20);
    await activate(test.runtime, snapshot({ vehicleEventRules: [vehicleRule(80, 60)] }));
    await test.runtime.recordVehicleSensorState(sourceFixtureId, true);
    await test.runtime.prepareManualOverride(manualOverride(60, "2026-08-30T01:00:10.000Z"));
    await test.runtime.handoffManualTerminal("00000000-0000-4000-8000-000000000105", [
      successfulTerminal(fixtureId, 60)
    ]);
    test.execute.mockClear();

    test.trust.trusted = false;
    test.wall.set("2026-08-30T01:00:10.000Z");
    test.monotonic.advance(10_000);
    await test.runtime.tick();

    expect(test.execute).toHaveBeenLastCalledWith([
      expect.objectContaining({ fixtureId, brightnessPercent: 80, sourceType: "vehicle_event_rule" })
    ]);
  });

  it("gives an untrusted-arrival manual override a monotonic duration deadline", async () => {
    const test = await runtimeFixture("2026-08-30T01:00:00.000Z");
    await test.runtime.recordFixtureState(fixtureId, 20);
    await activate(test.runtime, snapshot({ vehicleEventRules: [vehicleRule(80, 60)] }));
    await test.runtime.recordVehicleSensorState(sourceFixtureId, true);
    test.trust.trusted = false;
    await test.runtime.prepareManualOverride({
      ...manualOverride(60, "2026-08-30T01:00:10.000Z"),
      startedAt: "2026-08-30T01:00:00.000Z"
    });
    await test.runtime.handoffManualTerminal("00000000-0000-4000-8000-000000000105", [
      successfulTerminal(fixtureId, 60)
    ]);
    test.execute.mockClear();

    test.wall.set("2026-08-30T00:50:00.000Z");
    test.monotonic.advance(10_001);
    await test.runtime.tick();

    expect(test.execute).toHaveBeenLastCalledWith([
      expect.objectContaining({ fixtureId, brightnessPercent: 80, sourceType: "vehicle_event_rule" })
    ]);
  });

  it("rejects a manual override whose absolute end is already past on a trusted clock", async () => {
    const test = await runtimeFixture("2026-08-30T01:10:00.000Z");
    await test.runtime.recordFixtureState(fixtureId, 20);
    await activate(test.runtime, snapshot({}));

    await expect(test.runtime.prepareManualOverride({
      ...manualOverride(60, "2026-08-30T01:05:00.000Z"),
      startedAt: "2026-08-30T01:00:00.000Z"
    })).rejects.toMatchObject({ code: "manual_override_expired" });

    expect(test.runtime.state().manualOverrides).toEqual({});
    expect(test.execute).not.toHaveBeenCalled();
  });

  it("bounds an untrusted long manual override to the broker delivery window", async () => {
    const test = await runtimeFixture("2026-08-30T01:00:00.000Z");
    await test.runtime.recordFixtureState(fixtureId, 20);
    await activate(test.runtime, snapshot({ vehicleEventRules: [vehicleRule(80, 60)] }));
    await test.runtime.recordVehicleSensorState(sourceFixtureId, true);
    test.trust.trusted = false;
    await test.runtime.prepareManualOverride({
      ...manualOverride(60, "2026-09-29T01:00:00.000Z"),
      startedAt: "2026-08-30T01:00:00.000Z"
    });
    await test.runtime.handoffManualTerminal("00000000-0000-4000-8000-000000000105", [
      successfulTerminal(fixtureId, 60)
    ]);
    test.execute.mockClear();

    test.monotonic.advance(10_001);
    await test.runtime.tick();

    expect(test.runtime.state().manualOverrides).toEqual({});
    expect(test.execute).toHaveBeenLastCalledWith([
      expect.objectContaining({ fixtureId, brightnessPercent: 80, sourceType: "vehicle_event_rule" })
    ]);
  });

  it("keeps the last successful manual brightness when its override expires without an automatic source", async () => {
    const test = await runtimeFixture("2026-08-30T01:00:00.000Z");
    await test.runtime.recordFixtureState(fixtureId, 20);
    await activate(test.runtime, snapshot({}));
    await test.runtime.prepareManualOverride(manualOverride(60, "2026-08-30T01:00:10.000Z"));
    await test.runtime.handoffManualTerminal("00000000-0000-4000-8000-000000000105", [
      successfulTerminal(fixtureId, 60)
    ]);
    test.execute.mockClear();

    test.wall.set("2026-08-30T01:00:10.000Z");
    test.monotonic.advance(10_000);
    await test.runtime.tick();

    expect(test.execute).not.toHaveBeenCalled();
    expect(test.runtime.state()).toMatchObject({
      manualOverrides: {},
      currentByFixture: { [fixtureId]: 60 },
      lastDesiredByFixture: { [fixtureId]: 60 },
      baseBrightnessByFixture: {}
    });
  });

  it("persists manual pending before RF and marks desired complete only after a successful terminal handoff", async () => {
    const test = await runtimeFixture("2026-08-30T01:00:00.000Z");
    await test.runtime.recordFixtureState(fixtureId, 20);
    await activate(test.runtime, snapshot({}));

    await test.runtime.prepareManualOverride(manualOverride(60, "2026-08-30T01:10:00.000Z"));
    expect(test.runtime.state()).toMatchObject({
      lastDesiredByFixture: { [fixtureId]: 20 },
      transitionsByFixture: {
        [fixtureId]: {
          phase: "pending",
          sourceType: "manual_override",
          brightnessPercent: 60
        }
      }
    });

    await test.runtime.handoffManualTerminal("00000000-0000-4000-8000-000000000105", [
      successfulTerminal(fixtureId, 60)
    ]);
    expect(test.runtime.state()).toMatchObject({
      lastDesiredByFixture: { [fixtureId]: 60 },
      transitionsByFixture: {
        [fixtureId]: {
          phase: "terminal",
          status: "succeeded",
          brightnessPercent: 60
        }
      }
    });
  });

  it("clears a prepared manual source after a failed terminal handoff", async () => {
    const test = await runtimeFixture("2026-08-30T01:00:00.000Z");
    await test.runtime.recordFixtureState(fixtureId, 20);
    await activate(test.runtime, snapshot({}));
    await test.runtime.prepareManualOverride(manualOverride(60, "2026-08-30T01:10:00.000Z"));

    await test.runtime.handoffManualTerminal("00000000-0000-4000-8000-000000000105", [{
      fixtureId,
      status: "failed",
      brightnessPercent: null,
      faultCode: null,
      errorCode: "mesh_command_failed",
      occurredAt: "2026-08-30T01:00:01.000Z"
    }]);

    expect(test.runtime.state()).toMatchObject({
      manualOverrides: {},
      lastDesiredByFixture: { [fixtureId]: 20 },
      transitionsByFixture: {
        [fixtureId]: { phase: "terminal", status: "failed", brightnessPercent: 60 }
      }
    });
  });

  it("preserves the schedule pre-state when manual control overlaps an already-active occurrence", async () => {
    const test = await runtimeFixture("2026-08-30T01:30:00.000Z");
    await test.runtime.recordFixtureState(fixtureId, 20);
    await activate(test.runtime, snapshot({ schedules: [dailySchedule()] }));
    await test.runtime.prepareManualOverride({
      ...manualOverride(60, "2026-08-30T01:45:00.000Z"),
      startedAt: "2026-08-30T01:30:00.000Z"
    });
    await test.runtime.handoffManualTerminal("00000000-0000-4000-8000-000000000105", [
      successfulTerminal(fixtureId, 60)
    ]);

    test.wall.set("2026-08-30T01:45:00.000Z");
    test.monotonic.advance(15 * 60 * 1_000);
    await test.runtime.tick();
    expect(test.execute).toHaveBeenLastCalledWith([
      expect.objectContaining({ fixtureId, brightnessPercent: 40, sourceType: "schedule" })
    ]);

    test.wall.set("2026-08-30T02:00:00.000Z");
    test.monotonic.advance(15 * 60 * 1_000);
    await test.runtime.tick();
    expect(test.execute).toHaveBeenLastCalledWith([
      expect.objectContaining({ fixtureId, brightnessPercent: 20, sourceType: "current" })
    ]);
  });

  it("preserves the vehicle-event pre-state when manual control overlaps an active event", async () => {
    const test = await runtimeFixture("2026-08-30T01:00:00.000Z");
    await test.runtime.recordFixtureState(fixtureId, 20);
    await activate(test.runtime, snapshot({ vehicleEventRules: [vehicleRule(80, 5)] }));
    await test.runtime.recordVehicleSensorState(sourceFixtureId, true);
    await test.runtime.prepareManualOverride(manualOverride(60, "2026-08-30T01:00:03.000Z"));
    await test.runtime.handoffManualTerminal("00000000-0000-4000-8000-000000000105", [
      successfulTerminal(fixtureId, 60)
    ]);

    test.monotonic.advance(3_001);
    await test.runtime.tick();
    expect(test.execute).toHaveBeenLastCalledWith([
      expect.objectContaining({ fixtureId, brightnessPercent: 80, sourceType: "vehicle_event_rule" })
    ]);

    await test.runtime.recordVehicleSensorState(sourceFixtureId, false);
    test.monotonic.advance(5_001);
    await test.runtime.tick();
    expect(test.execute).toHaveBeenLastCalledWith([
      expect.objectContaining({ fixtureId, brightnessPercent: 20, sourceType: "current" })
    ]);
  });

  it.each(["write_failed", "commit_uncertain"] as const)(
    "keeps the manual RF guard when terminal state is %s and a tick is queued",
    async (failure) => {
      const directory = await mkdtemp(join(tmpdir(), "manual-terminal-store-failure-"));
      directories.push(directory);
      const path = join(directory, "state.json");
      let inject = true;
      const store = new FileAutomationStateStore(path, async (target, value) => {
        const transition = (value as { transitionsByFixture?: Record<string, { phase?: string; sourceType?: string }> })
          .transitionsByFixture?.[fixtureId];
        if (inject && transition?.phase === "terminal" && transition.sourceType === "manual_override") {
          inject = false;
          if (failure === "write_failed") throw new Error("injected terminal write failure");
          await writeJsonAtomic(target, value, {
            syncParentDirectory: async () => { throw new Error("injected terminal fsync uncertainty"); }
          });
          return;
        }
        await writeJsonAtomic(target, value);
      });
      const execute = vi.fn(executeSuccessfully);
      const monotonic = fakeMonotonic();
      const runtime = new ScheduleRuntime({
        store,
        wallClock: () => new Date("2026-08-30T01:00:00.000Z"),
        monotonicClock: monotonic.now,
        clockTrust: { isTrusted: async () => true },
        execute
      });
      await runtime.initialize();
      await runtime.recordFixtureState(fixtureId, 20);
      await activate(runtime, snapshot({}));
      await runtime.prepareManualOverride(manualOverride(60, "2026-08-30T01:10:00.000Z"));

      const handoff = runtime.handoffManualTerminal(
        "00000000-0000-4000-8000-000000000105",
        [successfulTerminal(fixtureId, 60)]
      );
      const tick = runtime.tick();

      await expect(handoff).rejects.toBeDefined();
      await tick;
      expect(execute).not.toHaveBeenCalled();
      expect(runtime.state().transitionsByFixture[fixtureId]).toMatchObject({
        phase: "pending",
        sourceType: "manual_override"
      });

      monotonic.advance(10 * 60 * 1_000);
      await runtime.tick();
      expect(runtime.state().manualOverrides).toEqual({});
    }
  );

  it("expires a current-process manual override by monotonic deadline after an actual wall rollback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "manual-rollback-"));
    directories.push(directory);
    const wall = fakeWall("2026-08-30T01:00:00.000Z");
    const monotonic = fakeMonotonic();
    const trust = new SystemClockTrustProvider(undefined, {
      stat: async () => ({ mtimeMs: 100, isFile: () => true })
    });
    const execute = vi.fn(executeSuccessfully);
    const runtime = new ScheduleRuntime({
      store: new FileAutomationStateStore(join(directory, "state.json")),
      wallClock: wall.now,
      monotonicClock: monotonic.now,
      clockTrust: trust,
      execute
    });
    await runtime.initialize();
    await runtime.recordFixtureState(fixtureId, 20);
    await activate(runtime, snapshot({ vehicleEventRules: [vehicleRule(80, 60)] }));
    await runtime.recordVehicleSensorState(sourceFixtureId, true);
    await runtime.prepareManualOverride(manualOverride(60, "2026-08-30T01:02:00.000Z"));
    await runtime.handoffManualTerminal("00000000-0000-4000-8000-000000000105", [
      successfulTerminal(fixtureId, 60)
    ]);
    execute.mockClear();

    wall.set("2026-08-30T00:50:00.000Z");
    monotonic.advance(120_001);
    await runtime.tick();

    expect(execute).toHaveBeenLastCalledWith([
      expect.objectContaining({ fixtureId, brightnessPercent: 80, sourceType: "vehicle_event_rule" })
    ]);
  });

  it("returns to an active event when manual expires and then restores the event pre-state", async () => {
    const test = await runtimeFixture("2026-08-30T01:00:00.000Z");
    await test.runtime.recordFixtureState(fixtureId, 20);
    await activate(test.runtime, snapshot({ vehicleEventRules: [vehicleRule(80, 5)] }));
    await test.runtime.recordVehicleSensorState(sourceFixtureId, true);
    await test.runtime.prepareManualOverride(manualOverride(60, "2026-08-30T01:00:10.000Z"));
    await test.runtime.handoffManualTerminal("00000000-0000-4000-8000-000000000105", [
      successfulTerminal(fixtureId, 60)
    ]);
    test.execute.mockClear();

    test.wall.set("2026-08-30T01:00:10.000Z");
    test.monotonic.advance(10_000);
    await test.runtime.tick();
    expect(test.execute).toHaveBeenLastCalledWith([
      expect.objectContaining({ fixtureId, brightnessPercent: 80, sourceType: "vehicle_event_rule" })
    ]);

    await test.runtime.recordVehicleSensorState(sourceFixtureId, false);
    test.monotonic.advance(5_001);
    await test.runtime.tick();
    expect(test.execute).toHaveBeenLastCalledWith([
      expect.objectContaining({ fixtureId, brightnessPercent: 20, sourceType: "current" })
    ]);
  });

  it("ends an active vehicle state when hot reload removes its High source", async () => {
    const test = await runtimeFixture("2026-08-30T01:00:00.000Z");
    await test.runtime.recordFixtureState(fixtureId, 20);
    await activate(test.runtime, snapshot({ vehicleEventRules: [vehicleRule(80, 60)] }));
    await test.runtime.recordVehicleSensorState(sourceFixtureId, true);
    test.execute.mockClear();

    await activate(test.runtime, snapshot({ vehicleEventRules: [{
      ...vehicleRule(80, 60),
      sourceFixtureIds: ["00000000-0000-4000-8000-000000000106"]
    }] }));

    expect(test.execute).toHaveBeenLastCalledWith([
      expect.objectContaining({ fixtureId, brightnessPercent: 20, sourceType: "current" })
    ]);
    expect(test.runtime.state().vehicleRules).toEqual({});
  });

  it("restores the scheduler snapshot and source state when config activation rolls back", async () => {
    const test = await runtimeFixture("2026-08-30T01:30:00.000Z");
    await test.runtime.recordFixtureState(fixtureId, 20);
    const active = snapshot({ schedules: [dailySchedule()] });
    await activate(test.runtime, active);
    const before = test.runtime.state();

    await test.runtime.recompute(snapshot({ schedules: [{ ...dailySchedule(), status: "disabled" }] }));
    await test.runtime.rollbackActivation();

    expect(test.runtime.state()).toEqual(before);
    expect(test.runtime.currentSnapshot?.schedules[0]?.status).toBe("enabled");
  });

  it("recovers a persisted UTC vehicle expiry into a new process monotonic deadline", async () => {
    const test = await runtimeFixture("2026-08-30T01:00:00.000Z");
    const rules = snapshot({ vehicleEventRules: [vehicleRule(80, 60)] });
    await test.runtime.recordFixtureState(fixtureId, 20);
    await activate(test.runtime, rules);
    await test.runtime.recordVehicleSensorState(sourceFixtureId, true);
    await test.runtime.recordVehicleSensorState(sourceFixtureId, false);

    test.wall.set("2026-08-30T01:00:30.000Z");
    const restartedExecute = vi.fn(executeSuccessfully);
    const restarted = new ScheduleRuntime({
      store: new FileAutomationStateStore(test.path),
      wallClock: test.wall.now,
      monotonicClock: test.monotonic.now,
      clockTrust: test.trust,
      execute: restartedExecute
    });
    await restarted.initialize();
    await activate(restarted, rules);
    expect(restartedExecute).not.toHaveBeenCalled();

    test.monotonic.advance(30_001);
    await restarted.tick();
    expect(restartedExecute).toHaveBeenLastCalledWith([
      expect.objectContaining({ fixtureId, brightnessPercent: 20, sourceType: "current" })
    ]);
  });

  it("does not let a schedule end overwrite a still-active manual source", async () => {
    const test = await runtimeFixture("2026-08-30T01:30:00.000Z");
    await test.runtime.recordFixtureState(fixtureId, 20);
    await activate(test.runtime, snapshot({ schedules: [dailySchedule()] }));
    await test.runtime.prepareManualOverride(manualOverride(60, "2026-08-30T02:10:00.000Z"));
    test.execute.mockClear();

    test.wall.set("2026-08-30T02:00:00.000Z");
    await test.runtime.tick();

    expect(test.execute).not.toHaveBeenCalled();
    expect(test.runtime.state().manualOverrides[fixtureId]).toMatchObject({ brightnessPercent: 60 });
    expect(test.runtime.state()).toMatchObject({
      lastDesiredByFixture: { [fixtureId]: 40 },
      transitionsByFixture: { [fixtureId]: { phase: "pending", brightnessPercent: 60 } }
    });
  });

  it("blocks new intake and drains queued RF, terminal state, and handoff before shutdown returns", async () => {
    const directory = await mkdtemp(join(tmpdir(), "schedule-drain-"));
    directories.push(directory);
    const rf = deferred<AutomationExecutionFixtureResultV1[]>();
    const handoff = deferred<void>();
    const onTerminalResults = vi.fn(() => handoff.promise);
    const runtime = new ScheduleRuntime({
      store: new FileAutomationStateStore(join(directory, "state.json")),
      wallClock: () => new Date("2026-08-30T01:30:00.000Z"),
      monotonicClock: () => 1_000,
      clockTrust: { isTrusted: async () => true },
      execute: () => rf.promise,
      onTerminalResults
    });
    await runtime.initialize();
    await runtime.recordFixtureState(fixtureId, 20);
    const desired = await runtime.recompute(snapshot({ schedules: [dailySchedule()] }));
    const applying = runtime.applyDesiredState(desired, {}).then(() => runtime.commitActivation());
    await vi.waitFor(() => expect(runtime.state().transitionsByFixture[fixtureId]?.phase).toBe("pending"));

    let drained = false;
    const stopping = runtime.stopAndDrain().then(() => { drained = true; });
    await expect(runtime.recordFixtureState(fixtureId, 30)).rejects.toThrow("automation_runtime_stopping");
    expect(drained).toBe(false);

    rf.resolve([successfulTerminal(fixtureId, 40)]);
    await vi.waitFor(() => expect(onTerminalResults).toHaveBeenCalledTimes(1));
    expect(drained).toBe(false);

    handoff.resolve();
    await applying;
    await stopping;
    expect(runtime.state().transitionsByFixture[fixtureId]).toMatchObject({
      phase: "terminal",
      status: "succeeded"
    });
    await runtime.tick();
    expect(onTerminalResults).toHaveBeenCalledTimes(1);
  });
});

async function runtimeFixture(initialWall: string) {
  const directory = await mkdtemp(join(tmpdir(), "schedule-runtime-"));
  directories.push(directory);
  const path = join(directory, "state.json");
  const wall = fakeWall(initialWall);
  const monotonic = fakeMonotonic();
  const trust = { trusted: true, async isTrusted() { return this.trusted; } };
  const execute = vi.fn(executeSuccessfully);
  const store = new FileAutomationStateStore(path);
  const runtime = new ScheduleRuntime({
    store,
    wallClock: wall.now,
    monotonicClock: monotonic.now,
    clockTrust: trust,
    execute
  });
  await runtime.initialize();
  return { runtime, store, path, wall, monotonic, trust, execute };
}

async function activate(runtime: ScheduleRuntime, value: AutomationSnapshotV1) {
  const desired = await runtime.recompute(value);
  await runtime.applyDesiredState(desired, {});
  await runtime.commitActivation();
}

function snapshot(patch: Partial<AutomationSnapshotV1>): AutomationSnapshotV1 {
  return automationSnapshot(1, { timeZone: "UTC", ...patch });
}

function dailySchedule(): LightingScheduleSnapshotV1 {
  return {
    id: scheduleId,
    name: "Morning",
    status: "enabled",
    activeFrom: "2026-08-01T00:00:00.000Z",
    activeUntil: "2026-09-30T23:59:59.000Z",
    localStartTime: "01:00",
    localEndTime: "02:00",
    recurrence: {
      kind: "daily",
      weeklyDays: [],
      monthlyDay: null,
      yearlyMonth: null,
      yearlyDay: null
    },
    action: { dimmingEnabled: true, brightnessPercent: 40 },
    fixtureIds: [fixtureId]
  };
}

function vehicleRule(brightnessPercent: number, holdSeconds: number): VehicleEventRuleSnapshotV1 {
  return {
    id: vehicleRuleId,
    name: "Vehicle",
    status: "enabled",
    sourceFixtureIds: [sourceFixtureId],
    targetFixtureIds: [fixtureId],
    action: { dimmingEnabled: true, brightnessPercent },
    holdSeconds
  };
}

function manualOverride(brightnessPercent: number, overrideUntil: string): ManualOverrideInput {
  return {
    sourceId: "00000000-0000-4000-8000-000000000105",
    fixtureIds: [fixtureId],
    brightnessPercent,
    startedAt: "2026-08-30T01:00:01.000Z",
    overrideUntil,
    deliveryWindowMs: 10_000
  };
}

async function executeSuccessfully(actions: DesiredLightingAction[]): Promise<AutomationExecutionFixtureResultV1[]> {
  return actions.map((action) => ({
    fixtureId: action.fixtureId,
    status: "succeeded",
    brightnessPercent: action.brightnessPercent,
    faultCode: null,
    errorCode: null,
    occurredAt: "2026-08-30T01:00:00.000Z"
  }));
}

function successfulTerminal(targetFixtureId: string, brightnessPercent: number): AutomationExecutionFixtureResultV1 {
  return {
    fixtureId: targetFixtureId,
    status: "succeeded",
    brightnessPercent,
    faultCode: null,
    errorCode: null,
    occurredAt: "2026-08-30T01:00:01.000Z"
  };
}

async function persistPendingSchedule(store: FileAutomationStateStore) {
  await store.update((state) => {
    state.transitionsByFixture[fixtureId] = {
      phase: "pending",
      brightnessPercent: 40,
      sourceType: "schedule",
      sourceId: scheduleId,
      occurrenceKey: `${scheduleId}:2026-08-30`,
      attempt: 1,
      startedAt: "2026-08-30T01:30:00.000Z",
      status: null,
      terminalAt: null
    };
    return state;
  });
}

function legacyActiveScheduleState() {
  return {
    schemaVersion: 1,
    activeOccurrences: {
      [scheduleId]: {
        key: `${scheduleId}:2026-08-30`,
        startedAt: "2026-08-30T01:00:00.000Z",
        endsAt: "2026-08-30T02:00:00.000Z",
        preBrightness: { [fixtureId]: 20 }
      }
    },
    manualOverrides: {},
    vehicleRules: {},
    currentByFixture: { [fixtureId]: 20 },
    baseBrightnessByFixture: { [fixtureId]: 20 },
    lastDesiredByFixture: { [fixtureId]: 40 }
  };
}

function legacyV2PendingScheduleState() {
  return {
    ...legacyActiveScheduleState(),
    schemaVersion: 2,
    lastDesiredByFixture: { [fixtureId]: 20 },
    transitionsByFixture: {
      [fixtureId]: {
        phase: "pending",
        brightnessPercent: 40,
        sourceType: "schedule",
        sourceId: scheduleId,
        occurrenceKey: `${scheduleId}:2026-08-30`,
        attempt: 1,
        startedAt: "2026-08-30T01:30:00.000Z",
        status: null,
        terminalAt: null
      }
    },
    telemetryGap: null
  };
}

function fakeWall(initial: string) {
  let value = new Date(initial);
  return {
    now: () => new Date(value),
    set: (next: string) => { value = new Date(next); }
  };
}

function fakeMonotonic() {
  let value = 0;
  return {
    now: () => value,
    advance: (milliseconds: number) => { value += milliseconds; }
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
