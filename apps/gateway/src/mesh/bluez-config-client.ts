import type { EventEmitter } from "node:events";
import { BLUEZ_APPLICATION_PATHS } from "./bluez-dbus-application";
import {
  CONFIG_OPCODES,
  encodeCompositionDataGet,
  encodeModelAppBind,
  encodeModelPublicationSet,
  parseAppKeyStatus,
  parseCompositionDataStatus,
  parseModelAppStatus,
  parseModelPublicationStatus,
  startsWithOpcode
} from "./bluez-config-codec";

const BLUEZ_SERVICE = "org.bluez.mesh";
const NODE_INTERFACE = "org.bluez.mesh.Node1";
const MANAGEMENT_INTERFACE = "org.bluez.mesh.Management1";
const NET_KEY_INDEX = 0;
const APP_KEY_INDEX = 0;
const PROVISIONER_ADDRESS = 0x0001;
const SERVER_MODELS = [0x1000, 0x1300] as const;

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

  constructor(
    private readonly transport: ConfigTransport,
    private readonly application: EventEmitter,
    private readonly nodePath: string,
    options: { responseTimeoutMs?: number } = {}
  ) {
    this.responseTimeoutMs = options.responseTimeoutMs ?? 10_000;
  }

  async configureNode(input: { unicast: number; elementCount: number }): Promise<NodeComposition> {
    await this.ensureLocalAppKey();
    await this.sendAndWait(
      "AddAppKey",
      [BLUEZ_APPLICATION_PATHS.element, input.unicast, APP_KEY_INDEX, NET_KEY_INDEX, false],
      CONFIG_OPCODES.appKeyStatus,
      parseAppKeyStatus
    );
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
          modelId
        }),
        CONFIG_OPCODES.modelPublicationStatus,
        parseModelPublicationStatus
      );
      if (status.elementAddress !== input.unicast || status.modelId !== modelId || status.publishAddress !== PROVISIONER_ADDRESS) {
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

  private async ensureLocalAppKey() {
    try {
      await this.transport.call(BLUEZ_SERVICE, this.nodePath, MANAGEMENT_INTERFACE, "CreateAppKey", [NET_KEY_INDEX, APP_KEY_INDEX]);
    } catch (error) {
      if (!errorChainIncludes(error, "AlreadyExists")) throw error;
    }
  }

  private sendDevKeyAndWait<T>(
    destination: number,
    payload: Uint8Array,
    opcode: Uint8Array,
    parser: (data: Uint8Array) => T
  ) {
    return this.sendAndWait(
      "DevKeySend",
      [BLUEZ_APPLICATION_PATHS.element, destination, true, NET_KEY_INDEX, [], Array.from(payload)],
      opcode,
      parser,
      destination
    );
  }

  private async sendAndWait<T>(
    method: string,
    args: unknown[],
    opcode: Uint8Array,
    parser: (data: Uint8Array) => T,
    expectedSource?: number
  ) {
    const response = waitForDevKeyStatus(this.application, opcode, parser, this.responseTimeoutMs, expectedSource);
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
  expectedSource?: number
) {
  let settled = false;
  let rejectPromise: (error: Error) => void = () => undefined;
  const cleanup = () => {
    clearTimeout(timeout);
    application.off("devKeyMessageReceived", onMessage);
  };
  const onMessage = (event: { source: number; data: Uint8Array }) => {
    if ((expectedSource !== undefined && event.source !== expectedSource) || !startsWithOpcode(event.data, opcode)) return;
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

function errorChainIncludes(error: unknown, text: string): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message.includes(text)) return true;
  return errorChainIncludes(error.cause, text);
}
