import { EventEmitter } from "node:events";
import { systemBus, type MessageBus } from "@homebridge/dbus-native";
import { installDbusMultiReturnCompatibility } from "./bluez-transport";
import {
  BLUETOOTH_MESH_MODELS,
  VEHICLE_SENSOR_VENDOR_MODEL
} from "./bluez-mesh-model-config";

export interface DbusInterfaceDefinition {
  name: string;
  methods: Record<string, [inputSignature: string, outputSignature: string]>;
  // @homebridge/dbus-native 0.7.x expects the property value itself to be a
  // D-Bus signature string. Passing an access tuple is later marshalled as a
  // signature (`g`) value and crashes when BlueZ reads provisioning metadata.
  properties?: Record<string, string>;
  signals?: Record<string, [signature: string]>;
}

export interface DbusExportBus {
  exportInterface(
    implementation: Record<string, unknown>,
    path: string,
    definition: DbusInterfaceDefinition
  ): void;
}

interface NativeExportMessageBus extends MessageBus {
  exportInterface(
    implementation: Record<string, unknown>,
    path: string,
    definition: DbusInterfaceDefinition
  ): void;
}

export const BLUEZ_APPLICATION_PATHS = {
  root: "/com/dfkorea/ledcontrol",
  application: "/com/dfkorea/ledcontrol/application",
  agent: "/com/dfkorea/ledcontrol/agent",
  element: "/com/dfkorea/ledcontrol/ele00"
} as const;

type Variant = [signature: string, value: unknown];
type PropertyDictionary = Array<[name: string, value: Variant]>;
type InterfaceDictionary = Array<[interfaceName: string, properties: PropertyDictionary]>;
type ManagedObjects = Array<[objectPath: string, interfaces: InterfaceDictionary]>;

function createNativeExportBus(): DbusExportBus {
  const bus = systemBus() as NativeExportMessageBus;
  installDbusMultiReturnCompatibility(bus);
  return bus;
}

const objectManagerDefinition: DbusInterfaceDefinition = {
  name: "org.freedesktop.DBus.ObjectManager",
  methods: { GetManagedObjects: ["", "a{oa{sa{sv}}}"] }
};

const applicationDefinition: DbusInterfaceDefinition = {
  name: "org.bluez.mesh.Application1",
  methods: { JoinComplete: ["t", ""], JoinFailed: ["s", ""] },
  properties: {
    CompanyID: "q",
    ProductID: "q",
    VersionID: "q",
    CRPL: "q"
  }
};

const provisionerDefinition: DbusInterfaceDefinition = {
  name: "org.bluez.mesh.Provisioner1",
  methods: {
    ScanResult: ["naya{sv}", ""],
    RequestProvData: ["y", "qq"],
    AddNodeComplete: ["ayqy", ""],
    AddNodeFailed: ["ays", ""]
  }
};

const agentDefinition: DbusInterfaceDefinition = {
  name: "org.bluez.mesh.ProvisionAgent1",
  methods: {
    PrivateKey: ["", "ay"],
    PublicKey: ["", "ay"],
    DisplayString: ["s", ""],
    DisplayNumeric: ["su", ""],
    PromptNumeric: ["s", "u"],
    PromptStatic: ["s", "ay"],
    Cancel: ["", ""]
  },
  properties: { Capabilities: "as", OutOfBandInfo: "as" }
};

const elementDefinition: DbusInterfaceDefinition = {
  name: "org.bluez.mesh.Element1",
  methods: {
    MessageReceived: ["qqvay", ""],
    DevKeyMessageReceived: ["qbyay", ""],
    UpdateModelConfiguration: ["qa{sv}", ""]
  },
  properties: {
    Index: "y",
    Models: "a(qa{sv})",
    VendorModels: "a(qqa{sv})"
  }
};

export class BluezDbusApplication extends EventEmitter {
  private started = false;
  private requestProvisioningData: (elementCount: number) => Promise<[netIndex: number, unicast: number]>;

  constructor(
    private readonly bus: DbusExportBus = createNativeExportBus(),
    requestProvisioningData: (elementCount: number) => Promise<[netIndex: number, unicast: number]> =
      async () => {
        throw new Error("Provisioning address provider is not configured");
      },
    private readonly options: { companyId: number }
  ) {
    super();
    this.requestProvisioningData = requestProvisioningData;
  }

  setProvisioningDataProvider(
    provider: (elementCount: number) => Promise<[netIndex: number, unicast: number]>
  ) {
    this.requestProvisioningData = provider;
  }

