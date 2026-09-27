import { randomUUID } from "node:crypto";
import { CommandSafetyDigest } from "./command-safety-digest";
import { CommandLateSetAckService } from "./command-late-set-ack.service";

const ids = { site: randomUUID(), gateway: randomUUID(), original: randomUUID(), dispatch: randomUUID(),
  key: randomUUID(), hold: randomUUID(), fixture: randomUUID() };
const digest = new CommandSafetyDigest({ activeVersion: 1,
  keys: { 1: Buffer.alloc(32, 0x66).toString("base64url") } });
const ack = (brightness = 70) => ({ siteId: ids.site, gatewayId: ids.gateway, commandId: ids.original,
  dispatchId: ids.dispatch, idempotencyKey: ids.key, sequence: 11, eventId: randomUUID(),
  status: "succeeded" as const, occurredAt: "2026-09-25T12:00:00.000Z",
  results: [{ fixtureId: ids.fixture, status: "succeeded" as const, brightness }] });
const wire = digest.sign("late-set-wire", [ids.site, ids.gateway, ids.original, ids.dispatch, ids.key, "11"]);

function harness() {
  const receipt = { id: randomUUID(), holdId: ids.hold, originalDispatchId: ids.dispatch,
    keyVersion: wire.keyVersion, wireDigest: wire.value, targetFixtureIds: [ids.fixture] };
  const hold = { id: ids.hold, siteId: ids.site, gatewayId: ids.gateway,
    originalCommandId: ids.original, targets: [{ fixtureId: ids.fixture, expectedBrightness: 70 }] };
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: receipt.id, holdId: ids.hold }]),
    lateSetReceipt: { findUnique: jest.fn().mockResolvedValue(receipt),
      findMany: jest.fn().mockResolvedValue([receipt]) },
    lateSetTerminalFence: { findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}) },
    unresolvedCommandHold: { findUnique: jest.fn().mockResolvedValue(hold),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    resolvedCommandRecovery: { create: jest.fn().mockResolvedValue({}) }
  };
  const prisma: any = { lateSetReceipt: { findUnique: jest.fn().mockResolvedValue(receipt) },
    lateSetTerminalFence: { findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0) },
    $transaction: jest.fn(async (work: (client: any) => Promise<unknown>) => work(tx)) };
  const snapshot = { lockMutation: jest.fn().mockResolvedValue(undefined) };
  const service = new (CommandLateSetAckService as any)(prisma, snapshot, digest);
  return { service, tx, prisma, receipt, hold };
}

