import type { EventEmitter } from "node:events";
import { BLUEZ_APPLICATION_PATHS } from "./bluez-dbus-application";
import {
  CONFIG_OPCODES,
  encodeCompositionDataGet,
  encodeModelAppBind,
  encodeModelSubscriptionAdd,
  encodeModelSubscriptionDelete,
  encodePublicationPeriod,
  encodeModelPublicationSet,
  parseAppKeyStatus,
  parseCompositionDataStatus,
  parseModelAppStatus,
  parseModelSubscriptionStatus,
  parseModelPublicationStatus,
  parsePrimaryElementCompositionModels,
  startsWithOpcode
} from "./bluez-config-codec";
import {
  BLUETOOTH_MESH_MODELS,
  VEHICLE_SENSOR_VENDOR_MODEL
} from "./bluez-mesh-model-config";

const BLUEZ_SERVICE = "org.bluez.mesh";
const NODE_INTERFACE = "org.bluez.mesh.Node1";
const MANAGEMENT_INTERFACE = "org.bluez.mesh.Management1";
const NET_KEY_INDEX = 0;
const APP_KEY_INDEX = 0;
const PROVISIONER_ADDRESS = 0x0001;
const SERVER_MODELS = [0x0002, 0x1000, 0x1300] as const;
const LOCAL_SIG_CLIENT_MODELS = [0x0003, 0x1001, BLUETOOTH_MESH_MODELS.sensorClient, 0x1302] as const;
const LIGHT_LIGHTNESS_SERVER_MODEL_ID = 0x1300;
const STATUS_PUBLICATION_PERIOD = encodePublicationPeriod(60_000);
const VEHICLE_SENSOR_STACK_PUBLICATION_PERIOD = 0;
const VEHICLE_SENSOR_PUBLICATION_RETRANSMIT = 0;
type RawStatusMatcher = (data: Uint8Array) => boolean;

interface ConfigTransport {
  call<T>(service: string, path: string, interfaceName: string, method: string, args: unknown[]): Promise<T>;
}

export interface NodeComposition {
  unicast: number;
  elementCount: number;
  compositionPage: number;
  compositionData: Uint8Array;
}

export class BluezConfigClient {
  private readonly responseTimeoutMs: number;
  private readonly companyId: number;

  constructor(
    private readonly transport: ConfigTransport,
    private readonly application: EventEmitter,
    private readonly nodePath: string,
    options: { responseTimeoutMs?: number; companyId: number }
  ) {
    this.responseTimeoutMs = options.responseTimeoutMs ?? 10_000;
    this.companyId = options.companyId;
  }

  async prepareLocalNode() {
    await this.ensureLocalAppKey();
    for (const modelId of LOCAL_SIG_CLIENT_MODELS) {
      const status = await this.sendLocalDevKeyAndWait(
        encodeModelAppBind(PROVISIONER_ADDRESS, APP_KEY_INDEX, modelId),
        CONFIG_OPCODES.modelAppStatus,
        parseModelAppStatus
      );
      if (status.elementAddress !== PROVISIONER_ADDRESS || status.appKeyIndex !== APP_KEY_INDEX ||
        status.modelId !== modelId || "companyId" in status) {
        throw new Error("Local client model App binding does not match the request");
      }
    }

    const vendorStatus = await this.sendLocalDevKeyAndWait(
      encodeModelAppBind(
        PROVISIONER_ADDRESS,
        APP_KEY_INDEX,
        VEHICLE_SENSOR_VENDOR_MODEL.clientModelId,
        this.companyId
      ),
      CONFIG_OPCODES.modelAppStatus,
      parseModelAppStatus
    );
    if (vendorStatus.elementAddress !== PROVISIONER_ADDRESS || vendorStatus.appKeyIndex !== APP_KEY_INDEX ||
      vendorStatus.modelId !== VEHICLE_SENSOR_VENDOR_MODEL.clientModelId ||
      !("companyId" in vendorStatus) || vendorStatus.companyId !== this.companyId) {
      throw new Error("Local vendor client model App binding does not match the request");
    }
  }

