import type { EventEmitter } from "node:events";
import { SerialPort } from "serialport";
export interface SerialConnection {
  open(): Promise<void>;
  write(bytes: Buffer): Promise<void>;
  close(): Promise<void>;
  onData(listener: (bytes: Buffer) => void): () => void;
  onDisconnect(listener: (error: Error) => void): () => void;
}
export interface SerialDeviceOptions {
  path: string; baudRate: 115200; dataBits: 8; stopBits: 1; parity: "none";
  rtscts: false; xon: false; xoff: false; xany: false; autoOpen: false; lock: true;
}
export interface SerialPortDevice extends EventEmitter {
  isOpen: boolean;
  open(callback: (error?: Error | null) => void): void;
  write(bytes: Buffer, callback: (error?: Error | null) => void): unknown;
  drain(callback: (error?: Error | null) => void): void;
  flush(callback: (error?: Error | null) => void): void;
  close(callback: (error?: Error | null) => void): void;
}
export class NodeSerialConnection implements SerialConnection {
  private readonly device: SerialPortDevice;
  private readonly disconnectListeners = new Set<(error: Error) => void>();
  private opening?: Promise<void>;
  private closing?: Promise<void>;

  constructor(path: string, factory: (options: SerialDeviceOptions) => SerialPortDevice = (options) => new SerialPort(options)) {
    this.device = factory({ path, baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none", rtscts: false, xon: false, xoff: false, xany: false, autoOpen: false, lock: true });
    // Keep an error listener for the device lifetime: an error after retirement
    // must never become an uncaught EventEmitter error in the gateway process.
    this.device.on("error", (error: Error) => this.disconnected(error));
    this.device.on("close", () => this.disconnected(new Error("Serial connection closed")));
  }
  open(): Promise<void> {
    this.opening = this.openAndFlush();
    return this.opening;
  }
  private async openAndFlush(): Promise<void> {
    await this.callback((done) => this.device.open(done));
    // A new JS generation also needs to discard bytes buffered by the old
    // serial session before the read-only protocol probe is sent.
    await this.callback((done) => this.device.flush(done));
  }
  async write(bytes: Buffer): Promise<void> {
    await this.callback((done) => this.device.write(bytes, done));
    await this.callback((done) => this.device.drain(done));
  }
  close(): Promise<void> {
    // Retirement can race the native open callback. Share the cleanup promise
    // so that the late-open path cannot close the same descriptor twice.
    this.closing ??= this.closeAfterOpen();
    return this.closing;
  }
  private async closeAfterOpen(): Promise<void> {
    await this.opening?.catch(() => {});
    if (this.device.isOpen) await this.callback((done) => this.device.close(done));
  }
  onData(listener: (bytes: Buffer) => void): () => void {
    this.device.on("data", listener);
    return () => { this.device.off("data", listener); };
  }
  onDisconnect(listener: (error: Error) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => { this.disconnectListeners.delete(listener); };
  }
  private disconnected(error: Error) {
    for (const listener of this.disconnectListeners) listener(error);
  }
  private callback(operation: (done: (error?: Error | null) => void) => unknown): Promise<void> {
    return new Promise((resolve, reject) => operation((error) => error ? reject(error) : resolve()));
  }
}
