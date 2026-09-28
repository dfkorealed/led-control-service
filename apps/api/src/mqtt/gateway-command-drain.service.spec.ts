import { createHash, randomUUID } from "node:crypto";
import { mqttTopicsV2 } from "@led-control/shared";
import { GatewayCommandDrainService, type GatewayDrainOptions } from "./gateway-command-drain.service";

function fixture() {
  let now = 100;
  const gateway = { siteId: randomUUID(), gatewayId: randomUUID(), gatewayVersion: "certified-1",
    bootId: randomUUID(), online: true, oldSessionRevoked: true, physicallyIsolated: false };
  const inventory = { generation: 7, revision: "deployment-1", complete: true, gateways: [gateway] };
  const certificate = { scope: "disposable" as const, generation: 7, inventoryRevision: "deployment-1",
    certificateId: "HIL-model-only", submitToRfUpperBoundMs: 500,
    gateways: [{ siteId: gateway.siteId, gatewayId: gateway.gatewayId,
      gatewayVersion: gateway.gatewayVersion, bootId: gateway.bootId, physicalRfComplete: true }] };
  const registry = { scope: "disposable" as const, revision: "certification-1", releases: [{
    gatewayVersion: "certified-1", certificateId: "release-model-only", dbClockProofVersion: 1,
    perSubmitExpiryRecheck: true, conservativeRfDrainVersion: 1 }] };
  let mutate = (_response: any) => {};
  const replies: unknown[] = [];
  const service = (overrides: Partial<GatewayDrainOptions> = {}) => new GatewayCommandDrainService({
    activeScopes: async () => [{ siteId: gateway.siteId, gatewayId: gateway.gatewayId }],
    inventory: async () => structuredClone(inventory),
    physicalCertificate: async () => structuredClone(certificate),
    safetyReleases: async () => structuredClone(registry),
    request: async (_topic, request) => {
      const response = { ...request, gatewayVersion: gateway.gatewayVersion, bootId: gateway.bootId,
        queuedCount: 0, submittedCount: 0, unconfirmedCount: 0 };
      mutate(response);
      replies.push(structuredClone(response));
      return { topic: mqttTopicsV2.commandDrainResponse(gateway.siteId, gateway.gatewayId), payload: response };
    }, monotonicNow: () => now, ...overrides
  });
  return { service, inventory, gateway, certificate, registry, replies, setMutate: (fn: typeof mutate) => { mutate = fn; },
    setNow: (value: number) => { now = value; } };
}

describe("Gateway purge census and independent RF certificate", () => {
  it("keeps production unavailable even with complete disposable evidence", async () => {
    const f = fixture();
    expect(await f.service().verify(7)).toMatchObject({ status: "verified", productionPurgeAllowed: false,
      submitToRfUpperBoundMs: 500 });
    expect(await new GatewayCommandDrainService().verify(7)).toMatchObject({ status: "unavailable" });
  });

  it("rejects a matching legacy version across inventory, HIL and response", async () => {
    const f = fixture();
    f.gateway.gatewayVersion = "legacy-unsupported";
    f.certificate.gateways[0].gatewayVersion = "legacy-unsupported";
    expect(await f.service().verify(7)).toMatchObject({ status: "unavailable",
      reason: "gateway_safety_version_unsupported" });
    f.gateway.online = false;
    f.gateway.physicallyIsolated = true;
    expect(await f.service().verify(7)).toMatchObject({ status: "unavailable",
      reason: "gateway_safety_version_unsupported" });
  });

  it("requires independent release certification even when HIL and counters agree", async () => {
    const f = fixture();
    expect(await f.service({ safetyReleases: undefined }).verify(7)).toMatchObject({ status: "unavailable",
      reason: "gateway_safety_certification_unavailable" });
    f.registry.releases = [];
    expect(await f.service().verify(7)).toMatchObject({ status: "unavailable" });
  });

  it.each(["certificateId", "dbClockProofVersion", "perSubmitExpiryRecheck", "conservativeRfDrainVersion"] as const)(
    "rejects a matching release missing certified %s", async capability => {
      const f = fixture();
      Object.assign(f.registry.releases[0], { [capability]: capability === "certificateId" ? ""
        : capability === "perSubmitExpiryRecheck" ? false : 0 });
      expect(await f.service().verify(7)).toMatchObject({ status: "unavailable",
        reason: "gateway_safety_version_unsupported" });
    });

  it("binds stable independent certification into the evidence digest", async () => {
    const f = fixture();
    f.setMutate(() => { f.registry.revision = "certification-2"; });
    expect(await f.service().verify(7)).toMatchObject({ status: "unavailable",
      reason: "gateway_safety_certification_changed" });
    const original = fixture();
    const evidence = await original.service().verify(7);
    expect(evidence).toMatchObject({ status: "verified", digest: createHash("sha256")
      .update(JSON.stringify({ census: original.inventory, registry: original.registry,
        hil: original.certificate, replies: original.replies })).digest("hex") });
  });

  it.each(["nonce", "siteId", "gatewayId", "bootId", "gatewayVersion", "publishEpoch",
    "queuedCount", "submittedCount", "unconfirmedCount"])("refuses mismatched/nonempty %s", async key => {
    const f = fixture();
    f.setMutate(response => { response[key] = typeof response[key] === "number" ? 1 : randomUUID(); });
    expect(await f.service().verify(7)).toMatchObject({ status: "unavailable" });
  });

  it("does not shrink the deployment census to responding Gateways", async () => {
    const f = fixture();
    f.inventory.gateways = [];
    expect(await f.service().verify(7)).toMatchObject({ status: "unavailable" });
  });

  it("requires both offline session revocation and physical isolation", async () => {
    const f = fixture();
    f.gateway.online = false;
    expect(await f.service().verify(7)).toMatchObject({ status: "unavailable" });
    f.gateway.physicallyIsolated = true;
    f.gateway.oldSessionRevoked = false;
    expect(await f.service().verify(7)).toMatchObject({ status: "unavailable" });
    f.gateway.oldSessionRevoked = true;
    expect(await f.service().verify(7)).toMatchObject({ status: "verified" });
  });

  it("never upgrades zero counters or a reboot into physical RF completion", async () => {
    const f = fixture();
    f.certificate.gateways[0].physicalRfComplete = false;
    expect(await f.service().verify(7)).toMatchObject({ status: "unavailable", reason: "rf_certificate_unavailable" });
    f.certificate.gateways[0].physicalRfComplete = true;
    f.gateway.bootId = randomUUID();
    expect(await f.service().verify(7)).toMatchObject({ status: "unavailable" });
  });

  it("invalidates census or monotonic continuity changes during collection", async () => {
    const f = fixture();
    f.setMutate(() => { f.inventory.revision = "deployment-2"; });
    expect(await f.service().verify(7)).toMatchObject({ status: "unavailable" });
    const other = fixture();
    other.setMutate(() => other.setNow(99));
    expect(await other.service().verify(7)).toMatchObject({ status: "unavailable" });
  });
});
