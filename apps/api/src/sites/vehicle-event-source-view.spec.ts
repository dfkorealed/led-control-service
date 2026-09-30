import { vehicleEventSourceView } from "./vehicle-event-source-view";

const now = new Date("2026-10-01T00:00:00.000Z");
const fixture = {
  id: "fixture-a", siteId: "site", gatewayId: "gateway", meshNodeId: "node",
  meshNode: { id: "node", gatewayId: "gateway", deviceUuid: "bio:1", meshAddress: "0001",
    vehicleSensorProtocol: "bio_usb_pulse", bioPulseReadiness: "ready", vehicleSensorCapabilityStatus: "unknown",
    vehicleSensorCapabilityVerifiedAt: null, gateway: { id: "gateway", assignmentVersion: 1 } },
  sensorModeOperations: [], vehicleEventSources: []
};

describe("vehicle event source read model", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const verifiedFixture = {
    ...fixture, id, siteId: id, gatewayId: id, meshNodeId: id,
    meshNode: { ...fixture.meshNode, id, gatewayId: id, gateway: { id, assignmentVersion: 1 } },
    sensorModeOperations: [{ commandId: id, siteId: id, fixtureId: id, gatewayId: id, nodeId: id, assignmentVersion: 1,
      status: "verified", supersededAt: null, requestedAt: new Date("2026-09-30T23:59:40Z"), expiresAt: now,
      result: { version: 2, commandId: id, siteId: id, fixtureId: id, gatewayId: id, nodeId: id, assignmentVersion: 1,
        deviceIdentityHash: "e53acdffe5446f636c5ea57feccd4bf674d458c50a1ef02a6f6120827c80a520", meshAddress: "0x0001",
        operation: "query", eventId: id, sequence: 1, occurredAt: "2026-09-30T23:59:50.000Z", status: "verified",
        modeVerified: true, observedMode: "sensor", evidence: "mode_get" } }]
  };
  it("exposes a matched GET only as historical mode evidence, never effective readiness", () => {
    expect(vehicleEventSourceView(verifiedFixture, now)).toMatchObject({ readiness: "off", sourceEligible: false,
      modeVerification: { commandId: id, modeVerified: true, verifiedAt: "2026-09-30T23:59:50.000Z" } });
  });
  it.each([{ deviceUuid: "bio:changed" }, { meshAddress: "0002" }, { gateway: { id, assignmentVersion: 2 } }])("does not reuse mode proof after physical or assignment changes: %j", change => {
    expect(vehicleEventSourceView({ ...verifiedFixture, meshNode: { ...verifiedFixture.meshNode, ...change } }, now).modeVerification.modeVerified).toBe(false);
  });
  it("does not revive superseded or expired pending mode operations", () => {
    const row = verifiedFixture.sensorModeOperations[0];
    expect(vehicleEventSourceView({ ...verifiedFixture, sensorModeOperations: [{ ...row, supersededAt: now }] }, now).modeVerification.modeVerified).toBe(false);
    expect(vehicleEventSourceView({ ...verifiedFixture, sensorModeOperations: [{ ...row, status: "pending" }] }, now).modeVerification).toMatchObject({ status: "timed_out", modeVerified: false });
  });
  it.each(["off", "shadow", "ready", "degraded"])("never promotes %s BIO evidence while product gate is OFF", evidence => {
    const result = vehicleEventSourceView({ ...fixture, meshNode: { ...fixture.meshNode, bioPulseReadiness: evidence } }, now);
    expect(result).toMatchObject({ sensorProtocol: "bio-usb-pulse", readiness: "off", capabilityEvidence: evidence,
      sourceEligible: false, targetEligible: true, blockReasons: expect.arrayContaining(["product_gate_off"]),
      modeVerification: { modeVerified: false, verifiedAt: null } });
  });
  it("protects an enabled BIO source without forbidding an ordinary BIO B target", () => {
    expect(vehicleEventSourceView({ ...fixture, vehicleEventSources: [{ rule: { status: "enabled", sensorProtocol: "bio_usb_pulse" } }] }, now).targetEligible).toBe(false);
    expect(vehicleEventSourceView(fixture, now).targetEligible).toBe(true);
  });
  it("keeps existing verified BlueZ sources eligible", () => {
    expect(vehicleEventSourceView({ ...fixture, meshNode: { ...fixture.meshNode, vehicleSensorProtocol: "bluez_stateful",
      vehicleSensorCapabilityStatus: "supported", vehicleSensorCapabilityVerifiedAt: now } }, now)).toMatchObject({
      sensorProtocol: "bluez-stateful", readiness: "ready", sourceEligible: true, blockReasons: []
    });
  });
  it("does not reuse a previous assignment's successful mode operation", () => {
    const result = vehicleEventSourceView({ ...fixture, sensorModeOperations: [{ commandId: "old", siteId: "site", fixtureId: "fixture-a",
      gatewayId: "gateway", nodeId: "node", assignmentVersion: 0, status: "verified", supersededAt: null,
      requestedAt: now, expiresAt: now, result: { modeVerified: true } }] }, now);
    expect(result.modeVerification).toMatchObject({ commandId: null, modeVerified: false, verifiedAt: null });
  });
});
