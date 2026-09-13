import { getDeviceList } from "usb";
import { BioUsbError } from "./bio-usb-error";

const BIO_VENDOR_ID = 0x1a86;
const BIO_PRODUCT_ID = 0x5523;
const BIO_INTERFACE = 0;
const BIO_BULK_OUT = 0x02;
const BIO_BULK_IN = 0x82;
const BIO_MAX_PACKET_SIZE = 32;
const USB_TRANSFER_TYPE_MASK = 0x03;
const USB_TRANSFER_TYPE_BULK = 0x02;
const USB_REQUEST_VENDOR_DEVICE_OUT = 0x40;
const USB_REQUEST_VENDOR_DEVICE_IN = 0xc0;

interface LegacyEndpointDescriptor {
  bEndpointAddress: number;
  bmAttributes: number;
  wMaxPacketSize: number;
}
interface LegacyInterfaceDescriptor {
  bInterfaceNumber: number;
  endpoints: LegacyEndpointDescriptor[];
}
interface LegacyEndpoint {
  address?: number;
  descriptor: LegacyEndpointDescriptor;
  timeout?: number;
  on(event: "data", listener: (bytes: Buffer) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  off(event: "data", listener: (bytes: Buffer) => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
}
interface LegacyInEndpoint extends LegacyEndpoint {
  startPoll(nTransfers?: number, transferSize?: number): unknown;
  stopPoll(callback?: (error?: Error) => void): void;
}
interface LegacyOutEndpoint extends LegacyEndpoint {
  transfer(bytes: Buffer, callback?: (error?: Error, actualLength?: number) => void): unknown;
}
interface LegacyUsbInterface {
  interfaceNumber?: number;
  endpoints: LegacyEndpoint[];
  isKernelDriverActive(): boolean;
  detachKernelDriver(): void;
  attachKernelDriver(): void;
  claim(): void;
  release(closeEndpoints?: boolean, callback?: (error?: Error) => void): void;
}

export interface LegacyUsbDevice {
  deviceDescriptor: { idVendor: number; idProduct: number };
  busNumber: number;
  deviceAddress: number;
  allConfigDescriptors: Array<{ interfaces: LegacyInterfaceDescriptor[][] }>;
  timeout: number;
  open(): void;
  close(): void;
  interface(interfaceNumber: number): LegacyUsbInterface;
  controlTransfer(
    requestType: number,
    request: number,
    value: number,
    index: number,
    dataOrLength: Buffer | number,
    callback: (error?: Error | null, data?: Buffer | number) => void
  ): unknown;
}

export interface LegacyUsbApi {
  getDeviceList(): LegacyUsbDevice[];
}

export interface BioUsbDescriptor {
  idVendor: number;
  idProduct: number;
  busNumber: number;
  deviceAddress: number;
  interfaceNumber: number;
  bulkOutAddress: number;
  bulkInAddress: number;
  maxPacketSize: number;
}

export interface BioUsbDeviceHandle {
  descriptor(): BioUsbDescriptor;
  open(): void;
  detachKernelDriver(): boolean;
  claim(): void;
  controlOut(request: number, value: number, index: number): Promise<void>;
  controlIn(request: number, value: number, index: number, length: number): Promise<Buffer>;
  transferOut(bytes: Uint8Array): Promise<void>;
  startInput(listener: (bytes: Buffer) => void, onError: (error: Error) => void): void;
  stopInput(): Promise<void>;
  release(): Promise<void>;
  reattachKernelDriver(): void;
  close(): void;
}

export interface BioUsbDriver {
  findExactDevice(): BioUsbDeviceHandle;
}

export interface NodeUsbDriverOptions {
  transferTimeoutMs?: number;
}

const defaultUsbApi: LegacyUsbApi = {
  getDeviceList: () => getDeviceList() as unknown as LegacyUsbDevice[]
};

export class NodeUsbDriver implements BioUsbDriver {
  private readonly transferTimeoutMs: number;

  constructor(
    private readonly usbApi: LegacyUsbApi = defaultUsbApi,
    options: NodeUsbDriverOptions = {}
  ) {
    this.transferTimeoutMs = options.transferTimeoutMs ?? 300;
    if (!Number.isInteger(this.transferTimeoutMs) || this.transferTimeoutMs < 1 || this.transferTimeoutMs > 2_147_483_647) {
      throw new RangeError("Invalid BIO USB transfer timeout");
    }
  }

  findExactDevice(): BioUsbDeviceHandle {
    const matches = this.usbApi.getDeviceList().filter(({ deviceDescriptor }) =>
      deviceDescriptor.idVendor === BIO_VENDOR_ID && deviceDescriptor.idProduct === BIO_PRODUCT_ID
    );
    if (matches.length !== 1) {
      throw new BioUsbError("USB_IDENTITY", `Expected exactly one BIO USB dongle, found ${matches.length}`);
    }
    return new NodeUsbDeviceHandle(matches[0], this.transferTimeoutMs);
  }
}

class NodeUsbDeviceHandle implements BioUsbDeviceHandle {
  private usbInterface?: LegacyUsbInterface;
  private input?: LegacyInEndpoint;
  private output?: LegacyOutEndpoint;
  private inputListener?: (bytes: Buffer) => void;
  private inputErrorListener?: (error: Error) => void;
  private pollAttempted = false;

  constructor(private readonly device: LegacyUsbDevice, private readonly transferTimeoutMs: number) {}

  descriptor(): BioUsbDescriptor {
    const configuredInterfaces = this.device.allConfigDescriptors.flatMap((configuration) => configuration.interfaces.flat());
    const configuredInterface = configuredInterfaces.find(({ bInterfaceNumber }) => bInterfaceNumber === BIO_INTERFACE) ?? configuredInterfaces[0];
    const interfaceNumber = this.usbInterface?.interfaceNumber ?? (this.usbInterface ? BIO_INTERFACE : configuredInterface?.bInterfaceNumber ?? -1);
    const endpoints = this.usbInterface?.endpoints.map(({ descriptor }) => descriptor) ?? configuredInterface?.endpoints ?? [];
    const bulkEndpoints = endpoints.filter(({ bmAttributes }) =>
      (bmAttributes & USB_TRANSFER_TYPE_MASK) === USB_TRANSFER_TYPE_BULK
    );
    const output = bulkEndpoints.find(({ bEndpointAddress }) => (bEndpointAddress & 0x80) === 0);
    const input = bulkEndpoints.find(({ bEndpointAddress }) => (bEndpointAddress & 0x80) !== 0);
    const maxPacketSize = output && input && output.wMaxPacketSize === input.wMaxPacketSize
      ? output.wMaxPacketSize
      : -1;
    return {
      idVendor: this.device.deviceDescriptor.idVendor,
      idProduct: this.device.deviceDescriptor.idProduct,
      busNumber: this.device.busNumber,
      deviceAddress: this.device.deviceAddress,
      interfaceNumber,
      bulkOutAddress: output?.bEndpointAddress ?? -1,
      bulkInAddress: input?.bEndpointAddress ?? -1,
      maxPacketSize
    };
  }

  open(): void {
    this.device.timeout = this.transferTimeoutMs;
    this.device.open();
    this.usbInterface = this.device.interface(BIO_INTERFACE);
    this.input = this.endpoint(BIO_BULK_IN) as LegacyInEndpoint | undefined;
    this.output = this.endpoint(BIO_BULK_OUT) as LegacyOutEndpoint | undefined;
    if (this.input) this.input.timeout = this.transferTimeoutMs;
    if (this.output) this.output.timeout = this.transferTimeoutMs;
  }

  detachKernelDriver(): boolean {
    const usbInterface = this.requireInterface();
    if (!usbInterface.isKernelDriverActive()) return false;
    usbInterface.detachKernelDriver();
    return true;
  }

  claim(): void { this.requireInterface().claim(); }

  controlOut(request: number, value: number, index: number): Promise<void> {
    return callbackPromise<void>((done) => {
      this.device.controlTransfer(
        USB_REQUEST_VENDOR_DEVICE_OUT,
        request,
        value,
        index,
        Buffer.alloc(0),
        (error) => done(error, undefined)
      );
    });
  }

  async controlIn(request: number, value: number, index: number, length: number): Promise<Buffer> {
    const bytes = await callbackPromise<Buffer>((done) => {
      this.device.controlTransfer(
        USB_REQUEST_VENDOR_DEVICE_IN,
        request,
        value,
        index,
        length,
        (error, data) => done(error, Buffer.isBuffer(data) ? data : undefined)
      );
    });
    if (bytes.length !== length) throw new Error(`BIO USB control IN expected ${length} bytes, received ${bytes.length}`);
    return bytes;
  }

  transferOut(bytes: Uint8Array): Promise<void> {
    const output = this.output;
    if (!output) return Promise.reject(new Error("BIO USB bulk OUT endpoint is unavailable"));
    return callbackPromise<void>((done) => {
      output.transfer(Buffer.from(bytes), (error) => done(error, undefined));
    });
  }

  startInput(listener: (bytes: Buffer) => void, onError: (error: Error) => void): void {
    const input = this.input;
    if (!input) throw new Error("BIO USB bulk IN endpoint is unavailable");
    this.inputListener = listener;
    this.inputErrorListener = onError;
    input.on("data", listener);
    input.on("error", onError);
    this.pollAttempted = true;
    input.startPoll(1, BIO_MAX_PACKET_SIZE);
  }

  async stopInput(): Promise<void> {
    const input = this.input;
    if (!input || !this.pollAttempted) return;
    try {
      await callbackPromise<void>((done) => input.stopPoll((error) => done(error, undefined)));
    } finally {
      if (this.inputListener) input.off("data", this.inputListener);
      if (this.inputErrorListener) input.off("error", this.inputErrorListener);
      this.inputListener = undefined;
      this.inputErrorListener = undefined;
      this.pollAttempted = false;
    }
  }

  release(): Promise<void> {
    const usbInterface = this.requireInterface();
    return callbackPromise<void>((done) => usbInterface.release(true, (error) => done(error, undefined)));
  }

  reattachKernelDriver(): void { this.requireInterface().attachKernelDriver(); }
  close(): void { this.device.close(); }

  private endpoint(address: number): LegacyEndpoint | undefined {
    return this.usbInterface?.endpoints.find((endpoint) =>
      (endpoint.address ?? endpoint.descriptor.bEndpointAddress) === address
      && (endpoint.descriptor.bmAttributes & USB_TRANSFER_TYPE_MASK) === USB_TRANSFER_TYPE_BULK
      && endpoint.descriptor.wMaxPacketSize === BIO_MAX_PACKET_SIZE
    );
  }

  private requireInterface(): LegacyUsbInterface {
    if (!this.usbInterface) throw new Error("BIO USB interface is unavailable");
    return this.usbInterface;
  }
}

function callbackPromise<T>(operation: (done: (error?: Error | null, value?: T) => void) => unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const done = (error?: Error | null, value?: T) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value as T);
    };
    try {
      operation(done);
    } catch (error) {
      done(asError(error));
    }
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
