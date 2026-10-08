import { z } from "zod";
import { provisioningScanFoundSchema } from "./schemas";
import { bioSensorFingerprintV1Schema } from "./bio-sensor-profile-contracts";

/** Discovery is observation only; it carries no profile approval or readiness. */
export const bioProvisioningScanFoundV2Schema = provisioningScanFoundSchema.extend({
  schemaVersion: z.literal(2),
  fingerprint: bioSensorFingerprintV1Schema.nullable()
}).strict();

export type BioProvisioningScanFoundV2Payload = z.infer<typeof bioProvisioningScanFoundV2Schema>;

export const bioDiscoveryTopics = {
  scanFoundV2: (siteId: string, gatewayId: string) =>
    `sites/${siteId}/gateways/${gatewayId}/events/provisioning/scan-found-v2`
} as const;
