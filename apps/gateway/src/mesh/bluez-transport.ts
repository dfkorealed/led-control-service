import { systemBus, type DBusInterface, type MessageBus } from "@homebridge/dbus-native";

type DbusMethod = (...args: unknown[]) => Promise<unknown>;

export interface DbusBus {
  getInterface(service: string, path: string, interfaceName: string): Promise<Record<string, unknown>>;
  disconnect?(): void;
}

export type DbusBusFactory = () => DbusBus;

function createNativeSystemBus(): DbusBus {
  const bus = systemBus();
  return {
    getInterface: (service, path, interfaceName) => getNativeInterface(bus, service, path, interfaceName),
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

      return (await (dbusMethod as DbusMethod)(...args)) as T;
    } catch (cause) {
      throw new BluezTransportError(
        `BlueZ D-Bus call failed: ${interfaceName}.${method}`,
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
