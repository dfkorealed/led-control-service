export interface GatewayAssignment {
  siteId: string;
  gatewayId: string;
  serialNumber: string;
  mqttUrl: string;
  configVersion: number;
}

export function parseGatewayAssignment(value: unknown): GatewayAssignment {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid gateway assignment");
  const row = value as Record<string, unknown>;
  const assignment = {
    siteId: requiredText(row.siteId, "siteId"),
    gatewayId: requiredText(row.gatewayId, "gatewayId"),
    serialNumber: requiredText(row.serialNumber, "serialNumber"),
    mqttUrl: requiredText(row.mqttUrl, "mqttUrl"),
    configVersion: row.configVersion
  };
  if (!Number.isSafeInteger(assignment.configVersion) || (assignment.configVersion as number) < 1) {
    throw new Error("invalid gateway assignment configVersion");
  }
  return assignment as GatewayAssignment;
}

function requiredText(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`invalid gateway assignment ${name}`);
  return value.trim();
}