describe("CommandLateSetAckService post-purge original Set ACK", () => {
  afterEach(() => { delete process.env.COMMAND_LATE_SET_TERMINAL_FENCE_ENABLED; });
  it("validates full old wire HMAC and exact target before releasing hold on observed brightness", async () => {
    const { service, tx } = harness();
    await expect(service.tryStoreDeviceStatusAck(ack())).resolves.toBe(true);
    expect(tx.resolvedCommandRecovery.create).toHaveBeenCalledWith({ data: {
      id: ids.hold, siteId: ids.site, classification: "verified_applied", targetCount: 1
    } });
    expect(tx.unresolvedCommandHold.deleteMany).toHaveBeenCalledWith({ where: { id: ids.hold, siteId: ids.site } });
  });

  it("consumes a receipt-owned wrong key/sequence/site or fixture without falling through to legacy", async () => {
    const { service, tx } = harness();
    for (const packet of [{ ...ack(), idempotencyKey: randomUUID() }, { ...ack(), sequence: 12 },
      { ...ack(), siteId: randomUUID() }, { ...ack(), results: [{ fixtureId: randomUUID(), status: "succeeded" as const, brightness: 70 }] }]) {
      await expect(service.tryStoreDeviceStatusAck(packet)).resolves.toBe(true);
    }
    expect(tx.resolvedCommandRecovery.create).not.toHaveBeenCalled();
    expect(tx.unresolvedCommandHold.deleteMany).not.toHaveBeenCalled();
  });

  it("keeps hold when the late Set result is timed out or lacks observed brightness", async () => {
    const { service, tx } = harness();
    await service.tryStoreDeviceStatusAck({ ...ack(), status: "timed_out",
      results: [{ fixtureId: ids.fixture, status: "timed_out" }] });
    await service.tryStoreDeviceStatusAck({ ...ack(), results: [{ fixtureId: ids.fixture, status: "succeeded" }] });
    expect(tx.resolvedCommandRecovery.create).not.toHaveBeenCalled();
    expect(tx.unresolvedCommandHold.deleteMany).not.toHaveBeenCalled();
  });

  it("stages a keyed terminal owner in the same transaction before deleting a resolved hold", async () => {
    process.env.COMMAND_LATE_SET_TERMINAL_FENCE_ENABLED = "1";
    const { service, tx } = harness();
    await expect(service.tryStoreDeviceStatusAck(ack())).resolves.toBe(true);
    expect(tx.lateSetTerminalFence.create).toHaveBeenCalledWith({ data: {
      siteId: ids.site, dispatchDigest: digest.sign("late-set-dispatch", [ids.dispatch]).value,
      keyVersion: 1
    } });
    expect(tx.lateSetTerminalFence.create.mock.invocationCallOrder[0])
      .toBeLessThan(tx.unresolvedCommandHold.deleteMany.mock.invocationCallOrder[0]);
  });

  it("keeps the hold when the old receipt key is absent from the active keyring", async () => {
    process.env.COMMAND_LATE_SET_TERMINAL_FENCE_ENABLED = "1";
    const { tx, prisma } = harness();
    const missing = new CommandSafetyDigest({ activeVersion: 2,
      keys: { 2: Buffer.alloc(32, 0x77).toString("base64url") } });
    const service = new (CommandLateSetAckService as any)(prisma,
      { lockMutation: jest.fn().mockResolvedValue(undefined) }, missing);
    await expect(service.tryStoreDeviceStatusAck(ack())).rejects.toThrow("command safety HMAC key unavailable");
    expect(tx.unresolvedCommandHold.deleteMany).not.toHaveBeenCalled();
  });

  it("leaves an absent receipt to the legacy Command handler", async () => {
    const { service, prisma } = harness();
    prisma.lateSetReceipt.findUnique.mockResolvedValue(null);
    await expect(service.tryStoreDeviceStatusAck(ack())).resolves.toBe(false);
  });

  it("consumes terminal-owned duplicate and malformed ACKs without recreating the hold", async () => {
    const { service, prisma, tx } = harness();
    process.env.COMMAND_LATE_SET_TERMINAL_FENCE_ENABLED = "1";
    prisma.lateSetReceipt.findUnique.mockResolvedValue(null);
    prisma.lateSetTerminalFence.findFirst.mockResolvedValue({ id: randomUUID() });
    await expect(service.tryStoreDeviceStatusAck(ack())).resolves.toBe(true);
    await expect(service.tryStoreDeviceStatusAck({ ...ack(), idempotencyKey: randomUUID(),
      results: [{ fixtureId: randomUUID(), status: "succeeded", brightness: 10 }] })).resolves.toBe(true);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.unresolvedCommandHold.deleteMany).not.toHaveBeenCalled();
  });

  it("does not silently fall through if a terminal tombstone references a retired HMAC key", async () => {
    process.env.COMMAND_LATE_SET_TERMINAL_FENCE_ENABLED = "1";
    const { service, prisma, tx } = harness();
    prisma.lateSetReceipt.findUnique.mockResolvedValue(null);
    prisma.lateSetTerminalFence.count.mockResolvedValue(1);
    await expect(service.tryStoreDeviceStatusAck(ack()))
      .rejects.toThrow("command safety HMAC key unavailable");
    expect(prisma.lateSetTerminalFence.findFirst).not.toHaveBeenCalled();
    expect(tx.unresolvedCommandHold.deleteMany).not.toHaveBeenCalled();
  });
});
