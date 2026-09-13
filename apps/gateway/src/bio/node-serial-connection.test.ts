import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { NodeSerialConnection, type SerialPortDevice, type SerialDeviceOptions } from "./node-serial-connection";

class Device extends EventEmitter implements SerialPortDevice {
  isOpen = false;
  writes: Buffer[] = [];
  error?: Error;
  bufferedInput?: Buffer;
  open(callback: (error?: Error | null) => void) { this.isOpen = !this.error; callback(this.error); }
  write(bytes: Buffer, callback: (error?: Error | null) => void) {
    this.writes.push(bytes);
    if (this.bufferedInput) this.emit("data", this.bufferedInput);
    callback(this.error); return true;
  }
  flush(callback: (error?: Error | null) => void) { this.bufferedInput = undefined; callback(this.error); }
  drain(callback: (error?: Error | null) => void) { callback(this.error); }
  close(callback: (error?: Error | null) => void) { this.isOpen = false; this.emit("close"); callback(); }
}

describe("NodeSerialConnection", () => {
  it("opens exclusive 115200 8N1 without flow control and transfers raw stream chunks", async () => {
    const device = new Device();
    let options: SerialDeviceOptions | undefined;
    const connection = new NodeSerialConnection("/dev/bio-dongle", (value) => { options = value; return device; });
    const received: string[] = [];
    const unsubscribe = connection.onData((bytes) => received.push(bytes.toString("hex")));
    await connection.open();
    expect(options).toEqual({ path: "/dev/bio-dongle", baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none", rtscts: false, xon: false, xoff: false, xany: false, autoOpen: false, lock: true });
    await connection.write(Buffer.from("55aa82000000", "hex"));
    expect(device.writes).toEqual([Buffer.from("55aa82000000", "hex")]);
    device.emit("data", Buffer.from("55aa", "hex"));
    unsubscribe();
    device.emit("data", Buffer.from("83", "hex"));
    expect(received).toEqual(["55aa"]);
    await connection.close();
    expect(device.isOpen).toBe(false);
  });
  it("propagates device open/write errors and disconnect events", async () => {
    const device = new Device();
    const connection = new NodeSerialConnection("/dev/bio-dongle", () => device);
    device.error = new Error("unplugged");
    await expect(connection.open()).rejects.toThrow("unplugged");
    device.error = undefined;
    await connection.open();
    device.error = new Error("write failed");
    await expect(connection.write(Buffer.from([1]))).rejects.toThrow("write failed");
    const errors: string[] = [];
    const unsubscribe = connection.onDisconnect((error) => errors.push(error.message));
    device.emit("error", new Error("lost"));
    device.emit("close");
    unsubscribe();
    device.emit("close");
    expect(errors).toEqual(["lost", "Serial connection closed"]);
  });
  it("discards old kernel-buffered input before a fresh generation can send its probe", async () => {
    const device = new Device();
    device.bufferedInput = Buffer.from("475383007c", "hex");
    const connection = new NodeSerialConnection("/dev/bio-dongle", () => device);
    const received: Buffer[] = [];
    connection.onData((bytes) => received.push(bytes));
    await connection.open();
    await connection.write(Buffer.from("4753820000", "hex"));
    expect(received).toEqual([]);
    await connection.close();
  });
  it("preserves kernel-buffered power-on info when explicitly requested", async () => {
    const device = new Device();
    device.bufferedInput = Buffer.from("55aa030c02050320682f0000000300001147", "hex");
    const connection = new NodeSerialConnection("/dev/bio-dongle", () => device);
    const received: string[] = [];
    connection.onData((bytes) => received.push(bytes.toString("hex")));
    await connection.open({ preserveInput: true });
    // Simulate native delivery of queued input without issuing a serial write.
    if (device.bufferedInput) device.emit("data", device.bufferedInput);
    expect(received).toEqual(["55aa030c02050320682f0000000300001147"]);
    expect(device.writes).toEqual([]);
    await connection.close();
  });
  it("waits for a pending native open before closing the descriptor once", async () => {
    const device = new Device();
    let finishOpen!: () => void;
    device.open = (callback) => { finishOpen = () => { device.isOpen = true; callback(); }; };
    const connection = new NodeSerialConnection("/dev/bio-dongle", () => device);
    const opening = connection.open();
    let closed = false;
    const closing = connection.close().then(() => { closed = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(closed).toBe(false);
    finishOpen(); await opening; await closing;
    expect(device.isOpen).toBe(false);
  });
  it("shares an ongoing close when retirement and late open cleanup overlap", async () => {
    const device = new Device();
    const connection = new NodeSerialConnection("/dev/bio-dongle", () => device);
    await connection.open();
    const callbacks: (() => void)[] = [];
    device.close = (callback) => { callbacks.push(() => { device.isOpen = false; callback(); }); };
    const first = connection.close(); const second = connection.close();
    await Promise.resolve(); await Promise.resolve();
    expect(callbacks).toHaveLength(1);
    callbacks[0](); await first; await second;
    expect(device.isOpen).toBe(false);
  });

  it("preserves native close failure while descriptor ownership remains open", async () => {
    const device = new Device();
    const connection = new NodeSerialConnection("/dev/bio-dongle", () => device);
    await connection.open();
    device.close = (callback) => { callback(new Error("descriptor still open")); };
    await expect(connection.close()).rejects.toThrow("descriptor still open");
    expect(device.isOpen).toBe(true);
    await expect(connection.close()).rejects.toThrow("descriptor still open");
    expect(device.isOpen).toBe(true);
  });
});
