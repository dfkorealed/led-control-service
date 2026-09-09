import { ForbiddenException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { FixtureIdentifyService } from "./fixture-identify.service";
import type { FixtureIdentifyCommand } from "@led-control/shared";
import { hashEditorLeaseToken } from "../floor-editor/editor-lease-token";

const user = { id: randomUUID(), name: "Admin", role: "admin", status: "active", organizationType: "customer", organizationId: randomUUID() } as const;
const floorId = randomUUID(), fixtureId = randomUUID(), siteId = randomUUID(), gatewayId = randomUUID(), token = randomUUID();
function setup() {
  const cache = new Map<string, string>();
  const redis = {
    get: jest.fn(async (key: string) => cache.get(key) ?? null),
    set: jest.fn(async (key: string, value: string, ...args: unknown[]) => {
      if (args.includes("NX") && cache.has(key)) return null;
      cache.set(key, value); return "OK";
    }),
    eval: jest.fn(async (_script: string, _n: number, key: string, value: string) => {
      if (cache.get(key) === value) { cache.delete(key); return 1; } return 0;
    })
  };
  const floor = { id: floorId, siteId, editorLeaseHolderId: user.id, editorLeaseTokenHash: hashEditorLeaseToken(token),
    editorLeaseFence: 2, editorLeaseExpiresAt: new Date(Date.now() + 60_000) };
  const fixture = { id: fixtureId, siteId, floorId, gatewayId, status: "online", statusReason: null, lastSeenAt: new Date(),
    meshNode: { gateway: { id: gatewayId, siteId, lastHeartbeatAt: new Date(), claimedAt: new Date(),
      inventory: { id: "inventory", claimedGatewayId: gatewayId, claimedAt: new Date(), disabledAt: null }, certificates: [{ inventoryId: "inventory" }] } } };
  const tx = { floor: { findUnique: jest.fn(async () => floor) }, fixture: { findFirst: jest.fn(async () => fixture) },
    $queryRaw: jest.fn(async () => [{ ...floor, dbNow: new Date() }]) };
  const prisma = { ...tx, $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(tx)) };
  const access = { assertManageInTransaction: jest.fn(async () => ({ id: siteId, organizationId: user.organizationId })) };
  const audit = { record: jest.fn(async () => {}) };
  const mqtt = { onFixtureIdentifyResult: jest.fn(() => jest.fn()), publishTopic: jest.fn(async () => {}) };
  const service = new FixtureIdentifyService(prisma as never, access as never, audit as never, { getClient: () => redis } as never, mqtt as never);
  const request = (patch = {}) => service.identify(floorId, fixtureId, user as never, { action: "start", leaseToken: token, leaseFence: 2, ...patch });
  return { service, request, mqtt, access, floor, fixture, audit, redis, cache, tx };
}
afterEach(() => jest.useRealTimers());
it("authorizes before publishing and rejects wrong, expired, or stale DB lease", async () => {
  const h = setup();
  h.access.assertManageInTransaction.mockRejectedValueOnce(new ForbiddenException());
  await expect(h.request()).rejects.toThrow();
  await expect(h.request({ leaseToken: randomUUID() })).rejects.toThrow("lease");
  await expect(h.request({ leaseFence: 1 })).rejects.toThrow("lease");
  h.floor.editorLeaseExpiresAt = new Date(Date.now() - 1);
  await expect(h.request()).rejects.toThrow("lease");
  expect(h.mqtt.publishTopic).not.toHaveBeenCalled();
});
it("rejects offline or unregistered fixtures without MQTT", async () => {
  const h = setup();
  h.fixture.meshNode.gateway.lastHeartbeatAt = new Date(0);
  await expect(h.request()).rejects.toThrow("gateway_offline");
  expect(h.mqtt.publishTopic).not.toHaveBeenCalled();
});
it("rejects unregistered, wrong-floor, and inactive-certificate targets", async () => {
  const h = setup();
  h.tx.fixture.findFirst.mockResolvedValueOnce(null as never);
  await expect(h.request()).rejects.toThrow("fixture not found");
  expect(h.tx.fixture.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: fixtureId, floorId, siteId } }));
  h.fixture.meshNode.gateway.certificates = [{ inventoryId: "different-inventory" }];
  await expect(h.request()).rejects.toThrow("fixture_not_registered");
  h.fixture.meshNode.gateway.certificates = [];
  await expect(h.request()).rejects.toThrow("fixture_not_registered");
  expect(h.mqtt.publishTopic).not.toHaveBeenCalled();
});
it("ignores altered and late result envelopes even when commandId matches", async () => {
  jest.useFakeTimers();
  const h = setup();
  h.mqtt.publishTopic.mockImplementation(async (_topic?: string, payload?: unknown) => {
    const command = payload as FixtureIdentifyCommand;
    await h.service.receiveResult({ ...command, fixtureId: randomUUID(), status: "attention_confirmed", reportedAt: new Date().toISOString(), attentionSeconds: 9 });
    await h.service.receiveResult({ ...command, status: "attention_confirmed", reportedAt: command.expiresAt, attentionSeconds: 9 });
  });
  const pending = h.request();
  await jest.advanceTimersByTimeAsync(4000);
  await expect(pending).resolves.toMatchObject({ status: "timed_out" });
});
it("keeps dispatch failure physically uncertain and cleans up result registration", async () => {
  const h = setup();
  h.service.onModuleInit();
  const cleanup = h.mqtt.onFixtureIdentifyResult.mock.results[0]!.value;
  h.mqtt.publishTopic.mockRejectedValueOnce(new Error("connection_closed"));
  await expect(h.request()).resolves.toMatchObject({ status: "dispatch_failed", dispatchStatus: "unconfirmed", reason: "broker_dispatch_unconfirmed" });
  h.service.onModuleDestroy();
  expect(cleanup).toHaveBeenCalledTimes(1);
});
it("returns a timeout after broker dispatch, never fake Attention success", async () => {
  jest.useFakeTimers();
  const h = setup();
  const promise = h.request();
  await jest.advanceTimersByTimeAsync(4000);
  await expect(promise).resolves.toMatchObject({ status: "timed_out", dispatchStatus: "broker_accepted", reason: "attention_result_timeout" });
  expect(h.audit.record).toHaveBeenCalledWith(expect.objectContaining({ actorId: user.id, action: "fixture.identify.start" }));
});
it("requires exact command identity and preserves a newer active session from a stale stop", async () => {
  const h = setup();
  h.mqtt.publishTopic.mockImplementation(async (_topic?: string, payload?: unknown) => {
    const command = payload as FixtureIdentifyCommand;
    await h.service.receiveResult({ ...command, status: "attention_confirmed", reportedAt: new Date().toISOString(), attentionSeconds: 9 });
  });
  const first = await h.request();
  expect(first.status).toBe("attention_confirmed");
  await expect(h.request({ action: "stop", sessionId: randomUUID() })).rejects.toThrow("stale_session");
  expect(h.mqtt.publishTopic).toHaveBeenCalledTimes(1);
});
