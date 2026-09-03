import type { BleMeshAdapter, ProvisioningAdapter, ProvisioningScannerAdapter } from "../gateway";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ApplianceHealthProbes } from "../health/appliance-health";
import { BluezDbusApplication } from "../mesh/bluez-dbus-application";
import { BluezConfigClient } from "../mesh/bluez-config-client";
import { BluezMeshAdapter } from "../mesh/bluez-mesh-adapter";
import { BluezProvisioner } from "../mesh/bluez-provisioner";
import { createNativeSystemBus, BluezTransport } from "../mesh/bluez-transport";
import { MeshAddressStore } from "../mesh/mesh-address-store";
import { MeshIdentityStore } from "../mesh/mesh-identity-store";
import { MeshTransactionStore } from "../mesh/mesh-transaction-store";
import { BluezVehicleSensorMeshPort, type VehicleSensorMeshPort } from "../mesh/vehicle-sensor-client";
import { resolveGatewayBluetoothCompanyId } from "../deployment-profile";

export interface GatewayAdapters {
  dimming: BleMeshAdapter;
  scanner: ProvisioningScannerAdapter;
  provisioning: ProvisioningAdapter;
  vehicleSensors: VehicleSensorMeshPort;
  healthProbes?: ApplianceHealthProbes;
}

interface AdapterFactoryDependencies {
  createBluezAdapter?: (companyId: number) => Promise<BleMeshAdapter & ProvisioningScannerAdapter & ProvisioningAdapter & {
    healthProbes?: ApplianceHealthProbes;
    vehicleSensors: VehicleSensorMeshPort;
  }>;
}

export async function createProductionAdapters(
  env: NodeJS.ProcessEnv,
  dependencies: AdapterFactoryDependencies = {}
): Promise<GatewayAdapters> {
  if (env.GATEWAY_ADAPTER !== "bluez") {
    throw new Error("PRODUCTION_ADAPTER_REQUIRED: GATEWAY_ADAPTER must be bluez");
  }
  const companyId = resolveGatewayBluetoothCompanyId(env);

  const adapter = await (dependencies.createBluezAdapter ?? ((ownedCompanyId) => createBluezAdapter(env, ownedCompanyId)))(companyId);
  return {
    dimming: adapter,
    scanner: adapter,
    provisioning: adapter,
    vehicleSensors: adapter.vehicleSensors,
    ...(adapter.healthProbes ? { healthProbes: adapter.healthProbes } : {})
  };
}

async function createBluezAdapter(env: NodeJS.ProcessEnv, companyId: number) {
  const bus = createNativeSystemBus();
  const transport = new BluezTransport(() => bus);
  const addressStore = new MeshAddressStore(env.GATEWAY_MESH_ADDRESS_PATH ?? "/var/lib/led-control/mesh-addresses.json");
  const identityStore = new MeshIdentityStore(env.GATEWAY_MESH_IDENTITY_PATH ?? "/var/lib/led-control/mesh-identity.json");
  const application = new BluezDbusApplication(bus, undefined, { companyId });
  const provisioner = new BluezProvisioner(transport, application, identityStore, addressStore);
  const transactions = new MeshTransactionStore(env.GATEWAY_MESH_TRANSACTION_PATH ?? "/var/lib/led-control/mesh-transactions.json");
  const adapter = new BluezMeshAdapter(
    transport,
    application,
    provisioner,
    addressStore,
    (nodePath) => new BluezConfigClient(transport, application, nodePath, { companyId }),
    transactions,
    {
      responseTimeoutMs: parsePositiveInteger(env.GATEWAY_BLE_STATUS_TIMEOUT_MS, 8_000),
      scanSeconds: parsePositiveInteger(env.GATEWAY_BLE_SCAN_SECONDS, 10),
      companyId
    }
  );
  await adapter.start();
  return Object.assign(adapter, {
    vehicleSensors: new BluezVehicleSensorMeshPort({
      transport,
      application,
      provisioner,
      addressStore,
      createConfigClient: (nodePath) => new BluezConfigClient(transport, application, nodePath, { companyId })
    }),
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
    mappingValid: async () => { await addressStore.validate(); return true; }
  };
}

// rfkill reports a Linux radio-block state, not BlueZ controller readiness.
// Keep it available for diagnostics, but never use it for appliance health.
export async function isHciRfkillUnblocked(root = "/sys/class/bluetooth/hci0") {
  try {
    const rfkillEntries = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^rfkill\d+$/.test(entry.name));
    for (const entry of rfkillEntries) {
      const rfkillRoot = join(root, entry.name);
      const [type, state] = await Promise.all([
        readFile(join(rfkillRoot, "type"), "utf8"),
        readFile(join(rfkillRoot, "state"), "utf8")
      ]);
      if (type.trim() === "bluetooth" && state.trim() === "1") return true;
    }
  } catch {
    return false;
  }
  return false;
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("Gateway BLE timeout and scan settings must be positive integers");
  return parsed;
}
