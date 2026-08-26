import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { BluezMeshAdapter } from "./bluez-mesh-adapter";

function fixture(options: { responseTimeoutMs?: number; observationCoherenceMs?: number; now?: () => number } = {}) {
  const application = new EventEmitter();
  const transport = {
    calls: [] as Array<{ method: string; args: unknown[] }>,
    call: vi.fn(async (_service: string, _path: string, _interfaceName: string, method: string, args: unknown[]) => {
      transport.calls.push({ method, args });
    })
  };
  const provisioner = {
    nodePath: "/org/bluez/mesh/node1",
    start: vi.fn(async () => undefined),
    scan: vi.fn(async () => [{ deviceUuid: "00112233445566778899aabbccddeeff", rssi: -48, oobCapability: "none" as const }]),
    provision: vi.fn(async () => ({ primaryUnicast: 0x0100, elementCount: 1 }))
  };
  const addresses = {
    findByFixtureId: vi.fn(async (fixtureId: string) => fixtureId === "fixture-1" ? {
      fixtureId, primaryUnicast: 0x0100, status: "confirmed" as const
    } : null),
    findByPrimaryUnicast: vi.fn(async (primaryUnicast: number) => primaryUnicast === 0x0100 ? {
      fixtureId: "fixture-1", primaryUnicast, elementCount: 1, status: "confirmed" as const
    } : null),
    listConfirmed: vi.fn(async () => [{ fixtureId: "fixture-1", primaryUnicast: 0x0100, elementCount: 1, status: "confirmed" as const }])
  };
  const config = {
    configureNode: vi.fn(async () => ({ compositionPage: 0 })),
    addModelSubscription: vi.fn(async () => ({ elementAddress: 0x0100, groupAddress: 0xc000, modelId: 0x1300 })),
    removeModelSubscription: vi.fn(async () => ({ elementAddress: 0x0100, groupAddress: 0xc000, modelId: 0x1300 }))
  };
  const transactions = {
    next: vi.fn(async () => 7),
    nextMany: vi.fn(async (destinations: number[]) => destinations.map(() => 7))
  };
  return {
    application, transport, provisioner, addresses, config, transactions,
    adapter: new BluezMeshAdapter(transport, application, provisioner, addresses, () => config, transactions, {
      responseTimeoutMs: options.responseTimeoutMs ?? 100,
      scanSeconds: 1,
      observationCoherenceMs: options.observationCoherenceMs,
      now: options.now
    })
  };
}

