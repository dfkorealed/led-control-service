import { describe, expect, it } from "vitest";
import { BioDirectUsbConnection } from "./bio-direct-usb-connection";
import type { BioUsbDescriptor, BioUsbDeviceHandle, BioUsbDriver } from "./node-usb-driver";

const descriptor: BioUsbDescriptor = {
  idVendor: 0x1a86,
  idProduct: 0x5523,
  busNumber: 1,
  deviceAddress: 2,
  interfaceNumber: 0,
  bulkOutAddress: 0x02,
  bulkInAddress: 0x82,
  maxPacketSize: 32
};

type FailurePoint =
  | "open"
  | "detachKernelDriver"
  | "claim"
  | `control-${number}`
  | "startInput"
  | "stopInput"
  | "release"
  | "reattachKernelDriver"
  | "close";

class FakeHandle implements BioUsbDeviceHandle {
  readonly calls: Array<[string, ...unknown[]]> = [];
  readonly controlCalls: Array<[string, ...number[]]> = [];
  currentDescriptor = { ...descriptor };
  descriptorAfterInitialization?: BioUsbDescriptor;
  failure?: FailurePoint;
  readonly failures = new Set<FailurePoint>();
  private controlIndex = 0;
  private descriptorIndex = 0;
  private inputListener?: (bytes: Buffer) => void;
  private inputError?: (error: Error) => void;

  descriptor(): BioUsbDescriptor {
    this.descriptorIndex += 1;
    this.calls.push(["descriptor"]);
    return { ...(this.descriptorIndex > 1 && this.descriptorAfterInitialization
      ? this.descriptorAfterInitialization
      : this.currentDescriptor) };
  }
  open(): void {
    this.calls.push(["open"]);
    this.fail("open");
  }
  detachKernelDriver(): boolean {
    this.calls.push(["detachKernelDriver"]);
    this.fail("detachKernelDriver");
    return true;
  }
  claim(): void {
    this.calls.push(["claim"]);
    this.fail("claim");
  }
  async controlOut(request: number, value: number, index: number): Promise<void> {
    this.controlIndex += 1;
    this.calls.push(["controlOut", request, value, index]);
    this.controlCalls.push(["controlOut", request, value, index]);
    this.fail(`control-${this.controlIndex}`);
  }
  async controlIn(request: number, value: number, index: number, length: number): Promise<Buffer> {
    this.controlIndex += 1;
    this.calls.push(["controlIn", request, value, index, length]);
    this.controlCalls.push(["controlIn", request, value, index, length]);
    this.fail(`control-${this.controlIndex}`);
    return Buffer.alloc(length);
  }
  async transferOut(bytes: Uint8Array): Promise<void> {
    this.calls.push(["transferOut", Buffer.from(bytes)]);
  }
  startInput(listener: (bytes: Buffer) => void, onError: (error: Error) => void): void {
    this.calls.push(["startInput"]);
    this.inputListener = listener;
    this.inputError = onError;
    this.fail("startInput");
  }
  async stopInput(): Promise<void> {
    this.calls.push(["stopInput"]);
    this.fail("stopInput");
  }
  async release(): Promise<void> {
    this.calls.push(["release"]);
    this.fail("release");
  }
  reattachKernelDriver(): void {
    this.calls.push(["reattachKernelDriver"]);
    this.fail("reattachKernelDriver");
  }
  close(): void {
    this.calls.push(["close"]);
    this.fail("close");
  }
  emit(bytes: Buffer): void { this.inputListener?.(bytes); }
  emitError(error: Error): void { this.inputError?.(error); }
  count(name: string): number { return this.calls.filter(([call]) => call === name).length; }
  private fail(point: FailurePoint): void {
    if (this.failure === point || this.failures.has(point)) throw new Error(`failed at ${point}`);
  }
}

class FakeDriver implements BioUsbDriver {
  constructor(readonly handle: FakeHandle) {}
  findExactDevice(): BioUsbDeviceHandle { return this.handle; }
}

const createConnection = (handle = new FakeHandle()) => ({
  connection: new BioDirectUsbConnection(new FakeDriver(handle)),
  handle
});

