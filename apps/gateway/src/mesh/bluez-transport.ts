import * as dbusNative from "@homebridge/dbus-native";
import type { DBusInterface, MessageBus } from "@homebridge/dbus-native";

type DbusCallback = (error: unknown, ...values: unknown[]) => void;
type DbusMethod = (...args: [...unknown[], DbusCallback]) => unknown;

interface NativeDbusMessage {
  type?: number;
  flags?: number;
  serial?: number;
  replySerial?: number;
  signature?: string;
  body?: unknown[];
  [key: string]: unknown;
}

interface NativeConnectionWithMessage {
  message(message: NativeDbusMessage): void;
  stream: { destroy(): void };
  state?: string;
  once(event: "connect", listener: () => void): void;
  prependListener(event: "message", listener: (message: NativeDbusMessage) => void): void;
}

interface NativeExportMessageBus extends MessageBus {
  exportInterface(implementation: Record<string, unknown>, path: string, definition: unknown): void;
}

export function normalizeDbusMethodReturn<T extends NativeDbusMessage>(message: T): T {
  if (
    message.type === 2 &&
    message.signature === "qq" &&
    message.body?.length === 1 &&
    Array.isArray(message.body[0]) &&
    message.body[0].length === 2
  ) {
    return { ...message, body: message.body[0] };
  }
  return message;
}

export function installDbusMultiReturnCompatibility(bus: MessageBus) {
  const connection = bus.connection as unknown as NativeConnectionWithMessage;
  const noReplySerials = new Set<number>();

  connection.prependListener("message", (message) => {
    if (message.type === 1 && typeof message.serial === "number" && ((message.flags ?? 0) & 0x01) !== 0) {
      noReplySerials.add(message.serial);
    }
  });

  const wrapCurrentSender = () => {
    const send = connection.message.bind(connection);
    connection.message = (message) => {
      const normalized = normalizeDbusMethodReturn(message);
      if (
        (normalized.type === 2 || normalized.type === 3) &&
        typeof normalized.replySerial === "number" &&
        noReplySerials.delete(normalized.replySerial)
      ) {
        return;
      }
      send(normalized);
    };
  };

  wrapCurrentSender();
  // dbus-native replaces `connection.message` after its async handshake. The
  // compatibility wrapper must therefore be installed again after `connect`.
  if (connection.state !== "connected") connection.once("connect", wrapCurrentSender);
}

export interface DbusBus {
  getInterface(service: string, path: string, interfaceName: string): Promise<Record<string, unknown>>;
  disconnect?(): void;
}

export interface SharedDbusBus extends DbusBus {
  exportInterface(implementation: Record<string, unknown>, path: string, definition: unknown): void;
}

export type DbusBusFactory = () => DbusBus;

export function createNativeSystemBus(): SharedDbusBus {
  const native = dbusNative as unknown as {
    createClient(options: { busAddress: string; ReturnLongjs: boolean }): MessageBus;
  };
  const bus = native.createClient({
    busAddress: process.env.DBUS_SYSTEM_BUS_ADDRESS || "unix:path=/var/run/dbus/system_bus_socket",
    ReturnLongjs: true
  }) as NativeExportMessageBus;
  installDbusMultiReturnCompatibility(bus);
  return {
    getInterface: (service, path, interfaceName) => getNativeInterface(bus, service, path, interfaceName),
    exportInterface: (implementation, path, definition) => bus.exportInterface(implementation, path, definition),
    disconnect: () => bus.connection.stream.destroy()
  };
}

function getNativeInterface(bus: MessageBus, service: string, path: string, interfaceName: string) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    bus.getService(service).getInterface(path, interfaceName, (error, dbusInterface) => {
      if (error || !dbusInterface) {
        reject(error ?? new Error(`D-Bus interface ${interfaceName} is unavailable`));
        return;
      }
      resolve(dbusInterface as DBusInterface & Record<string, unknown>);
    });
  });
}

export class BluezTransportError extends Error {
  readonly code = "BLUEZ_DBUS_ERROR" as const;

  constructor(
    message: string,
    readonly service: string,
    readonly path: string,
    readonly interfaceName: string,
    readonly method: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "BluezTransportError";
  }
}

export class BluezTransport {
  private bus: DbusBus | null = null;

  constructor(private readonly createBus: DbusBusFactory = createNativeSystemBus) {}

  async connect() {
    this.bus ??= this.createBus();
  }

  async call<T>(service: string, path: string, interfaceName: string, method: string, args: unknown[]): Promise<T> {
    try {
      await this.connect();
      const dbusInterface = await this.bus!.getInterface(service, path, interfaceName);
      const dbusMethod = dbusInterface[method];
      if (typeof dbusMethod !== "function") {
        throw new Error(`D-Bus method ${interfaceName}.${method} is unavailable`);
      }

      return (await invokeDbusMethod((dbusMethod as DbusMethod).bind(dbusInterface), args)) as T;
    } catch (cause) {
      const errorDetail = formatDbusErrorDetail(cause);
      const detail = errorDetail ? `: ${errorDetail}` : "";
      throw new BluezTransportError(
        `BlueZ D-Bus call failed: ${interfaceName}.${method}${detail}`,
        service,
        path,
        interfaceName,
        method,
        { cause }
      );
    }
  }

  disconnect() {
    this.bus?.disconnect?.();
    this.bus = null;
  }
}

function invokeDbusMethod(method: DbusMethod, args: unknown[]) {
  return new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, ...values: unknown[]) => {
      if (settled) return;
      settled = true;
      if (error) {
        reject(error);
        return;
      }
      resolve(values.length > 1 ? values : values[0]);
    };
    try {
      const returned = method(...args, finish);
      if (returned && typeof (returned as PromiseLike<unknown>).then === "function") {
        void Promise.resolve(returned).then(
          (value) => finish(null, value),
          (error) => finish(error instanceof Error ? error : new Error(String(error)))
        );
      }
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function formatDbusErrorDetail(cause: unknown) {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  if (!cause || typeof cause !== "object") return "";

  const error = cause as Record<string, unknown>;
  const name = typeof error.name === "string" ? error.name : "";
  const message = typeof error.message === "string" ? error.message : "";
  return [name, message].filter(Boolean).join(": ");
}