  async configureNode(input: { unicast: number; elementCount: number }): Promise<NodeComposition> {
    await this.ensureLocalAppKey();
    await this.ensureRemoteAppKey(input.unicast);
    const composition = await this.sendDevKeyAndWait(
      input.unicast,
      encodeCompositionDataGet(0),
      CONFIG_OPCODES.compositionDataStatus,
      parseCompositionDataStatus
    );
    for (const modelId of SERVER_MODELS) {
      const status = await this.sendDevKeyAndWait(
        input.unicast,
        encodeModelAppBind(input.unicast, APP_KEY_INDEX, modelId),
        CONFIG_OPCODES.modelAppStatus,
        parseModelAppStatus
      );
      if (status.elementAddress !== input.unicast || status.modelId !== modelId || status.appKeyIndex !== APP_KEY_INDEX) {
        throw new Error("Config Model App Status does not match the request");
      }
    }
    for (const modelId of SERVER_MODELS) {
      const status = await this.sendDevKeyAndWait(
        input.unicast,
        encodeModelPublicationSet({
          elementAddress: input.unicast,
          publishAddress: PROVISIONER_ADDRESS,
          appKeyIndex: APP_KEY_INDEX,
          ttl: 5,
          modelId,
          period: STATUS_PUBLICATION_PERIOD
        }),
        CONFIG_OPCODES.modelPublicationStatus,
        parseModelPublicationStatus
      );
      if (
        status.elementAddress !== input.unicast ||
        status.modelId !== modelId ||
        status.publishAddress !== PROVISIONER_ADDRESS ||
        status.appKeyIndex !== APP_KEY_INDEX ||
        status.ttl !== 5 ||
        status.period !== STATUS_PUBLICATION_PERIOD
      ) {
        throw new Error("Config Model Publication Status does not match the request");
      }
    }
    return {
      unicast: input.unicast,
      elementCount: input.elementCount,
      compositionPage: composition.page,
      compositionData: composition.data
    };
  }

  async configureVehicleSensorModels(input: { unicast: number; elementCount: number }) {
    await this.ensureLocalAppKey();
    const composition = await this.sendDevKeyAndWait(
      input.unicast,
      encodeCompositionDataGet(0),
      CONFIG_OPCODES.compositionDataStatus,
      parseCompositionDataStatus
    );
    if (composition.page !== 0) throw new Error("Vehicle sensor capability requires Composition Page 0");
    const models = parsePrimaryElementCompositionModels(composition.data);
    const hasSensorServer = models.sigModelIds.includes(BLUETOOTH_MESH_MODELS.sensorServer);
    const hasVendorServer = models.vendorModels.some(({ companyId, modelId }) =>
      companyId === this.companyId && modelId === VEHICLE_SENSOR_VENDOR_MODEL.serverModelId
    );

    if (hasSensorServer) {
      const binding = await this.sendDevKeyAndWait(
        input.unicast,
        encodeModelAppBind(input.unicast, APP_KEY_INDEX, BLUETOOTH_MESH_MODELS.sensorServer),
        CONFIG_OPCODES.modelAppStatus,
        parseModelAppStatus
      );
      if (binding.elementAddress !== input.unicast || binding.appKeyIndex !== APP_KEY_INDEX ||
        binding.modelId !== BLUETOOTH_MESH_MODELS.sensorServer || "companyId" in binding) {
        throw new Error("Vehicle Sensor Server App binding does not match the request");
      }
      const publication = await this.sendDevKeyAndWait(
        input.unicast,
        encodeModelPublicationSet({
          elementAddress: input.unicast,
          publishAddress: PROVISIONER_ADDRESS,
          appKeyIndex: APP_KEY_INDEX,
          ttl: 5,
          modelId: BLUETOOTH_MESH_MODELS.sensorServer,
          period: VEHICLE_SENSOR_STACK_PUBLICATION_PERIOD,
          retransmit: VEHICLE_SENSOR_PUBLICATION_RETRANSMIT
        }),
        CONFIG_OPCODES.modelPublicationStatus,
        parseModelPublicationStatus
      );
      if (publication.elementAddress !== input.unicast || publication.publishAddress !== PROVISIONER_ADDRESS ||
        publication.appKeyIndex !== APP_KEY_INDEX || publication.ttl !== 5 ||
        publication.period !== VEHICLE_SENSOR_STACK_PUBLICATION_PERIOD ||
        publication.retransmit !== VEHICLE_SENSOR_PUBLICATION_RETRANSMIT ||
        publication.modelId !== BLUETOOTH_MESH_MODELS.sensorServer ||
        "companyId" in publication) {
        throw new Error("Vehicle Sensor Server publication does not match the request");
      }
    }

    if (hasVendorServer) {
      const binding = await this.sendDevKeyAndWait(
        input.unicast,
        encodeModelAppBind(
          input.unicast,
          APP_KEY_INDEX,
          VEHICLE_SENSOR_VENDOR_MODEL.serverModelId,
          this.companyId
        ),
        CONFIG_OPCODES.modelAppStatus,
        parseModelAppStatus
      );
      if (binding.elementAddress !== input.unicast || binding.appKeyIndex !== APP_KEY_INDEX ||
        binding.modelId !== VEHICLE_SENSOR_VENDOR_MODEL.serverModelId ||
        !("companyId" in binding) || binding.companyId !== this.companyId) {
        throw new Error("Vehicle sensor vendor model App binding does not match the request");
      }
      const publication = await this.sendDevKeyAndWait(
        input.unicast,
        encodeModelPublicationSet({
          elementAddress: input.unicast,
          publishAddress: PROVISIONER_ADDRESS,
          appKeyIndex: APP_KEY_INDEX,
          ttl: 5,
          modelId: VEHICLE_SENSOR_VENDOR_MODEL.serverModelId,
          companyId: this.companyId,
          period: VEHICLE_SENSOR_STACK_PUBLICATION_PERIOD,
          retransmit: VEHICLE_SENSOR_PUBLICATION_RETRANSMIT
        }),
        CONFIG_OPCODES.modelPublicationStatus,
        parseModelPublicationStatus
      );
      if (publication.elementAddress !== input.unicast || publication.publishAddress !== PROVISIONER_ADDRESS ||
        publication.appKeyIndex !== APP_KEY_INDEX || publication.ttl !== 5 ||
        publication.period !== VEHICLE_SENSOR_STACK_PUBLICATION_PERIOD ||
        publication.retransmit !== VEHICLE_SENSOR_PUBLICATION_RETRANSMIT ||
        publication.modelId !== VEHICLE_SENSOR_VENDOR_MODEL.serverModelId || !("companyId" in publication) ||
        publication.companyId !== this.companyId) {
        throw new Error("Vehicle sensor vendor model publication does not match the request");
      }
    }
    return {
      sensorServerBound: hasSensorServer,
      vendorVehicleEventModelBound: hasVendorServer
    };
  }