describe("BioDirectUsbConnection", () => {
  it.each([
    ["vendor", { idVendor: 0xffff }],
    ["product", { idProduct: 0xffff }],
    ["interface", { interfaceNumber: 1 }],
    ["bulk OUT endpoint", { bulkOutAddress: 0x01 }],
    ["bulk IN endpoint", { bulkInAddress: 0x81 }],
    ["max packet", { maxPacketSize: 64 }]
  ] as const)("fails closed on a mismatched %s descriptor before claiming USB", async (_name, change) => {
    const { connection, handle } = createConnection();
    Object.assign(handle.currentDescriptor, change);

    await expect(connection.open()).rejects.toMatchObject({ code: "USB_IDENTITY" });
    expect(handle.calls).toEqual([["descriptor"]]);
  });

  it("runs the exact Android CH34x initialization before polling", async () => {
    const { connection, handle } = createConnection();

    await connection.open();

    expect(handle.controlCalls).toEqual([
      ["controlOut", 0xa1, 0x0000, 0x0000],
      ["controlIn", 0x5f, 0x0000, 0x0000, 2],
      ["controlOut", 0x9a, 0x1312, 0xd982],
      ["controlOut", 0x9a, 0x0f2c, 0x0004],
      ["controlIn", 0x95, 0x2518, 0x0000, 2],
      ["controlOut", 0x9a, 0x2727, 0x0000],
      ["controlOut", 0xa4, 0x00ff, 0x0000],
      ["controlOut", 0xa1, 0xc39c, 0xcc8b]
    ]);
    expect(handle.calls.map(([call]) => call)).toEqual([
      "descriptor", "open", "detachKernelDriver", "claim",
      ...Array.from({ length: 8 }, (_, index) => index === 1 || index === 4 ? "controlIn" : "controlOut"),
      "descriptor", "startInput"
    ]);

    await connection.close();
  });

  it("forwards output and input bytes through the byte-connection contract", async () => {
    const { connection, handle } = createConnection();
    const received: Buffer[] = [];
    const disconnected: Error[] = [];
    connection.onData((bytes) => received.push(bytes));
    connection.onDisconnect((error) => disconnected.push(error));
    await connection.open();

    await connection.write(Buffer.from("55aa", "hex"));
    handle.emit(Buffer.from("0102", "hex"));
    handle.emitError(new Error("poll failed"));
    handle.emitError(new Error("duplicate poll failure"));

    expect(handle.calls).toContainEqual(["transferOut", Buffer.from("55aa", "hex")]);
    expect(received).toEqual([Buffer.from("0102", "hex")]);
    expect(disconnected).toHaveLength(1);
    expect(disconnected[0].message).toBe("poll failed");
    await connection.close();
  });

  it("preserves input delivered synchronously while native polling starts", async () => {
    const { connection, handle } = createConnection();
    const received: Buffer[] = [];
    connection.onData((bytes) => received.push(bytes));
    handle.startInput = (listener, onError) => {
      handle.calls.push(["startInput"]);
      listener(Buffer.from("55aa03", "hex"));
      void onError;
    };

    await connection.open();

    expect(received).toEqual([Buffer.from("55aa03", "hex")]);
    await connection.close();
  });

  it.each(["open", "detachKernelDriver", "claim"] as const)("bounds reverse cleanup once when %s fails", async (failure) => {
    const { connection, handle } = createConnection();
    handle.failure = failure;

    await expect(connection.open()).rejects.toThrow(`failed at ${failure}`);
    await expect(connection.close()).resolves.toBeUndefined();

    expect(handle.count("close")).toBe(1);
    expect(handle.count("release")).toBe(failure === "claim" ? 0 : 0);
    expect(handle.count("reattachKernelDriver")).toBe(failure === "claim" ? 1 : failure === "detachKernelDriver" ? 1 : 0);
  });

  it.each(Array.from({ length: 8 }, (_, index) => `control-${index + 1}` as FailurePoint))(
    "releases, reattaches and closes once when %s fails",
    async (failure) => {
      const { connection, handle } = createConnection();
      handle.failure = failure;

      await expect(connection.open()).rejects.toThrow(`failed at ${failure}`);
      await expect(connection.close()).resolves.toBeUndefined();

      expect(handle.count("stopInput")).toBe(0);
      expect(handle.count("release")).toBe(1);
      expect(handle.count("reattachKernelDriver")).toBe(1);
      expect(handle.count("close")).toBe(1);
    }
  );

  it("stops a partially started poll before releasing after poll startup fails", async () => {
    const { connection, handle } = createConnection();
    handle.failure = "startInput";

    await expect(connection.open()).rejects.toThrow("failed at startInput");
    await expect(connection.close()).resolves.toBeUndefined();

    expect(handle.calls.slice(-4).map(([call]) => call)).toEqual([
      "stopInput", "release", "reattachKernelDriver", "close"
    ]);
    for (const name of ["stopInput", "release", "reattachKernelDriver", "close"]) expect(handle.count(name)).toBe(1);
  });

  it("preserves an identity failure while retaining every cleanup failure as its cause", async () => {
    const { connection, handle } = createConnection();
    handle.descriptorAfterInitialization = { ...descriptor, bulkInAddress: 0x81 };
    handle.failures.add("release");
    handle.failures.add("close");

    const failure = await connection.open().catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "USB_IDENTITY", cause: expect.any(AggregateError) });
    if (!(failure instanceof Error) || !(failure.cause instanceof AggregateError)) throw new Error("Expected aggregated USB failure");
    expect((failure.cause as AggregateError).errors.map((error) => (error as Error).message)).toEqual([
      "BIO USB bulkInAddress mismatch",
      "failed at release",
      "failed at close"
    ]);
    expect(handle.count("release")).toBe(1);
    expect(handle.count("reattachKernelDriver")).toBe(1);
    expect(handle.count("close")).toBe(1);
  });

  it.each(["stopInput", "release", "reattachKernelDriver", "close"] as const)(
    "continues bounded reverse cleanup and reports a %s failure",
    async (failure) => {
      const { connection, handle } = createConnection();
      await connection.open();
      handle.failure = failure;

      await expect(connection.close()).rejects.toMatchObject({ code: "CLOSE_FAILED" });
      await expect(connection.close()).rejects.toMatchObject({ code: "CLOSE_FAILED" });

      for (const name of ["stopInput", "release", "reattachKernelDriver", "close"]) expect(handle.count(name)).toBe(1);
    }
  );
});
