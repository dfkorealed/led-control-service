import { describe, expect, it, vi } from "vitest";
import { StubBleMeshAdapter } from "../../test/stub-adapters";
import { handleGatewayDimmingCommand, parseCommandTimeout } from "./gateway-command-handler";

const command = {
  commandId: "11111111-1111-4111-8111-111111111111",
  dispatchId: "22222222-2222-4222-8222-222222222222",
  idempotencyKey: "33333333-3333-4333-8333-333333333333",
  sequence: 1,
  siteId: "44444444-4444-4444-8444-444444444444",
  gatewayId: "55555555-5555-4555-8555-555555555555",
  targetType: "fixture" as const,
  targetId: "66666666-6666-4666-8666-666666666666",
  targetFixtureIds: ["66666666-6666-4666-8666-666666666666"],
  brightness: 65,
  requestedBy: "77777777-7777-4777-8777-777777777777",
  requestedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString()
};

describe("handleGatewayDimmingCommand", () => {
  it("validates the production BLE status timeout at startup", () => {
    expect(parseCommandTimeout(undefined)).toBe(8000);
    expect(() => parseCommandTimeout("999")).toThrow("1000-300000ms");
    expect(() => parseCommandTimeout("invalid")).toThrow("1000-300000ms");
  });
  it("returns acceptance then device status and reuses terminal result for duplicates", async () => {
    const records = new Map<string, any>();
    const journal = {
      get: async (key: string) => records.get(key) ?? null,
      accept: async (key: string, value: unknown) => {
        records.set(key, { state: "accepted", command: value });
        return true;
      },
      complete: async (key: string, result: unknown) => {
        records.set(key, { ...records.get(key), state: "completed", result });
      }
    };
    const adapter = new StubBleMeshAdapter();

    const first = await handleGatewayDimmingCommand(adapter, journal, command);
    const duplicate = await handleGatewayDimmingCommand(adapter, journal, command);

    expect(first.acceptance.status).toBe("accepted");
    expect(first.deviceStatus).toMatchObject({ status: "succeeded", results: [{ status: "succeeded", brightness: 65 }] });
    expect(duplicate).toEqual(first);
    expect(adapter.commands).toHaveLength(1);
  });

  it("rejects a command whose publish-relative expiry passed without calling BLE or observing fixture state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T00:00:10.000Z"));
    const records = new Map<string, any>();
    const adapter = new StubBleMeshAdapter();

    const result = await handleGatewayDimmingCommand(adapter, memoryJournal(records), {
      ...command,
      requestedAt: "2026-07-01T00:00:00.000Z",
      expiresAt: "2026-07-11T00:00:00.000Z"
    });

    expect(result.acceptance).toMatchObject({ status: "rejected", errorCode: "COMMAND_EXPIRED" });
    expect(result.deviceStatus).toMatchObject({
      status: "failed",
      results: [{ status: "failed", errorMessage: "gateway command expired before execution" }]
    });
    expect(result.fixtureStateObserved).toBe(false);
    expect(adapter.commands).toHaveLength(0);
    vi.useRealTimers();
  });

  it("does not reject an old requestedAt when its publish-relative expiry is still valid", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T00:00:01.000Z"));
    const adapter = new StubBleMeshAdapter();

    const result = await handleGatewayDimmingCommand(adapter, memoryJournal(new Map()), {
      ...command,
      requestedAt: "2026-07-01T00:00:00.000Z",
      expiresAt: "2026-07-11T00:00:10.000Z"
    });

    expect(result.acceptance.status).toBe("accepted");
    expect(result.fixtureStateObserved).toBe(true);
    expect(adapter.commands).toHaveLength(1);
    vi.useRealTimers();
  });

  it("rejects after a delayed acceptance crosses expiry before BLE starts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T00:00:07.999Z"));
    const records = new Map<string, any>();
    const adapter = new StubBleMeshAdapter();
    let releaseAcceptance!: () => void;
    let acceptanceStarted!: () => void;
    const acceptanceGate = new Promise<void>((resolve) => { releaseAcceptance = resolve; });
    const acceptanceStartedGate = new Promise<void>((resolve) => { acceptanceStarted = resolve; });

    const resultPromise = handleGatewayDimmingCommand(
      adapter,
      memoryJournal(records),
      { ...command, expiresAt: "2026-07-11T00:00:10.000Z" },
      async (acceptance) => {
        expect(acceptance.status).toBe("accepted");
        acceptanceStarted();
        await acceptanceGate;
      }
    );
    await acceptanceStartedGate;
    await vi.advanceTimersByTimeAsync(1);
    releaseAcceptance();

    const result = await resultPromise;

    expect(result.acceptance).toMatchObject({ status: "rejected", errorCode: "COMMAND_EXPIRED" });
    expect(result.deviceStatus.status).toBe("failed");
    expect(result.fixtureStateObserved).toBe(false);
    expect(records.get(command.idempotencyKey)).toMatchObject({ state: "completed", result: { acceptance: { status: "rejected" } } });
    expect(adapter.commands).toHaveLength(0);
    vi.useRealTimers();
  });

  it("times out a BLE adapter that never returns", async () => {
    vi.useFakeTimers();
    const records = new Map<string, any>();
    const journal = memoryJournal(records);
    const pendingAdapter = { setBrightness: vi.fn(() => new Promise<never>(() => undefined)) };

    const resultPromise = handleGatewayDimmingCommand(pendingAdapter, journal, command, undefined, { timeoutMs: 8000 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(8000);
    const result = await resultPromise;

    expect(result.deviceStatus).toMatchObject({
      status: "timed_out",
      results: [{ fixtureId: command.targetFixtureIds[0], status: "timed_out", errorMessage: "BLE Mesh status timeout after 8000ms" }]
    });
    vi.useRealTimers();
  });

  it("closes an accepted-only restart as indeterminate without controlling again", async () => {
    const acceptance = {
      commandId: command.commandId,
      dispatchId: command.dispatchId,
      idempotencyKey: command.idempotencyKey,
      sequence: command.sequence,
      siteId: command.siteId,
      gatewayId: command.gatewayId,
      eventId: "88888888-8888-4888-8888-888888888888",
      status: "accepted" as const,
      acceptedAt: "2026-07-11T00:00:01.000Z"
    };
    const records = new Map<string, any>([
      [command.idempotencyKey, { state: "accepted", command: { command, acceptance } }]
    ]);
    const journal = memoryJournal(records);
    const adapter = new StubBleMeshAdapter();

    const result = await handleGatewayDimmingCommand(adapter, journal, command);

    expect(result.deviceStatus.status).toBe("timed_out");
    expect(result.deviceStatus.results[0]).toMatchObject({ status: "timed_out", errorMessage: "indeterminate after gateway restart" });
    expect(adapter.commands).toHaveLength(0);
  });
});

function memoryJournal(records: Map<string, any>) {
  return {
    get: async (key: string) => records.get(key) ?? null,
    accept: async (key: string, value: unknown) => {
      if (records.has(key)) return false;
      records.set(key, { state: "accepted", command: value });
      return true;
    },
    complete: async (key: string, result: unknown) => {
      records.set(key, { ...records.get(key), state: "completed", result });
    }
  };
}