  async addModelSubscription(input: { unicast: number; groupAddress: number; modelId?: number }) {
    const modelId = input.modelId ?? LIGHT_LIGHTNESS_SERVER_MODEL_ID;
    const status = await this.sendDevKeyAndWait(
      input.unicast,
      encodeModelSubscriptionAdd(input.unicast, input.groupAddress, modelId),
      CONFIG_OPCODES.modelSubscriptionStatus,
      parseModelSubscriptionStatus,
      createModelSubscriptionStatusMatcher({
        elementAddress: input.unicast,
        groupAddress: input.groupAddress,
        modelId
      })
    );
    if (
      status.elementAddress !== input.unicast ||
      status.groupAddress !== input.groupAddress ||
      status.modelId !== modelId
    ) {
      throw new Error("Config Model Subscription Status does not match the request");
    }
    return status;
  }

  async removeModelSubscription(input: { unicast: number; groupAddress: number; modelId?: number }) {
    const modelId = input.modelId ?? LIGHT_LIGHTNESS_SERVER_MODEL_ID;
    const status = await this.sendDevKeyAndWait(
      input.unicast,
      encodeModelSubscriptionDelete(input.unicast, input.groupAddress, modelId),
      CONFIG_OPCODES.modelSubscriptionStatus,
      parseModelSubscriptionStatus,
      createModelSubscriptionStatusMatcher({ elementAddress: input.unicast, groupAddress: input.groupAddress, modelId })
    );
    if (status.elementAddress !== input.unicast || status.groupAddress !== input.groupAddress || status.modelId !== modelId) {
      throw new Error("Config Model Subscription Status does not match the request");
    }
    return status;
  }

  private async ensureLocalAppKey() {
    try {
      await this.transport.call(BLUEZ_SERVICE, this.nodePath, MANAGEMENT_INTERFACE, "CreateAppKey", [NET_KEY_INDEX, APP_KEY_INDEX]);
    } catch (error) {
      if (!errorChainIncludes(error, "AlreadyExists")) throw error;
    }
  }

