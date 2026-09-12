const BIO_DEVICE_UUID_PATTERN = /^bio:([0-9a-f]{12})$/;
const BIO_NATIVE_UUID_PATTERN = /^[0-9a-f]{12}$/i;

/**
 * Converts the six-byte identifier reported by BIO hardware into the only
 * cloud identity accepted by the BIO adapter boundary.
 */
export function formatBioDeviceUuid(nativeUuid: string) {
  if (!BIO_NATIVE_UUID_PATTERN.test(nativeUuid)) throw new Error("Invalid BIO native UUID");
  return `bio:${nativeUuid.toLowerCase()}`;
}

/**
 * Extracts the six-byte native identifier only from the canonical cloud form.
 * Uppercase or alternate prefixes must not cross the adapter identity boundary.
 */
export function parseBioDeviceUuid(deviceUuid: string) {
  const match = BIO_DEVICE_UUID_PATTERN.exec(deviceUuid);
  if (!match) throw new Error("Invalid BIO device UUID");
  return match[1];
}
