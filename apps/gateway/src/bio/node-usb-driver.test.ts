import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { NodeUsbDriver, type LegacyUsbApi, type LegacyUsbDevice } from "./node-usb-driver";

class FakeEndpoint extends EventEmitter {
  readonly descriptor: { bEndpointAddress: number; bmAttributes: number; wMaxPacketSize: number };
  pollActive = false;
  endOnStop = true;
  readonly startPoll = vi.fn(() => { this.pollActive = true; });
  readonly stopPoll = vi.fn((callback?: (error?: Error) => void) => {
    if (!this.pollActive) throw new Error("Polling is not active.");
    this.pollActive = false;
    if (callback) this.once("end", callback);
    if (this.endOnStop) this.emit("end");
  });
  readonly transfer = vi.fn((_bytes: Buffer, callback: (error?: Error) => void) => callback());
  constructor(address: number, packetSize = 32) {
    super();
    this.descriptor = { bEndpointAddress: address, bmAttributes: 2, wMaxPacketSize: packetSize };
  }
  nativePollFailure(error: Error, finish = true): void {
    this.emit("error", error);
    this.pollActive = false;
    if (finish) this.emit("end");
  }
}

function fakeDevice(idVendor = 0x1a86, idProduct = 0x5523) {
  const input = new FakeEndpoint(0x82);
  const output = new FakeEndpoint(0x02);
  const usbInterface = {
    endpoints: [output, input],
    isKernelDriverActive: vi.fn(() => true),
    detachKernelDriver: vi.fn(),
    attachKernelDriver: vi.fn(),
    claim: vi.fn(),
    release: vi.fn((_closeEndpoints: boolean, callback: (error?: Error) => void) => callback())
  };
  const device = {
    deviceDescriptor: { idVendor, idProduct },
    busNumber: 7,
    deviceAddress: 11,
    allConfigDescriptors: [{ interfaces: [[{
      bInterfaceNumber: 0,
      endpoints: [output.descriptor, input.descriptor]
    }]] }],
    timeout: 0,
    open: vi.fn(),
    close: vi.fn(),
    interface: vi.fn(() => usbInterface),
    controlTransfer: vi.fn((
      _requestType: number,
      _request: number,
      _value: number,
      _index: number,
      dataOrLength: Buffer | number,
      callback: (error: Error | null | undefined, data?: Buffer) => void
    ) => callback(undefined, typeof dataOrLength === "number" ? Buffer.alloc(dataOrLength) : undefined))
  } satisfies LegacyUsbDevice;
  return { device, input, output, usbInterface };
}

const api = (...devices: LegacyUsbDevice[]): LegacyUsbApi => ({ getDeviceList: () => devices });

