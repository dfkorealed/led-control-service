/** Only bounded product codes may leave the Gateway in an acknowledgement.
 * USB paths, raw replies and third-party error text remain in the cause chain. */
const codes = [
  "bio_self_storage_unavailable", "bio_self_journal_invalid", "bio_self_control_conflict",
  "bio_self_configuration_pending", "bio_self_ownership_changed", "bio_self_identity_changed",
  "bio_self_firmware_unsupported", "bio_self_control_unavailable", "bio_self_readback_failed"
] as const;
export type BioSelfSensorErrorCode = typeof codes[number];
export function isBioSelfSensorErrorCode(value: unknown): value is BioSelfSensorErrorCode {
  return typeof value === "string" && (codes as readonly string[]).includes(value);
}
