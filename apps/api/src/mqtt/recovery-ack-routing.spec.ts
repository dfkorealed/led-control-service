import { randomUUID } from "node:crypto";
import { MqttService } from "./mqtt.service";

const siteId = randomUUID();
const gatewayId = randomUUID();
const identity = { siteId, gatewayId, commandId: randomUUID(), dispatchId: randomUUID(),
  idempotencyKey: randomUUID(), sequence: 8 };

describe("MQTT Get-only recovery ACK routing", () => {
  it("consumes purged legacy Get acceptance and result ACKs without falling through to Command", async () => {
    const prisma: any = { commandDispatch: { updateMany: jest.fn() },
      $transaction: jest.fn(() => { throw new Error("purged legacy Get must not join Command"); }) };
    const recoveryAcks = { tryStoreAcceptanceAck: jest.fn().mockResolvedValue(false),
      tryStoreDeviceStatusAck: jest.fn().mockResolvedValue(false) };
    const lateSetAcks = { tryStoreDeviceStatusAck: jest.fn().mockResolvedValue(false) };
    const legacyGetAcks = { tryStoreAcceptanceAck: jest.fn().mockResolvedValue(true),
      tryStoreDeviceStatusAck: jest.fn().mockResolvedValue(true) };
    const mqtt = new (MqttService as any)(prisma, {} as never, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, recoveryAcks, lateSetAcks, legacyGetAcks);
    const acceptance = { ...identity, eventId: randomUUID(), status: "accepted",
      acceptedAt: "2026-09-25T12:00:00.000Z" };
    const status = { ...identity, eventId: randomUUID(), status: "succeeded",
      occurredAt: "2026-09-25T12:00:01.000Z",
      results: [{ fixtureId: randomUUID(), status: "succeeded", brightness: 70 }] };
    await mqtt.handleMessage(`sites/${siteId}/gateways/${gatewayId}/acks/acceptance`,
      Buffer.from(JSON.stringify(acceptance)));
    await mqtt.handleMessage(`sites/${siteId}/gateways/${gatewayId}/acks/device-status`,
      Buffer.from(JSON.stringify(status)));
    expect(legacyGetAcks.tryStoreAcceptanceAck).toHaveBeenCalledWith(acceptance);
    expect(legacyGetAcks.tryStoreDeviceStatusAck).toHaveBeenCalledWith(status);
    expect(prisma.commandDispatch.updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it("routes exact recovery acceptance and device ACKs before legacy Command joins", async () => {
    const prisma: any = { commandDispatch: { updateMany: jest.fn() },
      $transaction: jest.fn(() => { throw new Error("legacy Command path must not run"); }) };
    const recoveryAcks = { tryStoreAcceptanceAck: jest.fn().mockResolvedValue(true),
      tryStoreDeviceStatusAck: jest.fn().mockResolvedValue(true) };
    const mqtt = new MqttService(prisma, {} as never, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, recoveryAcks as never);
    const acceptance = { ...identity, eventId: randomUUID(), status: "accepted",
      acceptedAt: "2026-09-25T12:00:00.000Z" };
    const status = { ...identity, eventId: randomUUID(), status: "succeeded",
      occurredAt: "2026-09-25T12:00:01.000Z", results: [{ fixtureId: randomUUID(), status: "succeeded", brightness: 70 }] };
    await mqtt.handleMessage(`sites/${siteId}/gateways/${gatewayId}/acks/acceptance`, Buffer.from(JSON.stringify(acceptance)));
    await mqtt.handleMessage(`sites/${siteId}/gateways/${gatewayId}/acks/device-status`, Buffer.from(JSON.stringify(status)));
    expect(recoveryAcks.tryStoreAcceptanceAck).toHaveBeenCalledWith(acceptance);
    expect(recoveryAcks.tryStoreDeviceStatusAck).toHaveBeenCalledWith(status);
    expect(prisma.commandDispatch.updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("retains legacy Command ACK handling when no recovery dispatch owns the ID", async () => {
    const prisma: any = { commandDispatch: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      $executeRaw: jest.fn(), $queryRaw: jest.fn().mockResolvedValue([{ contentRedactedAt: null }]) };
    prisma.$transaction = jest.fn(async (callback) => callback(prisma));
    const recoveryAcks = { tryStoreAcceptanceAck: jest.fn().mockResolvedValue(false),
      tryStoreDeviceStatusAck: jest.fn().mockResolvedValue(false) };
    const lateSetAcks = { tryStoreDeviceStatusAck: jest.fn().mockResolvedValue(false) };
    const mqtt = new MqttService(prisma, {} as never, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, recoveryAcks as never, lateSetAcks as never);
    const acceptance = { ...identity, eventId: randomUUID(), status: "accepted",
      acceptedAt: "2026-09-25T12:00:00.000Z" };
    await mqtt.handleMessage(`sites/${siteId}/gateways/${gatewayId}/acks/acceptance`, Buffer.from(JSON.stringify(acceptance)));
    expect(recoveryAcks.tryStoreAcceptanceAck).toHaveBeenCalledWith(acceptance);
    expect(prisma.commandDispatch.updateMany).toHaveBeenCalledTimes(1);
    expect(lateSetAcks.tryStoreDeviceStatusAck).not.toHaveBeenCalled();
  });

  it("consumes a receipt-owned late Set ACK before the legacy Command join, including malformed receipts", async () => {
    const prisma: any = { $transaction: jest.fn(() => { throw new Error("legacy Command path must not run"); }) };
    const recoveryAcks = { tryStoreAcceptanceAck: jest.fn().mockResolvedValue(false),
      tryStoreDeviceStatusAck: jest.fn().mockResolvedValue(false) };
    const lateSetAcks = { tryStoreDeviceStatusAck: jest.fn().mockResolvedValue(true) };
    const mqtt = new MqttService(prisma, {} as never, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, recoveryAcks as never, lateSetAcks as never);
    const packet = { ...identity, eventId: randomUUID(), status: "succeeded",
      occurredAt: "2026-09-25T12:00:00.000Z",
      results: [{ fixtureId: randomUUID(), status: "succeeded", brightness: 70 }] };
    await mqtt.handleMessage(`sites/${siteId}/gateways/${gatewayId}/acks/device-status`, Buffer.from(JSON.stringify(packet)));
    expect(lateSetAcks.tryStoreDeviceStatusAck).toHaveBeenCalledWith(packet);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("lets a device ACK with no late receipt reach the live legacy Command path", async () => {
    const prisma: any = { $transaction: jest.fn(async (work: (tx: any) => Promise<unknown>) => work({
      $executeRaw: jest.fn(),
      $queryRaw: jest.fn().mockResolvedValue([]),
      processedGatewayEvent: { findUnique: jest.fn() }
    })) };
    const recoveryAcks = { tryStoreAcceptanceAck: jest.fn().mockResolvedValue(false),
      tryStoreDeviceStatusAck: jest.fn().mockResolvedValue(false) };
    const lateSetAcks = { tryStoreDeviceStatusAck: jest.fn().mockResolvedValue(false) };
    const mqtt = new MqttService(prisma, {} as never, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, recoveryAcks as never, lateSetAcks as never);
    const packet = { ...identity, eventId: randomUUID(), status: "succeeded",
      occurredAt: "2026-09-25T12:00:00.000Z",
      results: [{ fixtureId: randomUUID(), status: "succeeded", brightness: 70 }] };
    await mqtt.handleMessage(`sites/${siteId}/gateways/${gatewayId}/acks/device-status`, Buffer.from(JSON.stringify(packet)));
    expect(lateSetAcks.tryStoreDeviceStatusAck).toHaveBeenCalledWith(packet);
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it("consumes a recovery-owned but wrong-key ACK without falling through to legacy", async () => {
    const prisma: any = { commandDispatch: { updateMany: jest.fn() },
      $transaction: jest.fn(() => { throw new Error("legacy Command path must not run"); }) };
    const recoveryAcks = { tryStoreAcceptanceAck: jest.fn().mockResolvedValue(true),
      tryStoreDeviceStatusAck: jest.fn().mockResolvedValue(true) };
    const mqtt = new MqttService(prisma, {} as never, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, recoveryAcks as never);
    const forged = { ...identity, idempotencyKey: randomUUID(), eventId: randomUUID(), status: "accepted",
      acceptedAt: "2026-09-25T12:00:00.000Z" };
    await mqtt.handleMessage(`sites/${siteId}/gateways/${gatewayId}/acks/acceptance`, Buffer.from(JSON.stringify(forged)));
    expect(recoveryAcks.tryStoreAcceptanceAck).toHaveBeenCalledWith(forged);
    expect(prisma.commandDispatch.updateMany).not.toHaveBeenCalled();
  });
});