  async start() {
    if (this.started) return;
    const application = {
      CompanyID: this.options.companyId,
      ProductID: 0x0001,
      VersionID: 0x0001,
      CRPL: 64,
      JoinComplete: async (token: unknown) => this.emit("joinComplete", { token }),
      JoinFailed: async (reason: string) => this.emit("joinFailed", { reason })
    };
    const provisioner = {
      ScanResult: async (rssi: number, data: number[], options: unknown) =>
        this.emit("scanResult", { rssi, data: Uint8Array.from(data), options }),
      RequestProvData: async (count: number) => this.requestProvisioningData(count),
      AddNodeComplete: async (uuid: number[], unicast: number, count: number) =>
        this.emit("nodeAdded", { uuid: Uint8Array.from(uuid), unicast, count }),
      AddNodeFailed: async (uuid: number[], reason: string) =>
        this.emit("nodeAddFailed", { uuid: Uint8Array.from(uuid), reason })
    };
    const agent = {
      Capabilities: [],
      OutOfBandInfo: [],
      PrivateKey: async () => unsupportedOob("PrivateKey"),
      PublicKey: async () => unsupportedOob("PublicKey"),
      DisplayString: async (value: string) => this.emit("displayString", { value }),
      DisplayNumeric: async (type: string, number: number) => this.emit("displayNumeric", { type, number }),
      PromptNumeric: async () => unsupportedOob("PromptNumeric"),
      PromptStatic: async () => unsupportedOob("PromptStatic"),
      Cancel: async () => this.emit("agentCancelled")
    };
    const models = [0x0001, 0x0003, 0x1001, 0x1302, BLUETOOTH_MESH_MODELS.sensorClient]
      .map((modelId) => [modelId, []]);
    const element = {
      Index: 0,
      Models: models,
      VendorModels: [[this.options.companyId, VEHICLE_SENSOR_VENDOR_MODEL.clientModelId, []]],
      MessageReceived: async (source: number, keyIndex: number, destination: Variant, data: number[]) =>
        this.emit("messageReceived", { source, keyIndex, destination, data: Uint8Array.from(data) }),
      DevKeyMessageReceived: async (source: number, remote: boolean, netIndex: number, data: number[]) =>
        this.emit("devKeyMessageReceived", { source, remote, netIndex, data: Uint8Array.from(data) }),
      UpdateModelConfiguration: async (modelId: number, configuration: unknown) =>
        this.emit("modelConfigurationUpdated", { modelId, configuration })
    };
    const managedObjects = createManagedObjects(application, provisioner, agent, element);
    const objectManager = { GetManagedObjects: async () => managedObjects };

    this.bus.exportInterface(objectManager, BLUEZ_APPLICATION_PATHS.root, objectManagerDefinition);
    this.bus.exportInterface(application, BLUEZ_APPLICATION_PATHS.application, applicationDefinition);
    this.bus.exportInterface(provisioner, BLUEZ_APPLICATION_PATHS.application, provisionerDefinition);
    this.bus.exportInterface(agent, BLUEZ_APPLICATION_PATHS.agent, agentDefinition);
    this.bus.exportInterface(element, BLUEZ_APPLICATION_PATHS.element, elementDefinition);
    this.started = true;
  }
}

function createManagedObjects(
  application: Record<string, unknown>,
  _provisioner: Record<string, unknown>,
  agent: Record<string, unknown>,
  element: Record<string, unknown>
): ManagedObjects {
  return [
    [
      BLUEZ_APPLICATION_PATHS.application,
      [
        ["org.bluez.mesh.Application1", properties(application, applicationDefinition)],
        ["org.bluez.mesh.Provisioner1", []]
      ]
    ],
    [BLUEZ_APPLICATION_PATHS.agent, [["org.bluez.mesh.ProvisionAgent1", properties(agent, agentDefinition)]]],
    [BLUEZ_APPLICATION_PATHS.element, [["org.bluez.mesh.Element1", properties(element, elementDefinition)]]]
  ];
}

function properties(implementation: Record<string, unknown>, definition: DbusInterfaceDefinition): PropertyDictionary {
  return Object.entries(definition.properties ?? {}).map(([name, signature]) => [name, [signature, implementation[name]]]);
}

function unsupportedOob(method: string): never {
  const error = new Error(`${method} is unavailable because this appliance uses no-OOB provisioning`) as Error & {
    dbusName: string;
  };
  error.dbusName = "org.bluez.mesh.Error.NotSupported";
  throw error;
}
