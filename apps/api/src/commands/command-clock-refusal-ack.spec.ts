import { randomUUID } from "node:crypto";
import { CommandLateSetAckService } from "./command-late-set-ack.service";
import { CommandRecoveryAckService } from "./command-recovery-ack.service";
import { CommandSafetyDigest } from "./command-safety-digest";

const ids = { site: randomUUID(), gateway: randomUUID(), command: randomUUID(), setDispatch: randomUUID(),
  getDispatch: randomUUID(), hold: randomUUID(), fixture: randomUUID(), setKey: randomUUID(), getKey: randomUUID() };
const digest = new CommandSafetyDigest({ activeVersion: 1,
  keys: { 1: Buffer.alloc(32, 0x66).toString("base64url") } });
const clockMessage = "gateway command clock or epoch proof is unavailable";

describe("clock refusal ACK attribution after original Command deletion", () => {
  it("keeps an RF-uncertain late Set result in its exact hold for status-check", async () => {
    const signed = digest.sign("late-set-wire", [ids.site, ids.gateway, ids.command,
      ids.setDispatch, ids.setKey, "11"]);
    const receipt = { id: randomUUID(), holdId: ids.hold, originalDispatchId: ids.setDispatch,
      keyVersion: signed.keyVersion, wireDigest: signed.value, targetFixtureIds: [ids.fixture] };
    const hold = { id: ids.hold, siteId: ids.site, gatewayId: ids.gateway,
      originalCommandId: ids.command, targets: [{ fixtureId: ids.fixture, expectedBrightness: 70 }] };
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: receipt.id, holdId: ids.hold }]),
      lateSetReceipt: { findUnique: jest.fn().mockResolvedValue(receipt) },
      unresolvedCommandHold: { findUnique: jest.fn().mockResolvedValue(hold),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }), deleteMany: jest.fn() },
      resolvedCommandRecovery: { create: jest.fn() }
    };
    const prisma: any = { lateSetReceipt: { findUnique: jest.fn().mockResolvedValue(receipt) },
      $transaction: jest.fn(async (work: (client: any) => Promise<unknown>) => work(tx)) };
    const service = new CommandLateSetAckService(prisma, { lockMutation: jest.fn() } as never, digest);
    const ack = { siteId: ids.site, gatewayId: ids.gateway, commandId: ids.command,
      dispatchId: ids.setDispatch, idempotencyKey: ids.setKey, sequence: 11, eventId: randomUUID(),
      status: "failed" as const, occurredAt: "2026-09-25T12:00:00.000Z",
      results: [{ fixtureId: ids.fixture, status: "failed" as const, errorMessage: clockMessage }] };

    await expect(service.tryStoreDeviceStatusAck(ack)).resolves.toBe(true);
    expect(tx.unresolvedCommandHold.updateMany).toHaveBeenCalledWith({
      where: { id: ids.hold }, data: { lastCheckedAt: expect.any(Date) }
    });
    expect(tx.resolvedCommandRecovery.create).not.toHaveBeenCalled();
    expect(tx.unresolvedCommandHold.deleteMany).not.toHaveBeenCalled();
  });

  it("keeps a recovery Get rejection in the hold without retrying the old Set", async () => {
    const dispatch = { id: ids.getDispatch, holdId: ids.hold, gatewayId: ids.gateway,
      idempotencyKey: ids.getKey, sequence: 12n, verificationAttempt: 1,
      status: "accepted", targets: [{ fixtureId: ids.fixture, status: "pending", brightness: null }] };
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: ids.getDispatch, holdId: ids.hold }]),
      recoveryDispatch: { findUnique: jest.fn().mockResolvedValue(dispatch),
        updateMany: jest.fn(async ({ data }: any) => { Object.assign(dispatch, data); return { count: 1 }; }),
        findMany: jest.fn().mockResolvedValue([dispatch]) },
      unresolvedCommandHold: { findUnique: jest.fn().mockResolvedValue({ id: ids.hold, siteId: ids.site,
        targets: [{ fixtureId: ids.fixture, expectedBrightness: 70 }] }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }), deleteMany: jest.fn() },
      resolvedCommandRecovery: { create: jest.fn() },
      mqttOutbox: { create: jest.fn() }
    };
    const prisma: any = { recoveryDispatch: { findUnique: jest.fn().mockResolvedValue({ id: ids.getDispatch }) },
      $transaction: jest.fn(async (work: (client: any) => Promise<unknown>) => work(tx)) };
    const service = new CommandRecoveryAckService(prisma, { lockMutation: jest.fn() } as never, digest);
    const ack = { siteId: ids.site, gatewayId: ids.gateway, commandId: ids.command,
      dispatchId: ids.getDispatch, idempotencyKey: ids.getKey, sequence: 12,
      eventId: randomUUID(), status: "rejected" as const, acceptedAt: "2026-09-25T12:00:00.000Z",
      errorCode: "GATEWAY_CLOCK_UNTRUSTED" };

    await expect(service.tryStoreAcceptanceAck(ack)).resolves.toBe(true);
    expect(dispatch).toMatchObject({ status: "failed", errorCode: "GATEWAY_CLOCK_UNTRUSTED" });
    expect(tx.unresolvedCommandHold.updateMany).toHaveBeenCalledWith({
      where: { id: ids.hold }, data: { lastCheckedAt: expect.any(Date) }
    });
    expect(tx.resolvedCommandRecovery.create).not.toHaveBeenCalled();
    expect(tx.unresolvedCommandHold.deleteMany).not.toHaveBeenCalled();
    expect(tx.mqttOutbox.create).not.toHaveBeenCalled();
  });
});
