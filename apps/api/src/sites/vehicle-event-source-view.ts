import { bioSensorModeResultSchema } from "@led-control/shared";
import { createHash } from "node:crypto";

interface SourceFixture {
  id: string; siteId: string; gatewayId: string | null; meshNodeId: string | null;
  meshNode: null | {
    id: string; gatewayId: string; deviceUuid: string | null; meshAddress: string;
    vehicleSensorProtocol: string; bioPulseReadiness: string;
    vehicleSensorCapabilityStatus: string; vehicleSensorCapabilityVerifiedAt: Date | null;
    gateway: { id: string; assignmentVersion: number };
  };
  vehicleEventSources?: Array<{ rule: { status: string; sensorProtocol: string } }>;
  sensorModeOperations?: Array<{
    commandId: string; siteId: string; fixtureId: string; gatewayId: string; nodeId: string; assignmentVersion: number;
    status: string; supersededAt: Date | null; requestedAt: Date; expiresAt: Date; result: unknown;
  }>;
}

type SourceBlockReason = "product_gate_off" | "mode_unverified" | "capability_unverified";

export function vehicleEventSourceView(fixture: SourceFixture, now: Date) {
  const node = fixture.meshNode;
  const bio = node?.vehicleSensorProtocol === "bio_usb_pulse";
  const bluezReady = !bio && node?.vehicleSensorCapabilityStatus === "supported" && Boolean(node.vehicleSensorCapabilityVerifiedAt);
  const modeVerification = modeEvidence(fixture, now);
  const blockReasons: SourceBlockReason[] = bio ? ["product_gate_off", ...(!modeVerification.modeVerified ? ["mode_unverified" as const] : [])]
    : bluezReady ? [] : ["capability_unverified"];
  // Product readiness is intentionally OFF until HIL, profile, independent health
  // and rollout gates are approved. A stored ready report or mode GET cannot lift it.
  return {
    sensorProtocol: bio ? "bio-usb-pulse" as const : "bluez-stateful" as const,
    readiness: bluezReady ? "ready" as const : "off" as const,
    capabilityEvidence: bio ? node.bioPulseReadiness : null,
    sourceEligible: bluezReady,
    targetEligible: !(fixture.vehicleEventSources ?? []).some(({ rule }) => rule.status === "enabled" && rule.sensorProtocol === "bio_usb_pulse"),
    blockReasons,
    modeVerification
  };
}

function modeEvidence(fixture: SourceFixture, now: Date) {
  const empty = { commandId: null, status: "unverified", modeVerified: false, verifiedAt: null };
  const node = fixture.meshNode;
  const row = fixture.sensorModeOperations?.[0];
  if (!node || node.vehicleSensorProtocol !== "bio_usb_pulse" || !row || row.supersededAt
    || row.siteId !== fixture.siteId || row.fixtureId !== fixture.id || row.nodeId !== fixture.meshNodeId
    || row.gatewayId !== fixture.gatewayId || row.gatewayId !== node.gatewayId
    || row.assignmentVersion !== node.gateway.assignmentVersion) return empty;
  const parsed = bioSensorModeResultSchema.safeParse(row.result);
  const result = parsed.success ? parsed.data : null;
  const status = row.status === "pending" && row.expiresAt <= now ? "timed_out" : row.status;
  const matches = result && node.deviceUuid && result.commandId === row.commandId
    && result.fixtureId === fixture.id && result.siteId === fixture.siteId && result.nodeId === node.id
    && result.gatewayId === node.gatewayId && result.assignmentVersion === node.gateway.assignmentVersion
    && result.deviceIdentityHash === createHash("sha256").update(node.deviceUuid).digest("hex")
    && Number.parseInt(result.meshAddress.replace(/^0x/i, ""), 16) === Number.parseInt(node.meshAddress.replace(/^0x/i, ""), 16);
  const verified = Boolean(matches && status === "verified" && result?.modeVerified
    && Date.parse(result.occurredAt) >= row.requestedAt.getTime() && Date.parse(result.occurredAt) <= row.expiresAt.getTime()
    && Date.parse(result.occurredAt) <= now.getTime());
  return { commandId: row.commandId, status, modeVerified: verified, verifiedAt: verified ? result!.occurredAt : null };
}
