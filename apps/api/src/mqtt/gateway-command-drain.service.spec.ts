import { randomUUID } from "node:crypto";
import { mqttTopicsV2 } from "@led-control/shared";
import { GatewayCommandDrainService } from "./gateway-command-drain.service";

function fixture() {
  let now = 100;
  const gateway = { siteId: randomUUID(), gatewayId: randomUUID(), gatewayVersion: "certified-1",
    bootId: randomUUID(), online: true, oldSessionRevoked: true, physicallyIsolated: false };
  const inventory = { generation: 7, revision: "deployment-1", complete: true, gateways: [gateway] };
  const certificate = { scope: "disposable" as const, generation: 7, inventoryRevision: "deployment-1",
    certificateId: "HIL-model-only", submitToRfUpperBoundMs: 500,
    gateways: [{ siteId: gateway.siteId, gatewayId: gateway.gatewayId,
      gatewayVersion: gateway.gatewayVersion, bootId: gateway.bootId, physicalRfComplete: true }] };
  let mutate = (_response: any) => {};
  const service = () => new GatewayCommandDrainService({
    activeScopes: async () => [{ siteId: gateway.siteId, gatewayId: gateway.gatewayId }],
    inventory: async () => structuredClone(inventory),
    physicalCertificate: async () => structuredClone(certificate),
    request: async (_topic, request) => {
      const response = { ...request, gatewayVersion: gateway.gatewayVersion, bootId: gateway.bootId,
        queuedCount: 0, submittedCount: 0, unconfirmedCount: 0 };
      mutate(response);
      return { topic: mqttTopicsV2.commandDrainResponse(gateway.siteId, gateway.gatewayId), payload: response };
    }, monotonicNow: () => now
  });
  return { service, inventory, gateway, certificate, setMutate: (fn: typeof mutate) => { mutate = fn; },
    setNow: (value: number) => { now = value; } };
}

describe("Gateway purge census and independent RF certificate", () => {
  it("keeps production unavailable even with complete disposable evidence", async () => {
    const f = fixture();
    expect(await f.service().verify(7)).toMatchObject({ status: "verified", productionPurgeAllowed: false,
      submitToRfUpperBoundMs: 500 });
    expect(await new GatewayCommandDrainService().verify(7)).toMatchObject({ status: "unavailable" });
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