describe("NodeUsbDriver", () => {
  it.each([
    ["no device", []],
    ["only another VID", [fakeDevice(0x1234).device]],
    ["only another PID", [fakeDevice(0x1a86, 0x1234).device]],
    ["two matching devices", [fakeDevice().device, fakeDevice().device]]
  ] as const)("fails exact-one selection for %s", (_name, devices) => {
    expect(() => new NodeUsbDriver(api(...devices)).findExactDevice()).toThrowError(expect.objectContaining({ code: "USB_IDENTITY" }));
  });

  it("exposes the selected physical descriptor and exact bulk topology", () => {
    const { device } = fakeDevice();
    const handle = new NodeUsbDriver(api(device)).findExactDevice();

    expect(handle.descriptor()).toEqual({
      idVendor: 0x1a86,
      idProduct: 0x5523,
      busNumber: 7,
      deviceAddress: 11,
      interfaceNumber: 0,
      bulkOutAddress: 0x02,
      bulkInAddress: 0x82,
      maxPacketSize: 32
    });
  });

  it("revalidates topology from active interface endpoints after open", () => {
    const { device, input, usbInterface } = fakeDevice();
    usbInterface.endpoints = [input];
    const handle = new NodeUsbDriver(api(device)).findExactDevice();

    expect(handle.descriptor().bulkOutAddress).toBe(0x02);
    handle.open();

    expect(handle.descriptor()).toMatchObject({
      interfaceNumber: 0,
      bulkOutAddress: -1,
      bulkInAddress: 0x82,
      maxPacketSize: -1
    });
  });

  it("uses vendor device control transfers and requires the full IN length", async () => {
    const { device } = fakeDevice();
    const handle = new NodeUsbDriver(api(device), { transferTimeoutMs: 417 }).findExactDevice();
    handle.open();

    await handle.controlOut(0xa1, 0xc39c, 0xcc8b);
    await expect(handle.controlIn(0x5f, 0, 0, 2)).resolves.toEqual(Buffer.alloc(2));

    expect(device.timeout).toBe(417);
    expect(device.controlTransfer.mock.calls[0].slice(0, 5)).toEqual([0x40, 0xa1, 0xc39c, 0xcc8b, Buffer.alloc(0)]);
    expect(device.controlTransfer.mock.calls[1].slice(0, 5)).toEqual([0xc0, 0x5f, 0, 0, 2]);

    device.controlTransfer.mockImplementationOnce((_type, _request, _value, _index, _length, callback) => callback(undefined, Buffer.alloc(1)));
    await expect(handle.controlIn(0x95, 0x2518, 0, 2)).rejects.toThrow("expected 2 bytes");
  });

  it("claims interface zero and binds only the validated bulk endpoints", async () => {
    const { device, input, output, usbInterface } = fakeDevice();
    const handle = new NodeUsbDriver(api(device)).findExactDevice();
    const chunks: Buffer[] = [];
    const errors: Error[] = [];
    handle.open();

    expect(handle.detachKernelDriver()).toBe(true);
    handle.claim();
    handle.startInput((bytes) => chunks.push(bytes), (error) => errors.push(error));
    input.emit("data", Buffer.from("0102", "hex"));
    input.emit("error", new Error("poll failed"));
    await handle.transferOut(Buffer.from("0304", "hex"));
    await handle.stopInput();
    await handle.release();
    handle.reattachKernelDriver();
    handle.close();

    expect(device.interface).toHaveBeenCalledWith(0);
    expect(usbInterface.detachKernelDriver).toHaveBeenCalledTimes(1);
    expect(usbInterface.claim).toHaveBeenCalledTimes(1);
    expect(input.startPoll).toHaveBeenCalledWith(1, 32);
    expect(chunks).toEqual([Buffer.from("0102", "hex")]);
    expect(errors).toHaveLength(1);
    expect(output.transfer).toHaveBeenCalledWith(Buffer.from("0304", "hex"), expect.any(Function));
    expect(input.stopPoll).toHaveBeenCalledTimes(1);
    expect(usbInterface.release).toHaveBeenCalledWith(true, expect.any(Function));
    expect(usbInterface.attachKernelDriver).toHaveBeenCalledTimes(1);
    expect(device.close).toHaveBeenCalledTimes(1);
  });

  it("recognizes a native error/end auto-stop without calling stopPoll again", async () => {
    const { device, input } = fakeDevice();
    const handle = new NodeUsbDriver(api(device)).findExactDevice();
    const errors: Error[] = [];
    handle.open();
    handle.startInput(() => {}, (error) => errors.push(error));

    input.nativePollFailure(new Error("recoverable input failure"));

    await expect(handle.stopInput()).resolves.toBeUndefined();
    expect(errors.map(({ message }) => message)).toEqual(["recoverable input failure"]);
    expect(input.stopPoll).not.toHaveBeenCalled();
    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("error")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
  });

  it("awaits a native auto-stop already in progress and settles concurrent cleanup once", async () => {
    const { device, input } = fakeDevice();
    const handle = new NodeUsbDriver(api(device)).findExactDevice();
    handle.open();
    handle.startInput(() => {}, () => {});
    input.nativePollFailure(new Error("recoverable input failure"), false);
    let settled = 0;

    const first = handle.stopInput().then(() => { settled += 1; });
    const second = handle.stopInput().then(() => { settled += 1; });
    await Promise.resolve();
    expect(settled).toBe(0);
    expect(input.stopPoll).not.toHaveBeenCalled();

    input.emit("end");
    await Promise.all([first, second]);
    expect(settled).toBe(2);
    expect(input.stopPoll).not.toHaveBeenCalled();
    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("error")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
  });

  it("preserves a genuine stopPoll failure while cleaning listeners once", async () => {
    const { device, input } = fakeDevice();
    input.stopPoll.mockImplementation(() => { throw new Error("native stop failed"); });
    const handle = new NodeUsbDriver(api(device)).findExactDevice();
    handle.open();
    handle.startInput(() => {}, () => {});

    const first = handle.stopInput();
    const second = handle.stopInput();

    await expect(first).rejects.toThrow("native stop failed");
    await expect(second).rejects.toThrow("native stop failed");
    expect(input.stopPoll).toHaveBeenCalledTimes(1);
    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("error")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
  });

  it("settles callback wrappers once when a native callback fires twice", async () => {
    const { device, input, output, usbInterface } = fakeDevice();
    device.controlTransfer.mockImplementation((_type, _request, _value, _index, dataOrLength, callback) => {
      callback(undefined, typeof dataOrLength === "number" ? Buffer.alloc(dataOrLength) : undefined);
      callback(new Error("late control error"));
    });
    output.transfer.mockImplementation((_bytes, callback) => { callback(); callback(new Error("late output error")); });
    input.stopPoll.mockImplementation((callback) => {
      if (!callback) throw new Error("Expected stop callback");
      callback();
      callback(new Error("late poll error"));
    });
    usbInterface.release.mockImplementation((_closeEndpoints, callback) => { callback(); callback(new Error("late release error")); });
    const handle = new NodeUsbDriver(api(device)).findExactDevice();
    handle.open();
    handle.claim();
    handle.startInput(() => {}, () => {});

    await expect(handle.controlOut(0xa1, 0, 0)).resolves.toBeUndefined();
    await expect(handle.controlIn(0x5f, 0, 0, 2)).resolves.toEqual(Buffer.alloc(2));
    await expect(handle.transferOut(Buffer.from([1]))).resolves.toBeUndefined();
    await expect(handle.stopInput()).resolves.toBeUndefined();
    await expect(handle.release()).resolves.toBeUndefined();
  });
});