  private ensureRemoteAppKey(destination: number) {
    return this.sendAndWait(
      "AddAppKey",
      [BLUEZ_APPLICATION_PATHS.element, destination, APP_KEY_INDEX, NET_KEY_INDEX, false],
      CONFIG_OPCODES.appKeyStatus,
      (data) => {
        const status = parseAppKeyStatus(data, { allowAlreadyStored: true });
        if (status.netKeyIndex !== NET_KEY_INDEX || status.appKeyIndex !== APP_KEY_INDEX) {
          throw new Error("Config AppKey Status does not match the request");
        }
        return status;
      },
      destination
    );
  }

  private sendDevKeyAndWait<T>(
    destination: number,
    payload: Uint8Array,
    opcode: Uint8Array,
    parser: (data: Uint8Array) => T,
    matcher?: RawStatusMatcher
  ) {
    return this.sendAndWait(
      "DevKeySend",
      [BLUEZ_APPLICATION_PATHS.element, destination, true, NET_KEY_INDEX, [], Array.from(payload)],
      opcode,
      parser,
      destination,
      matcher
    );
  }

  private sendLocalDevKeyAndWait<T>(
    payload: Uint8Array,
    opcode: Uint8Array,
    parser: (data: Uint8Array) => T
  ) {
    return this.sendAndWait(
      "DevKeySend",
      [BLUEZ_APPLICATION_PATHS.element, PROVISIONER_ADDRESS, true, NET_KEY_INDEX, [], Array.from(payload)],
      opcode,
      parser,
      PROVISIONER_ADDRESS
    );
  }

  private async sendAndWait<T>(
    method: string,
    args: unknown[],
    opcode: Uint8Array,
    parser: (data: Uint8Array) => T,
    expectedSource?: number,
    matcher?: RawStatusMatcher
  ) {
    const response = waitForDevKeyStatus(this.application, opcode, parser, this.responseTimeoutMs, expectedSource, matcher);
    try {
      await this.transport.call(BLUEZ_SERVICE, this.nodePath, NODE_INTERFACE, method, args);
    } catch (error) {
      response.cancel();
      throw error;
    }
    return response.promise;
  }
}

function waitForDevKeyStatus<T>(
  application: EventEmitter,
  opcode: Uint8Array,
  parser: (data: Uint8Array) => T,
  timeoutMs: number,
  expectedSource?: number,
  matcher?: RawStatusMatcher
) {
  let settled = false;
  let rejectPromise: (error: Error) => void = () => undefined;
  const cleanup = () => {
    clearTimeout(timeout);
    application.off("devKeyMessageReceived", onMessage);
  };
  const onMessage = (event: { source: number; data: Uint8Array }) => {
    if ((expectedSource !== undefined && event.source !== expectedSource) || !startsWithOpcode(event.data, opcode)) return;
    if (matcher && !matcher(event.data)) return;
    try {
      const result = parser(event.data);
      settled = true;
      cleanup();
      resolvePromise(result);
    } catch (error) {
      settled = true;
      cleanup();
      rejectPromise(error instanceof Error ? error : new Error("Invalid Config status"));
    }
  };
  let resolvePromise: (result: T) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectPromise(new Error("Bluetooth Mesh Config response timed out"));
  }, timeoutMs);
  application.on("devKeyMessageReceived", onMessage);
  return {
    promise,
    cancel: () => {
      if (settled) return;
      settled = true;
      cleanup();
      promise.catch(() => undefined);
      rejectPromise(new Error("Bluetooth Mesh Config request cancelled"));
    }
  };
}

function createModelSubscriptionStatusMatcher(expected: {
  elementAddress: number;
  groupAddress: number;
  modelId: number;
}): RawStatusMatcher {
  return (data) => {
    if (data.length < 9) return false;
    const offset = CONFIG_OPCODES.modelSubscriptionStatus.length;
    return (
      readUint16Le(data, offset + 1) === expected.elementAddress &&
      readUint16Le(data, offset + 3) === expected.groupAddress &&
      readUint16Le(data, offset + 5) === expected.modelId
    );
  };
}

function readUint16Le(data: Uint8Array, offset: number) {
  return data[offset] | (data[offset + 1] << 8);
}

function errorChainIncludes(error: unknown, text: string): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message.includes(text)) return true;
  return errorChainIncludes(error.cause, text);
}
