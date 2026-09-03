import { BLUETOOTH_COMPANY_ID_CONFIG, parseOwnedBluetoothCompanyId } from "@led-control/shared";

const LAB_HIL_COMPANY_ID = 0xfffe;
const LAB_HIL_ACKNOWLEDGEMENT = "NOT_FOR_PRODUCTION";

export type GatewayDeploymentMode = "production" | "lab-hil";

export function resolveGatewayBluetoothCompanyId(env: NodeJS.ProcessEnv): number {
  const mode = (env.GATEWAY_DEPLOYMENT_MODE ?? "production").trim();
  const rawCompanyId = env[BLUETOOTH_COMPANY_ID_CONFIG.gatewayEnvironment]?.trim();

  if (mode === "production") {
    const companyId = parseOwnedBluetoothCompanyId(rawCompanyId);
    if (companyId === LAB_HIL_COMPANY_ID) {
      throw new Error("owned_bluetooth_company_id_required");
    }
    return companyId;
  }
  if (mode !== "lab-hil") {
    throw new Error("gateway_deployment_mode_invalid");
  }
  if (env.GATEWAY_LAB_HIL_ACK !== LAB_HIL_ACKNOWLEDGEMENT) {
    throw new Error("lab_hil_ack_required");
  }
  if (!rawCompanyId || !/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(rawCompanyId) || Number(rawCompanyId) !== LAB_HIL_COMPANY_ID) {
    throw new Error("lab_hil_bluetooth_company_id_required");
  }
  return LAB_HIL_COMPANY_ID;
}

export function isLabHilDeployment(env: NodeJS.ProcessEnv): boolean {
  return env.GATEWAY_DEPLOYMENT_MODE?.trim() === "lab-hil";
}