describe("BluezMeshAdapter", () => {
  it("does not acknowledge brightness until a matching Lightness Status arrives", async () => {
    const f = fixture();
    const command = f.adapter.setBrightness(["fixture-1"], 50);
    await vi.waitFor(() => expect(f.transport.calls).toHaveLength(1));
    let settled = false;
    void command.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    f.application.emit("messageReceived", {
      source: 0x0100,
      data: Uint8Array.from([0x82, 0x4e, 0x00, 0x80])
    });
    await expect(command).resolves.toEqual([
      { fixtureId: "fixture-1", acknowledged: true, brightness: 50, rssi: null, hopCount: null }
    ]);
  });

  it("preserves actual unicast brightness when status mismatches the request", async () => {
    const f = fixture();
    const pending = f.adapter.applyUnicast("fixture-1", 70);
    await vi.waitFor(() => expect(f.transport.call).toHaveBeenCalledTimes(1));
    f.application.emit("messageReceived", {
      source: 0x0100,
      data: Uint8Array.from([0x82, 0x4e, 0xcd, 0x4c])
    });

    await expect(pending).resolves.toMatchObject({
      fixtureId: "fixture-1",
      acknowledged: false,
      brightness: 30,
      faultCode: "state_mismatch"
    });
  });

  it("uses the remaining absolute deadline after slow preparation to retain a mismatch", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture({ responseTimeoutMs: 1000 });
      f.addresses.findByFixtureId.mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return { fixtureId: "fixture-1", primaryUnicast: 0x0100, status: "confirmed" as const };
      });
      const pending = f.adapter.applyUnicast("fixture-1", 70, undefined, Date.now() + 1000);

      await vi.advanceTimersByTimeAsync(400);
      expect(f.transport.call).toHaveBeenCalledTimes(1);
      f.application.emit("messageReceived", {
        source: 0x0100,
        data: Uint8Array.from([0x82, 0x4e, 0xcd, 0x4c])
      });
      await vi.advanceTimersByTimeAsync(599);
      let settled = false;
      void pending.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({
        acknowledged: false,
        brightness: 30,
        faultCode: "state_mismatch"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores an old periodic unicast status and resolves when the target status arrives", async () => {
    const f = fixture();
    const pending = f.adapter.applyUnicast("fixture-1", 70);
    await vi.waitFor(() => expect(f.transport.call).toHaveBeenCalledTimes(1));
    f.application.emit("messageReceived", {
      source: 0x0100,
      data: Uint8Array.from([0x82, 0x4e, 0xcd, 0x4c])
    });
    let settled = false;
    void pending.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    f.application.emit("messageReceived", {
      source: 0x0100,
      data: Uint8Array.from([0x82, 0x4e, 0x33, 0xb3])
    });
    await expect(pending).resolves.toMatchObject({ acknowledged: true, brightness: 70 });
  });

  it("does not send unicast after abort while durable TID allocation is pending", async () => {
    const f = fixture();
    const controller = new AbortController();
    let releaseTid!: (tid: number) => void;
    f.transactions.next.mockImplementationOnce(() => new Promise<number>((resolve) => { releaseTid = resolve; }));

    const pending = f.adapter.applyUnicast("fixture-1", 70, controller.signal);
    await vi.waitFor(() => expect(f.transactions.next).toHaveBeenCalledTimes(1));
    controller.abort();
    releaseTid(7);

    await expect(pending).resolves.toMatchObject({ acknowledged: false, outcome: "timed_out", faultCode: "command_aborted" });
    expect(f.transport.call).not.toHaveBeenCalled();
  });

  it("does not send a queued unicast after its absolute deadline", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      let releaseFirst!: () => void;
      f.transport.call.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseFirst = resolve; }));
      const first = f.adapter.applyUnicast("fixture-1", 70);
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(f.transport.call).toHaveBeenCalledTimes(1));

      const second = f.adapter.applyUnicast("fixture-1", 80, undefined, Date.now() + 1000);
      await vi.advanceTimersByTimeAsync(1001);
      releaseFirst();
      await vi.advanceTimersByTimeAsync(0);

      await first;
      await expect(second).resolves.toMatchObject({ outcome: "timed_out", faultCode: "command_deadline_exceeded" });
      expect(f.transport.call).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails an unmapped fixture before sending", async () => {
    const f = fixture();
    await expect(f.adapter.setBrightness(["missing"], 60)).resolves.toMatchObject([
      { fixtureId: "missing", acknowledged: false, faultCode: "MESH_MAPPING_NOT_FOUND" }
    ]);
    expect(f.transport.call).not.toHaveBeenCalled();
  });

  it("applies unicast commands with a bounded default concurrency of eight", async () => {
    const f = fixture();
    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    f.addresses.findByFixtureId.mockImplementation(async (fixtureId: string) => {
      const index = Number(fixtureId.slice("fixture-".length));
      return { fixtureId, primaryUnicast: 0x0100 + index, status: "confirmed" as const };
    });
    f.transport.call.mockImplementation(async (_service, _path, _interfaceName, _method, args) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      const destination = args[1] as number;
      queueMicrotask(() => f.application.emit("messageReceived", {
        source: destination,
        data: Uint8Array.from([0x82, 0x4e, 0xff, 0xff])
      }));
    });

    const result = f.adapter.applyParallelUnicast(
      Array.from({ length: 10 }, (_, index) => `fixture-${index}`),
      100
    );
    await vi.waitFor(() => expect(releases).toHaveLength(8));
    releases.splice(0, 8).forEach((release) => release());
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.splice(0).forEach((release) => release());

    await expect(result).resolves.toHaveLength(10);
    expect(maximumActive).toBe(8);
    expect(f.transactions.nextMany).toHaveBeenCalledWith(
      Array.from({ length: 10 }, (_, index) => 0x0100 + index)
    );
    expect(f.transactions.next).not.toHaveBeenCalled();
  });

  it("does not send parallel unicast when batch TID reservation crosses the absolute deadline", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.addresses.findByFixtureId.mockImplementation(async (fixtureId: string) => ({
        fixtureId,
        primaryUnicast: 0x0100 + Number(fixtureId.slice("fixture-".length)),
        status: "confirmed" as const
      }));
      f.transactions.nextMany.mockImplementationOnce(() => new Promise((resolve) => {
        setTimeout(() => resolve([1, 1]), 1001);
      }));

      const pending = f.adapter.applyParallelUnicast(
        ["fixture-1", "fixture-2"],
        100,
        8,
        undefined,
        Date.now() + 1000
      );
      await vi.advanceTimersByTimeAsync(1001);

      await expect(pending).resolves.toEqual([
        expect.objectContaining({ fixtureId: "fixture-1", outcome: "timed_out" }),
        expect.objectContaining({ fixtureId: "fixture-2", outcome: "timed_out" })
      ]);
      expect(f.transport.call).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not schedule another parallel-unicast batch after abort", async () => {
    const f = fixture();
    const controller = new AbortController();
    const releases: Array<() => void> = [];
    f.addresses.findByFixtureId.mockImplementation(async (fixtureId: string) => ({
      fixtureId,
      primaryUnicast: 0x0100 + Number(fixtureId.slice("fixture-".length)),
      status: "confirmed" as const
    }));
    f.transport.call.mockImplementation(async () => new Promise<void>((resolve) => releases.push(resolve)));

    const pending = f.adapter.applyParallelUnicast(
      Array.from({ length: 12 }, (_, index) => `fixture-${index}`),
      100,
      8,
      controller.signal
    );
    await vi.waitFor(() => expect(f.transport.call).toHaveBeenCalledTimes(8));
    controller.abort();
    releases.splice(0).forEach((release) => release());
    await pending;

    expect(f.transport.call).toHaveBeenCalledTimes(8);
  });

  it("sends one unacknowledged group command and aggregates actual status by expected source", async () => {
    const f = fixture();
    configureGroupFixtures(f);
    const baselineListeners = f.application.listenerCount("messageReceived");

    const result = f.adapter.applyMeshGroup(0xc000, ["fixture-1", "fixture-2"], 70);
    await vi.waitFor(() => expect(f.transport.call).toHaveBeenCalledTimes(1));
    expect(f.transport.calls[0].args[1]).toBe(0xc000);
    expect(f.transport.calls[0].args[4]).toEqual([0x82, 0x4d, 0x33, 0xb3, 0x07]);
    f.application.emit("messageReceived", {
      source: 0x0100,
      data: Uint8Array.from([0x82, 0x4e, 0x33, 0xb3])
    });
    f.application.emit("messageReceived", {
      source: 0x0101,
      data: Uint8Array.from([0x82, 0x4e, 0x33, 0xb3])
    });

    await expect(result).resolves.toEqual([
      { fixtureId: "fixture-1", acknowledged: true, outcome: "applied", brightness: 70, rssi: null, hopCount: null },
      { fixtureId: "fixture-2", acknowledged: true, outcome: "applied", brightness: 70, rssi: null, hopCount: null }
    ]);
    expect(f.application.listenerCount("messageReceived")).toBe(baselineListeners);
  });

  it("keeps mismatching periodic group statuses until target statuses arrive", async () => {
    const f = fixture();
    configureGroupFixtures(f);
    const pending = f.adapter.applyMeshGroup(0xc000, ["fixture-1", "fixture-2"], 70);
    await vi.waitFor(() => expect(f.transport.call).toHaveBeenCalledTimes(1));
    for (const source of [0x0100, 0x0101]) {
      f.application.emit("messageReceived", {
        source,
        data: Uint8Array.from([0x82, 0x4e, 0xcd, 0x4c])
      });
    }
    let settled = false;
    void pending.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    for (const source of [0x0100, 0x0101]) {
      f.application.emit("messageReceived", {
        source,
        data: Uint8Array.from([0x82, 0x4e, 0x33, 0xb3])
      });
    }
    await expect(pending).resolves.toEqual([
      expect.objectContaining({ fixtureId: "fixture-1", acknowledged: true }),
      expect.objectContaining({ fixtureId: "fixture-2", acknowledged: true })
    ]);
  });

  it("does not send a queued group command after it is aborted behind an overlapping source lock", async () => {
    const f = fixture();
    configureGroupFixtures(f);
    const first = f.adapter.applyMeshGroup(0xc000, ["fixture-1", "fixture-2"], 70);
    await vi.waitFor(() => expect(f.transport.call).toHaveBeenCalledTimes(1));
    const controller = new AbortController();
    const second = f.adapter.applyMeshGroup(0xc001, ["fixture-1", "fixture-2"], 80, controller.signal);
    controller.abort();

    for (const source of [0x0100, 0x0101]) {
      f.application.emit("messageReceived", {
        source,
        data: Uint8Array.from([0x82, 0x4e, 0x33, 0xb3])
      });
    }
    await first;
    await expect(second).resolves.toEqual([
      expect.objectContaining({ fixtureId: "fixture-1", outcome: "timed_out", faultCode: "command_aborted" }),
      expect.objectContaining({ fixtureId: "fixture-2", outcome: "timed_out", faultCode: "command_aborted" })
    ]);
    expect(f.transport.call).toHaveBeenCalledTimes(1);
  });

  it("classifies group state mismatch and missing status without leaking listeners", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      configureGroupFixtures(f);
      const baselineListeners = f.application.listenerCount("messageReceived");
      const result = f.adapter.applyMeshGroup(0xc000, ["fixture-1", "fixture-2"], 70);
      await vi.advanceTimersByTimeAsync(0);
      f.application.emit("messageReceived", {
        source: 0x0100,
        data: Uint8Array.from([0x82, 0x4e, 0xcc, 0x4c])
      });
      await vi.advanceTimersByTimeAsync(100);

      await expect(result).resolves.toEqual([
        expect.objectContaining({ fixtureId: "fixture-1", acknowledged: false, outcome: "failed", faultCode: "state_mismatch" }),
        expect.objectContaining({ fixtureId: "fixture-2", acknowledged: false, outcome: "timed_out", faultCode: "status_timeout" })
      ]);
      expect(f.application.listenerCount("messageReceived")).toBe(baselineListeners);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not send a group command when any expected fixture mapping is unavailable", async () => {
    const f = fixture();
    await expect(f.adapter.applyMeshGroup(0xc000, ["fixture-1", "missing"], 70)).resolves.toEqual([
      expect.objectContaining({ fixtureId: "fixture-1", outcome: "failed", faultCode: "mesh_mapping_incomplete" }),
      expect.objectContaining({ fixtureId: "missing", outcome: "failed", faultCode: "mesh_mapping_incomplete" })
    ]);
    expect(f.transport.call).not.toHaveBeenCalled();
  });

  it("normalizes scan and configures a provisioned node before completion", async () => {
    const f = fixture();
    await expect(f.adapter.scan({ sessionId: "session-1" } as never)).resolves.toMatchObject([
      { deviceUuid: "00112233445566778899aabbccddeeff", serialNumber: "00112233445566778899aabbccddeeff" }
    ]);
    await expect(f.adapter.provision({
      sessionId: "session-1",
      nodeId: "fixture-1",
      deviceUuid: "00112233445566778899aabbccddeeff",
      meshAddress: "0x0100"
    } as never)).resolves.toMatchObject({ nodeId: "fixture-1", meshAddress: "0x0100" });
    expect(f.config.configureNode).toHaveBeenCalledWith({ unicast: 0x0100, elementCount: 1 });
  });

  it("waits for both OnOff and Lightness before publishing a fault snapshot from reverse-order messages", async () => {
    const f = fixture();
    const received: unknown[] = [];
    const unsubscribe = f.adapter.onFixtureStatus((status) => received.push(status));

    f.application.emit("messageReceived", { source: 0x0100, data: Uint8Array.from([0x04, 0x01, 0xe5, 0x02, 0x01]) });
    f.application.emit("messageReceived", { source: 0x0100, data: Uint8Array.from([0x82, 0x4e, 0xff, 0xff]) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toEqual([]);

    f.application.emit("messageReceived", { source: 0x0100, data: Uint8Array.from([0x82, 0x04, 0x01]) });
    await vi.waitFor(() => expect(received).toEqual([
      expect.objectContaining({
        fixtureId: "fixture-1",
        brightness: 100,
        powerOn: true,
        status: "fault",
        faultCode: "health:02e5:01",
        health: { faultCodes: [1], observedAt: expect.any(String) }
      })
    ]));
    unsubscribe();
  });

  it("does not treat registered or no-fault Health status as an operational fault", async () => {
    const f = fixture();
    const listener = vi.fn();
    f.adapter.onFixtureStatus(listener);
    f.application.emit("messageReceived", { source: 0x0100, data: Uint8Array.from([0x04, 0x01, 0xe5, 0x02, 0x00]) });
    f.application.emit("messageReceived", { source: 0x0100, data: Uint8Array.from([0x82, 0x04, 0x01]) });
    f.application.emit("messageReceived", { source: 0x0100, data: Uint8Array.from([0x82, 0x4e, 0xff, 0xff]) });
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    f.application.emit("messageReceived", { source: 0x0100, data: Uint8Array.from([0x05, 0x01, 0xe5, 0x02, 0x01]) });
    f.application.emit("messageReceived", { source: 0x0100, data: Uint8Array.from([0x04, 0x01, 0xe5, 0x02, 0x00]) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listener).toHaveBeenCalledTimes(1);
    f.application.emit("messageReceived", { source: 0x0100, data: Uint8Array.from([0x82, 0x04, 0x01]) });
    f.application.emit("messageReceived", { source: 0x0100, data: Uint8Array.from([0x82, 0x4e, 0xff, 0xff]) });
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ status: "online" }));
  });

  it("does not combine a fresh OnOff observation with stale Lightness and Health observations", async () => {
    const f = fixture();
    const listener = vi.fn();
    f.adapter.onFixtureStatus(listener);

    f.application.emit("messageReceived", { source: 0x0100, data: Uint8Array.from([0x04, 0x01, 0xe5, 0x02, 0x00]) });
    f.application.emit("messageReceived", { source: 0x0100, data: Uint8Array.from([0x82, 0x4e, 0xff, 0xff]) });
    f.application.emit("messageReceived", { source: 0x0100, data: Uint8Array.from([0x82, 0x04, 0x01]) });
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));

    listener.mockClear();
    f.application.emit("messageReceived", { source: 0x0100, data: Uint8Array.from([0x82, 0x04, 0x00]) });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(listener).not.toHaveBeenCalled();
  });

  it("starts a new generation when a counterpart arrives after the coherence window", async () => {
    let now = 0;
    const f = fixture({ observationCoherenceMs: 10, now: () => now });
    const listener = vi.fn();
    f.adapter.onFixtureStatus(listener);
    f.application.emit("messageReceived", { source: 0x0100, data: Uint8Array.from([0x04, 0x01, 0xe5, 0x02, 0x00]) });
    f.application.emit("messageReceived", { source: 0x0100, data: Uint8Array.from([0x82, 0x04, 0x01]) });
    await new Promise((resolve) => setTimeout(resolve, 0));

    now = 11;
    f.application.emit("messageReceived", { source: 0x0100, data: Uint8Array.from([0x82, 0x4e, 0xff, 0xff]) });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(listener).not.toHaveBeenCalled();
  });

  it("resets the fixture observation generation before a startup resync", async () => {
    const f = fixture();
    const listener = vi.fn();
    f.adapter.onFixtureStatus(listener);
    f.application.emit("messageReceived", { source: 0x0100, data: Uint8Array.from([0x04, 0x01, 0xe5, 0x02, 0x00]) });
    f.application.emit("messageReceived", { source: 0x0100, data: Uint8Array.from([0x82, 0x4e, 0xff, 0xff]) });
    f.application.emit("messageReceived", { source: 0x0100, data: Uint8Array.from([0x82, 0x04, 0x01]) });
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));

    listener.mockClear();
    const resync = f.adapter.resyncFixtureStates();
    await vi.waitFor(() => expect(f.transport.calls.filter((call) => call.method === "Send")).toHaveLength(3));
    f.application.emit("messageReceived", { source: 0x0100, data: Uint8Array.from([0x82, 0x04, 0x00]) });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(listener).not.toHaveBeenCalled();
    await expect(resync).resolves.toMatchObject({ observed: 0, timedOut: 1 });
  });

  it("does not publish online until Health Current is actually observed", async () => {
    const f = fixture();
    const listener = vi.fn();
    f.adapter.onFixtureStatus(listener);

    f.application.emit("messageReceived", { source: 0x0100, data: Uint8Array.from([0x82, 0x04, 0x01]) });
    f.application.emit("messageReceived", { source: 0x0100, data: Uint8Array.from([0x82, 0x4e, 0xff, 0xff]) });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(listener).not.toHaveBeenCalled();
  });

  it("publishes an actual startup Current Fault only after the complete observation arrives", async () => {
    const f = fixture();
    const listener = vi.fn();
    f.adapter.onFixtureStatus(listener);
    const resync = f.adapter.resyncFixtureStates();
    await vi.waitFor(() => expect(f.transport.calls.filter((call) => call.method === "Send")).toHaveLength(3));

    f.application.emit("messageReceived", { source: 0x0100, data: Uint8Array.from([0x82, 0x04, 0x01]) });
    f.application.emit("messageReceived", { source: 0x0100, data: Uint8Array.from([0x82, 0x4e, 0xff, 0xff]) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listener).not.toHaveBeenCalled();
    f.application.emit("messageReceived", { source: 0x0100, data: Uint8Array.from([0x04, 0x01, 0xe5, 0x02, 0x01]) });

    await expect(resync).resolves.toMatchObject({ observed: 1, timedOut: 0 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ status: "fault", faultCode: "health:02e5:01" }));
  });

  it("counts an actual OnOff and Lightness resync pair as observed while Health Current remains pending", async () => {
    const f = fixture();
    const listener = vi.fn();
    f.adapter.onFixtureStatus(listener);
    const resync = f.adapter.resyncFixtureStates();
    await vi.waitFor(() => expect(f.transport.calls.filter((call) => call.method === "Send")).toHaveLength(3));

    f.application.emit("messageReceived", { source: 0x0100, data: Uint8Array.from([0x82, 0x04, 0x01]) });
    f.application.emit("messageReceived", { source: 0x0100, data: Uint8Array.from([0x82, 0x4e, 0xff, 0xff]) });
    f.application.emit("messageReceived", { source: 0x0100, data: Uint8Array.from([0x05, 0x01, 0xe5, 0x02, 0x00]) });

    await expect(resync).resolves.toMatchObject({ total: 1, configured: 1, observed: 1, healthPending: 1, timedOut: 0, failed: 0 });
    expect(listener).not.toHaveBeenCalled();
  });

  it("publishes a late Current Fault and clears the pending resync health report", async () => {
    const f = fixture();
    const listener = vi.fn();
    f.adapter.onFixtureStatus(listener);
    const resync = f.adapter.resyncFixtureStates();
    await vi.waitFor(() => expect(f.transport.calls.filter((call) => call.method === "Send")).toHaveLength(3));
    f.application.emit("messageReceived", { source: 0x0100, data: Uint8Array.from([0x82, 0x04, 0x01]) });
    f.application.emit("messageReceived", { source: 0x0100, data: Uint8Array.from([0x82, 0x4e, 0xff, 0xff]) });

    const report = await resync;
    expect(report).toMatchObject({ observed: 1, healthPending: 1, timedOut: 0 });
    expect(listener).not.toHaveBeenCalled();
    const reports: unknown[] = [];
    const unsubscribe = (f.adapter as unknown as { onResyncReport(listener: (updated: unknown) => void): () => void })
      .onResyncReport((updated) => reports.push(updated));
    f.application.emit("messageReceived", { source: 0x0100, data: Uint8Array.from([0x04, 0x01, 0xe5, 0x02, 0x01]) });

    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(expect.objectContaining({ status: "fault", faultCode: "health:02e5:01" })));
    expect(report).toMatchObject({ healthPending: 0 });
    expect(reports).toEqual([expect.objectContaining({ observed: 1, healthPending: 0 })]);
    unsubscribe();
  });

  it("drops unsolicited status from an unknown source address", async () => {
    const f = fixture();
    const listener = vi.fn();
    f.adapter.onFixtureStatus(listener);
    f.application.emit("messageReceived", { source: 0x7fff, data: Uint8Array.from([0x82, 0x4e, 0xff, 0xff]) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listener).not.toHaveBeenCalled();
  });

  it("reapplies confirmed-node configuration before querying actual status without declaring a missing reply offline", async () => {
    const f = fixture();
    await f.adapter.resyncFixtureStates();
    expect(f.config.configureNode).toHaveBeenCalledWith({ unicast: 0x0100, elementCount: 1 });
    expect(f.transport.calls.filter((call) => call.method === "Send")).toHaveLength(3);
    expect(f.transport.calls.filter((call) => call.method === "Send").map((call) => call.args[4])).toEqual([
      [0x82, 0x01], [0x82, 0x4b], [0x80, 0x31, 0xe5, 0x02]
    ]);
  });

  it("reapplies a Light Lightness Server group subscription for each member and reports failures individually", async () => {
    const f = fixture();
    f.config.addModelSubscription
      .mockResolvedValueOnce({ elementAddress: 0x0100, groupAddress: 0xc000, modelId: 0x1300 })
      .mockRejectedValueOnce(new Error("subscription rejected"));

    await expect(f.adapter.syncGroupSubscriptions({
      siteId: "00000000-0000-4000-8000-000000000010",
      gatewayId: "00000000-0000-4000-8000-000000000011",
      groupId: "00000000-0000-4000-8000-000000000012",
      version: 2,
      groupAddress: "0xc000",
      desiredMembers: [
        { meshNodeId: "fixture-1", meshAddress: "0x0100" },
        { meshNodeId: "fixture-2", meshAddress: "0x0101" }
      ],
      expectedOperations: [
        { operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", action: "add", meshNodeId: "fixture-1", meshAddress: "0x0100" },
        { operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", action: "add", meshNodeId: "fixture-2", meshAddress: "0x0101" }
      ],
      requestedAt: "2026-08-21T00:00:00.000Z"
    })).resolves.toMatchObject({
      groupId: "00000000-0000-4000-8000-000000000012",
      version: 2,
      operations: [
        { action: "add", meshNodeId: "fixture-1", status: "ready" },
        { action: "add", meshNodeId: "fixture-2", status: "failed", error: "subscription rejected" }
      ]
    });
    expect(f.config.addModelSubscription).toHaveBeenNthCalledWith(1, { unicast: 0x0100, groupAddress: 0xc000 });
    expect(f.config.addModelSubscription).toHaveBeenNthCalledWith(2, { unicast: 0x0101, groupAddress: 0xc000 });

    await expect(f.adapter.syncGroupSubscriptions({
      siteId: "00000000-0000-4000-8000-000000000010",
      gatewayId: "00000000-0000-4000-8000-000000000011",
      groupId: "00000000-0000-4000-8000-000000000012",
      version: 3,
      groupAddress: "0xc000",
      desiredMembers: [],
      expectedOperations: [
        { operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3", action: "delete", meshNodeId: "fixture-1", meshAddress: "0x0100" }
      ],
      requestedAt: "2026-08-21T00:01:00.000Z"
    })).resolves.toMatchObject({ operations: [{ action: "delete", meshNodeId: "fixture-1", status: "ready" }] });
    expect(f.config.removeModelSubscription).toHaveBeenCalledWith({ unicast: 0x0100, groupAddress: 0xc000 });
  });

  it("replaces a member address with an old-address delete and new-address add", async () => {
    const f = fixture();
    const base = {
      siteId: "00000000-0000-4000-8000-000000000010",
      gatewayId: "00000000-0000-4000-8000-000000000011",
      groupId: "00000000-0000-4000-8000-000000000012",
      groupAddress: "0xc000",
      requestedAt: "2026-08-21T00:00:00.000Z"
    };
    await f.adapter.syncGroupSubscriptions({
      ...base,
      version: 2,
      desiredMembers: [{ meshNodeId: "fixture-1", meshAddress: "0x0100" }],
      expectedOperations: [{ operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", action: "add", meshNodeId: "fixture-1", meshAddress: "0x0100" }]
    });

    await expect(f.adapter.syncGroupSubscriptions({
      ...base,
      version: 3,
      desiredMembers: [{ meshNodeId: "fixture-1", meshAddress: "0x0101" }],
      expectedOperations: [
        { operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2", action: "delete", meshNodeId: "fixture-1", meshAddress: "0x0100" },
        { operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3", action: "add", meshNodeId: "fixture-1", meshAddress: "0x0101" }
      ]
    })).resolves.toMatchObject({
      operations: [
        { operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2", action: "delete", meshNodeId: "fixture-1", meshAddress: "0x0100", status: "ready" },
        { operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3", action: "add", meshNodeId: "fixture-1", meshAddress: "0x0101", status: "ready" }
      ]
    });
    expect(f.config.removeModelSubscription).toHaveBeenCalledWith({ unicast: 0x0100, groupAddress: 0xc000 });
    expect(f.config.addModelSubscription).toHaveBeenLastCalledWith({ unicast: 0x0101, groupAddress: 0xc000 });
  });

  it("retries only the residual old-address delete after a replacement partially succeeds", async () => {
    const f = fixture();
    const base = {
      siteId: "00000000-0000-4000-8000-000000000010",
      gatewayId: "00000000-0000-4000-8000-000000000011",
      groupId: "00000000-0000-4000-8000-000000000012",
      groupAddress: "0xc000",
      requestedAt: "2026-08-21T00:00:00.000Z"
    };
    await f.adapter.syncGroupSubscriptions({
      ...base,
      version: 2,
      desiredMembers: [{ meshNodeId: "fixture-1", meshAddress: "0x0100" }],
      expectedOperations: [{ operationId: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1", action: "add", meshNodeId: "fixture-1", meshAddress: "0x0100" }]
    });
    f.config.removeModelSubscription.mockRejectedValueOnce(new Error("old address still active"));

    await expect(f.adapter.syncGroupSubscriptions({
      ...base,
      version: 3,
      desiredMembers: [{ meshNodeId: "fixture-1", meshAddress: "0x0101" }],
      expectedOperations: [
        { operationId: "cccccccc-cccc-4ccc-8ccc-ccccccccccc2", action: "delete", meshNodeId: "fixture-1", meshAddress: "0x0100" },
        { operationId: "cccccccc-cccc-4ccc-8ccc-ccccccccccc3", action: "add", meshNodeId: "fixture-1", meshAddress: "0x0101" }
      ]
    })).resolves.toMatchObject({
      operations: [
        { action: "delete", meshAddress: "0x0100", status: "failed" },
        { action: "add", meshAddress: "0x0101", status: "ready" }
      ]
    });
    const addCallsAfterPartial = f.config.addModelSubscription.mock.calls.length;

    await expect(f.adapter.syncGroupSubscriptions({
      ...base,
      version: 4,
      desiredMembers: [{ meshNodeId: "fixture-1", meshAddress: "0x0101" }],
      expectedOperations: [{ operationId: "cccccccc-cccc-4ccc-8ccc-ccccccccccc4", action: "delete", meshNodeId: "fixture-1", meshAddress: "0x0100" }]
    })).resolves.toMatchObject({
      operations: [{ action: "delete", meshAddress: "0x0100", status: "ready" }]
    });
    expect(f.config.addModelSubscription).toHaveBeenCalledTimes(addCallsAfterPartial);
  });

  it("runs one bounded resync when reconnects overlap", async () => {
    const f = fixture();
    let resolveConfig: (() => void) | undefined;
    f.config.configureNode.mockImplementationOnce(() => new Promise<{ compositionPage: number }>((resolve) => {
      resolveConfig = () => resolve({ compositionPage: 0 });
    }));
    const first = f.adapter.resyncFixtureStates();
    const second = f.adapter.resyncFixtureStates();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(f.config.configureNode).toHaveBeenCalledTimes(1));
    resolveConfig?.();
    await expect(first).resolves.toMatchObject({ total: 1, configured: 1, observed: 0, timedOut: 1 });
  });

  it("bounds a 1,000-node resync queue and retries a busy Mesh send", async () => {
    let now = 0;
    const f = fixture({ observationCoherenceMs: 65_000, now: () => now });
    const mappings = Array.from({ length: 1000 }, (_, index) => ({
      fixtureId: `fixture-${index}`,
      primaryUnicast: index + 0x0100,
      elementCount: 1,
      status: "confirmed" as const
    }));
    let activeConfigures = 0;
    let maximumActiveConfigures = 0;
    f.addresses.listConfirmed.mockResolvedValue(mappings);
    f.config.configureNode.mockImplementation(async () => {
      activeConfigures += 1;
      maximumActiveConfigures = Math.max(maximumActiveConfigures, activeConfigures);
      await new Promise((resolve) => setTimeout(resolve, 1));
      now += 100;
      activeConfigures -= 1;
      return { compositionPage: 0 };
    });
    f.addresses.findByPrimaryUnicast.mockImplementation(async (primaryUnicast: number) => ({
      fixtureId: `fixture-${primaryUnicast - 0x0100}`,
      primaryUnicast,
      elementCount: 1,
      status: "confirmed" as const
    }));
    let busy = true;
    f.transport.call.mockImplementation(async (_service, _path, _interfaceName, method, args) => {
      f.transport.calls.push({ method, args });
      if (method !== "Send") return;
      if (busy) {
        busy = false;
        now += 70_000;
        throw new Error("BlueZ busy");
      }
      const destination = args[1] as number;
      const payload = args[4] as number[];
      if (payload[0] === 0x82 && payload[1] === 0x01) {
        queueMicrotask(() => f.application.emit("messageReceived", {
          source: destination,
          data: Uint8Array.from([0x82, 0x04, 0x01])
        }));
      }
      if (payload[0] === 0x82 && payload[1] === 0x4b) {
        queueMicrotask(() => f.application.emit("messageReceived", {
          source: destination,
          data: Uint8Array.from([0x82, 0x4e, 0xff, 0xff])
        }));
      }
      if (payload[0] === 0x80 && payload[1] === 0x31) {
        queueMicrotask(() => f.application.emit("messageReceived", {
          source: destination,
          data: Uint8Array.from([0x05, 0x01, 0xe5, 0x02, 0x00])
        }));
      }
    });

    await expect(f.adapter.resyncFixtureStates()).resolves.toMatchObject({ total: 1000, configured: 1000, observed: 1000, healthPending: 1000, timedOut: 0 });
    expect(maximumActiveConfigures).toBeLessThanOrEqual(4);
    expect(f.transport.call).toHaveBeenCalledTimes(3001);
  }, 10_000);
});

function configureGroupFixtures(f: ReturnType<typeof fixture>) {
  f.addresses.findByFixtureId.mockImplementation(async (fixtureId: string) => {
    if (fixtureId === "fixture-1") return { fixtureId, primaryUnicast: 0x0100, status: "confirmed" as const };
    if (fixtureId === "fixture-2") return { fixtureId, primaryUnicast: 0x0101, status: "confirmed" as const };
    return null;
  });
  f.addresses.findByPrimaryUnicast.mockImplementation(async (primaryUnicast: number) => {
    if (primaryUnicast !== 0x0100 && primaryUnicast !== 0x0101) return null;
    return {
      fixtureId: primaryUnicast === 0x0100 ? "fixture-1" : "fixture-2",
      primaryUnicast,
      elementCount: 1,
      status: "confirmed" as const
    };
  });
}
