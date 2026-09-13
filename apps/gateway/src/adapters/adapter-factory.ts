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
import { BioUsbDongleAdapter } from "./bio-usb-dongle-adapter";
import { BioSensorCapabilityUnavailablePort } from "./bio-sensor-capability-unavailable-port";
import { BioDongleClient, type BioDongleClientOptions } from "../bio/bio-dongle-client";
import { BioDeviceMappingStore } from "../bio/bio-device-mapping-store";
import { BioDirectUsbConnection } from "../bio/bio-direct-usb-connection";
import type { BioByteConnection } from "../bio/bio-byte-connection";

export type GatewayAdapterKind = "bluez" | "bio-usb";

export interface GatewayAdapters {
  adapterKind: GatewayAdapterKind;
  dimming: BleMeshAdapter;
  scanner: ProvisioningScannerAdapter;
  provisioning: ProvisioningAdapter;
  vehicleSensors: VehicleSensorMeshPort;
  vehicleSensorCloudSupported: boolean;
  healthProbes: ApplianceHealthProbes;
  stop(): Promise<void>;
}

interface AdapterFactoryDependencies {
  createBluezAdapter?: (companyId: number) => Promise<BleMeshAdapter & ProvisioningScannerAdapter & ProvisioningAdapter & {
    healthProbes?: ApplianceHealthProbes;
    vehicleSensors: VehicleSensorMeshPort;
    stop?: () => Promise<void>;
  }>;
  createBioConnection?: () => BioByteConnection;
  createBioClient?: (options: BioDongleClientOptions) => BioDongleClient;
  createBioMappingStore?: (path: string) => BioDeviceMappingStore;
  createBioAdapter?: (client: BioDongleClient, mappings: BioDeviceMappingStore) => BioUsbDongleAdapter;
  createBioVehicleSensors?: () => VehicleSensorMeshPort;
}

export async function createProductionAdapters(
  env: NodeJS.ProcessEnv,
  dependencies: AdapterFactoryDependencies = {}
): Promise<GatewayAdapters> {
  const adapterKind = resolveGatewayAdapterKind(env);
  // [확인됨] adapter 선택은 명시값만 허용한다. 누락/오타를 BlueZ나 BIO로 추정하면
  // 서로 다른 장비 소유권과 안전 조건을 건너뛰므로 시작 전에 fail-closed한다.
  if (adapterKind === "bio-usb") return createBioUsbAdapters(env, dependencies);

  const companyId = resolveGatewayBluetoothCompanyId(env);

  const adapter = await (dependencies.createBluezAdapter ?? ((ownedCompanyId) => createBluezAdapter(env, ownedCompanyId)))(companyId);
  if (!adapter.healthProbes) throw new Error("BlueZ health probes are unavailable");
  return {
    adapterKind: "bluez",
    dimming: adapter,
    scanner: adapter,
    provisioning: adapter,
    vehicleSensors: adapter.vehicleSensors,
    vehicleSensorCloudSupported: true,
    healthProbes: adapter.healthProbes,
    stop: async () => {
      if ("stop" in adapter && typeof adapter.stop === "function") await adapter.stop();
    }
  };
}

export function resolveGatewayAdapterKind(env: NodeJS.ProcessEnv): GatewayAdapterKind {
  if (env.GATEWAY_ADAPTER === "bluez" || env.GATEWAY_ADAPTER === "bio-usb") return env.GATEWAY_ADAPTER;
  throw new Error("PRODUCTION_ADAPTER_REQUIRED: GATEWAY_ADAPTER must be bluez or bio-usb");
}

async function createBioUsbAdapters(
  env: NodeJS.ProcessEnv,
  dependencies: AdapterFactoryDependencies
): Promise<GatewayAdapters> {
  const responseTimeoutMs = parseBioPositiveInteger(env.GATEWAY_BIO_RESPONSE_TIMEOUT_MS, 300);
  const scanDurationMs = parseBioPositiveInteger(env.GATEWAY_BIO_SCAN_DURATION_MS, 5_000);
  const connectionFactory = dependencies.createBioConnection ?? (() => new BioDirectUsbConnection());
  const client = (dependencies.createBioClient ?? ((options) => new BioDongleClient(options)))({
    connectionFactory,
    timeoutMs: responseTimeoutMs,
    scanDurationMs
  });
  const mappingPath = env.GATEWAY_BIO_MAPPING_PATH ?? "/var/lib/led-control/bio-device-mappings.json";
  const mappings = (dependencies.createBioMappingStore ?? ((path) => new BioDeviceMappingStore(path)))(mappingPath);

  try {
    // [확인됨] BIO 시작은 exact direct-USB descriptor/claim/Android-equivalent probe와
    // durable mapping parse를 모두 통과해야 한다. [추정] 이 boolean readiness가 실제 RF
    // 장기 안정성을 뜻하지는 않으며 Task 8~10의 배포/HIL 전까지 [미확인]이다.
    // [확인됨] 이후 disconnect/cancel 복구는 client가 오염된 connection generation을
    // 폐기하고 새 direct-USB probe로 소유권을 다시 여는 경로를 그대로 사용한다. mapping이나
    // 이전 ACK로 연결 복구를 추정하지 않으며, 실제 반복 탈착 수렴은 Task 8에서 [미확인]이다.
    await client.probe();
    await mappings.validate();
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }

  const adapter = (dependencies.createBioAdapter ?? ((ownedClient, ownedMappings) =>
    new BioUsbDongleAdapter(ownedClient, ownedMappings)))(client, mappings);
  const vehicleSensors = (dependencies.createBioVehicleSensors ?? (() =>
    new BioSensorCapabilityUnavailablePort()))();
  const healthProbes: ApplianceHealthProbes = {
    adapterKind: "bio-usb",
    transportConnected: async () => client.transportSnapshot().transportConnected,
    protocolReady: async () => client.transportSnapshot().protocolReady,
    mappingValid: async () => { await mappings.validate(); return true; }
  };

  // [확인됨] 생산 의존성은 Gateway의 direct USB client와 local mapping뿐이다.
  // 제조사 앱·Android 단말·휴대폰/D-Bus/BlueZ를 BIO 경로에 추가하지 않는다.
  return {
    adapterKind: "bio-usb",
    dimming: adapter,
    scanner: adapter,
    provisioning: adapter,
    vehicleSensors,
    vehicleSensorCloudSupported: false,
    healthProbes,
    stop: () => client.close()
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
    adapterKind: "bluez",
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

function parseBioPositiveInteger(value: string | undefined, fallback: number) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("Gateway BIO timeout and scan settings must be positive integers");
  return parsed;
}
