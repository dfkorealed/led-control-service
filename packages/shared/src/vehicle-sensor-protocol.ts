export const BLUETOOTH_COMPANY_ID_CONFIG = {
  gatewayEnvironment: "GATEWAY_BLUETOOTH_COMPANY_ID",
  firmwareSdkConfig: "CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID"
} as const;

const BLUETOOTH_COMPANY_ID_UNASSIGNED = 0x0000;
const BLUETOOTH_COMPANY_ID_INTERNAL_USE = 0xffff;
const ESPRESSIF_BLUETOOTH_COMPANY_ID = 0x02e5;

export function parseOwnedBluetoothCompanyId(value: string | undefined): number {
  const normalized = value?.trim();
  if (!normalized || !/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(normalized)) {
    throw new Error("owned_bluetooth_company_id_required");
  }
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed <= BLUETOOTH_COMPANY_ID_UNASSIGNED ||
    parsed >= BLUETOOTH_COMPANY_ID_INTERNAL_USE || parsed === ESPRESSIF_BLUETOOTH_COMPANY_ID) {
    throw new Error("owned_bluetooth_company_id_required");
  }
  return parsed;
}
