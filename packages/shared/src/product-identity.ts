export const DFK_DEVICE_UUID_PREFIX = "44464b4c4544";
export const DFK_DEVICE_UUID_FORMAT_VERSION = 1;

export interface DfkProductIdentity {
  formatVersion: number;
  productFamily: number;
  modelCode: number;
  hardwareRevision: number;
  deviceIdentity: string;
}

export function parseDfkDeviceUuid(value: string): DfkProductIdentity | null {
  const normalized = value.trim().replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(normalized)) return null;
  if (!normalized.startsWith(DFK_DEVICE_UUID_PREFIX)) return null;

  const formatVersion = parseByte(normalized, 12);
  if (formatVersion !== DFK_DEVICE_UUID_FORMAT_VERSION) return null;

  return {
    formatVersion,
    productFamily: parseByte(normalized, 14),
    modelCode: parseByte(normalized, 16),
    hardwareRevision: parseByte(normalized, 18),
    deviceIdentity: normalized.slice(20)
  };
}

function parseByte(value: string, offset: number) {
  return Number.parseInt(value.slice(offset, offset + 2), 16);
}
