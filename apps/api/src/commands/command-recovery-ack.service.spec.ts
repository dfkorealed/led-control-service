import { randomUUID } from "node:crypto";
import { CommandRecoveryAckService } from "./command-recovery-ack.service";
import { CommandSafetyDigest } from "./command-safety-digest";

const ids = { site: randomUUID(), gateway: randomUUID(), original: randomUUID(), hold: randomUUID(),
  first: randomUUID(), second: randomUUID(), fixture1: randomUUID(), fixture2: randomUUID(),
  key1: randomUUID(), key2: randomUUID() };

function harness() {
  const digest = new CommandSafetyDigest({ activeVersion: 1,
    keys: { 1: Buffer.alloc(32, 0x66).toString("base64url") } });
  const dispatches: any[] = [
    { id: ids.first, holdId: ids.hold, gatewayId: ids.gateway, idempotencyKey: ids.key1,
      sequence: 11n, verificationAttempt: 1, chunkIndex: 0, status: "accepted",
      targets: [{ fixtureId: ids.fixture1, status: "pending", brightness: null }] },
    { id: ids.second, holdId: ids.hold, gatewayId: ids.gateway, idempotencyKey: ids.key2,
      sequence: 12n, verificationAttempt: 1, chunkIndex: 1, status: "accepted",
      targets: [{ fixtureId: ids.fixture2, status: "pending", brightness: null }] }
  ];
  const tx: any = {
    $queryRaw: jest.fn(async () => [{ id: ids.first, holdId: ids.hold }]),
    recoveryDispatch: {
      findUnique: jest.fn(async ({ where }: any) => dispatches.find((row) => row.id === where.id) ?? null),
      findMany: jest.fn(async ({ where }: any) => dispatches.filter((row) => row.holdId === where.holdId
        && row.verificationAttempt === where.verificationAttempt)),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const row = dispatches.find((item) => item.id === where.id &&
          (typeof where.status === "string" ? item.status === where.status : where.status?.in?.includes(item.status)));
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      })
    },
    recoveryDispatchTarget: { updateMany: jest.fn(async ({ where, data }: any) => {
      const row = dispatches.find((item) => item.id === where.dispatchId)?.targets
        .find((item: any) => item.fixtureId === where.fixtureId);
      if (!row) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    }) },
    unresolvedCommandHold: { findUnique: jest.fn().mockResolvedValue({ id: ids.hold, siteId: ids.site,
      targets: [{ fixtureId: ids.fixture1, expectedBrightness: 70 },
        { fixtureId: ids.fixture2, expectedBrightness: 70 }] }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    lateSetReceipt: { findMany: jest.fn().mockResolvedValue([{ id: randomUUID(), holdId: ids.hold,
      originalDispatchId: randomUUID(), keyVersion: 1,
      targetFixtureIds: [ids.fixture1, ids.fixture2] }]) },
    lateSetTerminalFence: { findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}) },
    resolvedCommandRecovery: { create: jest.fn().mockResolvedValue({}) }
  };
  const prisma: any = {
    recoveryDispatch: { findUnique: jest.fn(async ({ where }: any) => dispatches.find((row) => row.id === where.id) ?? null) },
    $transaction: jest.fn(async (work: (client: any) => Promise<unknown>) => work(tx))
  };
  const snapshot = { lockMutation: jest.fn().mockResolvedValue(undefined) };
  const service = new (CommandRecoveryAckService as any)(prisma, snapshot, digest);
  const ack = (dispatchId: string, key: string, sequence: number, fixtureId: string, brightness: number) => ({
    siteId: ids.site, gatewayId: ids.gateway, commandId: ids.original, dispatchId,
    idempotencyKey: key, sequence, eventId: randomUUID(), occurredAt: "2026-09-25T12:00:00.000Z",
    status: "succeeded" as const, results: [{ fixtureId, status: "succeeded" as const, brightness }]
  });
  return { service, tx, prisma, dispatches, ack };
}

