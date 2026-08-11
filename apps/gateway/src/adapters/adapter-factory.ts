import type { BleMeshAdapter, ProvisioningAdapter, ProvisioningScannerAdapter } from "../gateway";
import { readFile } from "node:fs/promises";
import type { ApplianceHealthProbes } from "../health/appliance-health";
import { BluezDbusApplication } from "../mesh/bluez-dbus-application";
import { BluezConfigClient } from "../mesh/bluez-config-client";
import { BluezMeshAdapter } from "../mesh/bluez-mesh-adapter";
import { BluezProvisioner } from "../mesh/bluez-provisioner";
import { createNativeSystemBus, BluezTransport } from "../mesh/bluez-transport";
import { MeshAddressStore } from "../mesh/mesh-address-store";
import { MeshIdentityStore } from "../mesh/mesh-identity-store";
import { MeshTransactionStore } from "../mesh/mesh-transaction-store";

export interface GatewayAdapters {
  dimming: BleMeshAdapter;
  scanner: ProvisioningScannerAdapter;
  provisioning: ProvisioningAdapter;
  healthProbes?: ApplianceHealthProbes;
}

interface AdapterFactoryDependencies {
  createBluezAdapter?: () => Promise<BleMeshAdapter & ProvisioningScannerAdapter & ProvisioningAdapter & {
    healthProbes?: ApplianceHealthProbes;
  }>;
}

export async function createProductionAdapters(
  env: NodeJS.ProcessEnv,
  dependencies: AdapterFactoryDependencies = {}
): Promise<GatewayAdapters> {
  if (env.GATEWAY_ADAPTER !== "bluez") {
    throw new Error("PRODUCTION_ADAPTER_REQUIRED: GATEWAY_ADAPTER must be bluez");
  }

  const adapter = await (dependencies.createBluezAdapter ?? (() => createBluezAdapter(env)))();
  return { dimming: adapter, scanner: adapter, provisioning: adapter, healthProbes: adapter.healthProbes };
}

async function createBluezAdapter(env: NodeJS.ProcessEnv) {
  const bus = createNativeSystemBus();
  const transport = new BluezTransport(() => bus);
  const addressStore = new MeshAddressStore(env.GATEWAY_MESH_ADDRESS_PATH ?? "/var/lib/led-control/mesh-addresses.json");
  const identityStore = new MeshIdentityStore(env.GATEWAY_MESH_IDENTITY_PATH ?? "/var/lib/led-control/mesh-identity.json");
  const application = new BluezDbusApplication(bus);
  const provisioner = new BluezProvisioner(transport, application, identityStore, addressStore);
  const transactions = new MeshTransactionStore(env.GATEWAY_MESH_TRANSACTION_PATH ?? "/var/lib/led-control/mesh-transactions.json");
  const adapter = new BluezMeshAdapter(
    transport,
    application,
    provisioner,
    addressStore,
    (nodePath) => new BluezConfigClient(transport, application, nodePath),
    transactions,
    {
      responseTimeoutMs: parsePositiveInteger(env.GATEWAY_BLE_STATUS_TIMEOUT_MS, 8_000),
      scanSeconds: parsePositiveInteger(env.GATEWAY_BLE_SCAN_SECONDS, 10)
    }
  );
  await adapter.start();
  return Object.assign(adapter, {
    healthProbes: createBluezHealthProbes(transport, provisioner, addressStore)
  });
}

export function createBluezHealthProbes(
  transport: Pick<BluezTransport, "call">,
  provisioner: Pick<BluezProvisioner, "nodePath">,
  addressStore: Pick<MeshAddressStore, "validate">
): ApplianceHealthProbes {
  return {
    dbusOwner: async () => await transport.call<boolean>(
      "org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus",
      "NameHasOwner",
      ["org.bluez.mesh"]
    ),
    bluezAttached: async () => {
      const nodePath = provisioner.nodePath;
      if (!nodePath) return false;
      const introspection = await transport.call<string>(
        "org.bluez.mesh",
        nodePath,
        "org.freedesktop.DBus.Introspectable",
        "Introspect",
        []
      );
      return typeof introspection === "string" && introspection.includes('interface name="org.bluez.mesh.Node1"');
    },
    hciPowered: async () => (Number.parseInt(await readFile("/sys/class/bluetooth/hci0/flags", "utf8"), 16) & 1) === 1,
    mappingValid: async () => { await addressStore.validate(); return true; }
  };
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("Gateway BLE timeout and scan settings must be positive integers");
  return parsed;
}
