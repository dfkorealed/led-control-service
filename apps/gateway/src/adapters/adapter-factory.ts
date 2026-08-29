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

const DEFAULT_BLUEZ_ADAPTER_PATH = "/org/bluez/hci0";

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
    healthProbes: createBluezHealthProbes(
      transport,
      provisioner,
      addressStore,
      env.GATEWAY_BLUEZ_ADAPTER_PATH ?? DEFAULT_BLUEZ_ADAPTER_PATH
    )
  });
}

export function createBluezHealthProbes(
  transport: Pick<BluezTransport, "call">,
  provisioner: Pick<BluezProvisioner, "nodePath">,
  addressStore: Pick<MeshAddressStore, "validate">,
  adapterPath = DEFAULT_BLUEZ_ADAPTER_PATH
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
    hciPowered: async () => await isBluezAdapterPowered(transport, adapterPath),
    mappingValid: async () => { await addressStore.validate(); return true; }
  };
}

export async function isBluezAdapterPowered(
  transport: Pick<BluezTransport, "call">,
  adapterPath = DEFAULT_BLUEZ_ADAPTER_PATH
) {
  try {
    const powered = await transport.call<unknown>(
      "org.bluez",
      adapterPath,
      "org.freedesktop.DBus.Properties",
      "Get",
      ["org.bluez.Adapter1", "Powered"]
    );
    return powered === true || isTrueBluezBooleanVariant(powered);
  } catch {
    return false;
  }
}

function isTrueBluezBooleanVariant(value: unknown) {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const [signature, variantValue] = value;
  if (signature === "b") return variantValue === true;
  if (!Array.isArray(signature) || signature.length !== 1 || !Array.isArray(variantValue) || variantValue.length !== 1) {
    return false;
  }
  const signatureType = signature[0] && typeof signature[0] === "object"
    ? (signature[0] as { type?: unknown }).type
    : undefined;
  return signatureType === "b" && variantValue[0] === true;
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