describe("CommandRecoveryAckService Get-only exact ACK", () => {
  afterEach(() => { delete process.env.COMMAND_LATE_SET_TERMINAL_FENCE_ENABLED; });
  it("records server receipt separately from a future Gateway acceptance timestamp", async () => {
    const { service, tx, dispatches } = harness();
    dispatches[0].status = "published";
    await service.tryStoreAcceptanceAck({ siteId: ids.site, gatewayId: ids.gateway,
      commandId: ids.original, dispatchId: ids.first, idempotencyKey: ids.key1, sequence: 11,
      status: "accepted", acceptedAt: "2031-01-01T00:00:00.000Z" });
    expect(tx.recoveryDispatch.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "accepted", acceptedAt: new Date("2031-01-01T00:00:00.000Z"),
        acceptedReceivedAt: expect.any(Date) })
    }));
    expect(dispatches[0].acceptedReceivedAt.getFullYear()).not.toBe(2031);
  });
  it("does not resolve from the first successful chunk; resolves after all exact observed results", async () => {
    const { service, tx, ack } = harness();
    await expect(service.tryStoreDeviceStatusAck(ack(ids.first, ids.key1, 11, ids.fixture1, 70))).resolves.toBe(true);
    expect(tx.unresolvedCommandHold.deleteMany).not.toHaveBeenCalled();
    await expect(service.tryStoreDeviceStatusAck(ack(ids.second, ids.key2, 12, ids.fixture2, 20))).resolves.toBe(true);
    expect(tx.resolvedCommandRecovery.create).toHaveBeenCalledWith({ data: {
      id: ids.hold, siteId: ids.site, classification: "verified_partial", targetCount: 2
    } });
    expect(tx.unresolvedCommandHold.deleteMany).toHaveBeenCalledTimes(1);
  });

  it("does not delete a verified hold until its original Set ACK has keyed terminal ownership", async () => {
    process.env.COMMAND_LATE_SET_TERMINAL_FENCE_ENABLED = "1";
    const { service, tx, ack } = harness();
    await service.tryStoreDeviceStatusAck(ack(ids.first, ids.key1, 11, ids.fixture1, 70));
    await service.tryStoreDeviceStatusAck(ack(ids.second, ids.key2, 12, ids.fixture2, 70));
    expect(tx.lateSetTerminalFence.create).toHaveBeenCalledTimes(1);
    expect(tx.lateSetTerminalFence.create.mock.invocationCallOrder[0])
      .toBeLessThan(tx.unresolvedCommandHold.deleteMany.mock.invocationCallOrder[0]);
  });

  it("fails closed when a resolved Get has no staged old Set receipt", async () => {
    process.env.COMMAND_LATE_SET_TERMINAL_FENCE_ENABLED = "1";
    const { service, tx, ack } = harness();
    tx.lateSetReceipt.findMany.mockResolvedValue([]);
    await service.tryStoreDeviceStatusAck(ack(ids.first, ids.key1, 11, ids.fixture1, 70));
    await expect(service.tryStoreDeviceStatusAck(ack(ids.second, ids.key2, 12, ids.fixture2, 70)))
      .rejects.toMatchObject({ response: { code: "late_set_receipt_unverifiable" } });
    expect(tx.unresolvedCommandHold.deleteMany).not.toHaveBeenCalled();
  });

  it("does not mutate or resolve on a cross-site/key/sequence ACK or a wrong target set", async () => {
    const { service, tx, ack } = harness();
    tx.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: ids.first, holdId: ids.hold }]);
    const valid = ack(ids.first, ids.key1, 11, ids.fixture1, 70);
    await expect(service.tryStoreDeviceStatusAck({ ...valid, siteId: randomUUID() })).resolves.toBe(true);
    await expect(service.tryStoreDeviceStatusAck({ ...valid, idempotencyKey: randomUUID() })).resolves.toBe(true);
    await expect(service.tryStoreDeviceStatusAck({ ...valid, sequence: 99 })).resolves.toBe(true);
    await expect(service.tryStoreDeviceStatusAck({ ...valid, results: [{ fixtureId: randomUUID(), status: "succeeded", brightness: 70 }] }))
      .resolves.toBe(true);
    expect(tx.unresolvedCommandHold.deleteMany).not.toHaveBeenCalled();
    expect(tx.resolvedCommandRecovery.create).not.toHaveBeenCalled();
  });

  it("keeps hold after timeout even if the other chunk has a successful observation", async () => {
    const { service, tx, ack } = harness();
    await service.tryStoreDeviceStatusAck(ack(ids.first, ids.key1, 11, ids.fixture1, 70));
    await service.tryStoreDeviceStatusAck({ ...ack(ids.second, ids.key2, 12, ids.fixture2, 0),
      status: "timed_out", results: [{ fixtureId: ids.fixture2, status: "timed_out" }] });
    expect(tx.unresolvedCommandHold.deleteMany).not.toHaveBeenCalled();
    expect(tx.unresolvedCommandHold.updateMany).toHaveBeenCalled();
  });

  it("ignores duplicate terminal ACK and leaves legacy dispatch IDs to the old handler", async () => {
    const { service, tx, ack } = harness();
    const packet = ack(ids.first, ids.key1, 11, ids.fixture1, 70);
    await service.tryStoreDeviceStatusAck(packet);
    await service.tryStoreDeviceStatusAck(packet);
    expect(tx.recoveryDispatchTarget.updateMany).toHaveBeenCalledTimes(1);
    await expect(service.tryStoreDeviceStatusAck({ ...packet, dispatchId: randomUUID() })).resolves.toBe(false);
  });
});
