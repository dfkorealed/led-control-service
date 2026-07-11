import type { BleMeshAdapter, ProvisioningAdapter, ProvisioningScannerAdapter } from "../gateway";

export interface GatewayAdapters {
  dimming: BleMeshAdapter;
  scanner: ProvisioningScannerAdapter;
  provisioning: ProvisioningAdapter;
}

export async function createProductionAdapters(env: NodeJS.ProcessEnv): Promise<GatewayAdapters> {
  if (env.GATEWAY_ADAPTER !== "bluez") {
    throw new Error("PRODUCTION_ADAPTER_REQUIRED: GATEWAY_ADAPTER must be bluez");
  }

  throw new Error(
    "PRODUCTION_ADAPTER_UNAVAILABLE: Raspberry Pi BlueZ Phase 0 and the real BlueZ Mesh adapter must be completed before gateway startup"
  );
}
