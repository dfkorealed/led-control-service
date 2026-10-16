import { createHash } from "node:crypto";
import { fixtureRegistrationRemovalBindingIdentity, fixtureRegistrationRemovalCanonicalJson,
  type FixtureRegistrationRemovalCommand, type FixtureRegistrationRemovalTerminal } from "@led-control/shared";

export const removalScope = { siteId: "11111111-1111-4111-8111-111111111111",
  gatewayId: "22222222-2222-4222-8222-222222222222", gatewaySerial: "gateway-test", assignmentVersion: 7 };
export const mappingInput = { fixtureId: "33333333-3333-4333-8333-333333333333",
  nodeId: "44444444-4444-4444-8444-444444444444", deviceUuid: "bio:001122334455", nativeUuid: "001122334455",
  logicalAddress: 0x100, observedLogicalAddressBeforeAssignment: 0x1234,
  commandId: "55555555-5555-4555-8555-555555555555", firmware: "1.2.3.4", protocol: "bio-usb-v1" };
export const removalNow = new Date("2026-10-16T00:00:00.000Z");
export function removalHash(value: unknown) {
  return `sha256:${createHash("sha256").update(fixtureRegistrationRemovalCanonicalJson(value)).digest("hex")}`;
}
export function removalCommand(overrides: Partial<FixtureRegistrationRemovalCommand> = {}): FixtureRegistrationRemovalCommand {
  const command: FixtureRegistrationRemovalCommand = { version: 1,
    operationId: "66666666-6666-4666-8666-666666666666", ...removalScope,
    fixtureId: mappingInput.fixtureId, nodeId: mappingInput.nodeId, deviceUuid: mappingInput.deviceUuid,
    meshAddress: "0x0100", originalProvisionCommandId: mappingInput.commandId, bindingHash: "",
    requestedAt: removalNow.toISOString(), expiresAt: "2026-10-16T00:00:30.000Z", ...overrides };
  command.bindingHash = removalHash(fixtureRegistrationRemovalBindingIdentity(command));
  return command;
}
export function removalAck(terminal: FixtureRegistrationRemovalTerminal) {
  const { requestedAt: _requestedAt, expiresAt: _expiresAt, status: _status, errorCode: _errorCode,
    occurredAt: _occurredAt, ...identity } = terminal;
  return { ...identity, resultHash: removalHash(terminal), ingestedAt: removalNow.toISOString(), status: "ingested" as const };
}
