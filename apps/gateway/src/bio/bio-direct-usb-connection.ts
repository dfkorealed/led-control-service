import type { BioByteConnection } from "./bio-byte-connection";
import { BioUsbError } from "./bio-usb-error";
import { NodeUsbDriver, type BioUsbDescriptor, type BioUsbDeviceHandle, type BioUsbDriver } from "./node-usb-driver";

const EXPECTED_DESCRIPTOR = {
  idVendor: 0x1a86,
  idProduct: 0x5523,
  interfaceNumber: 0,
  bulkOutAddress: 0x02,
  bulkInAddress: 0x82,
  maxPacketSize: 32
} as const;

/**
 * [확인됨] 대상은 CH341 serial mode VID:PID `1a86:5523`, interface 0,
 * bulk OUT `0x02`, bulk IN `0x82`, 양쪽 max packet 32 bytes다. descriptor가
 * 하나라도 다르면 같은 프로토콜 장치라고 추측하지 않고 USB_IDENTITY로 중단한다.
 */

type CleanupStage = "stop input" | "release interface" | "reattach kernel driver" | "close device";

/** [확인됨] exact-one CH34x를 선택해 kernel detach부터 역순 cleanup까지 한 객체가 소유한다. */
export class BioDirectUsbConnection implements BioByteConnection {
  private readonly dataListeners = new Set<(bytes: Buffer) => void>();
  private readonly disconnectListeners = new Set<(error: Error) => void>();
  private handle?: BioUsbDeviceHandle;
  private opening?: Promise<void>;
  private cleanupResult?: Promise<Array<{ stage: CleanupStage; error: Error }>>;
  private deviceOpenAttempted = false;
  private detachMayNeedReattach = false;
  private claimed = false;
  private inputStartAttempted = false;
  private ready = false;
  private disconnectDelivered = false;

  constructor(private readonly driver: BioUsbDriver = new NodeUsbDriver()) {}

  open(): Promise<void> {
    this.opening ??= this.openOnce();
    return this.opening;
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (!this.ready || !this.handle || this.cleanupResult) {
      throw new BioUsbError("DISCONNECTED", "BIO direct USB connection is not open");
    }
    try {
      await this.handle.transferOut(bytes);
    } catch (cause) {
      throw new BioUsbError("DISCONNECTED", "BIO direct USB bulk write failed", { cause });
    }
  }

  async close(): Promise<void> {
    await this.opening?.catch(() => {});
    const failures = await this.cleanup();
    if (failures.length > 0) {
      throw new BioUsbError("CLOSE_FAILED", "BIO direct USB cleanup was not fully confirmed", {
        cause: new AggregateError(failures.map(({ error }) => error), failures.map(({ stage }) => stage).join(", "))
      });
    }
  }

  onData(listener: (bytes: Buffer) => void): () => void {
    this.dataListeners.add(listener);
    return () => { this.dataListeners.delete(listener); };
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => { this.disconnectListeners.delete(listener); };
  }

  private async openOnce(): Promise<void> {
    try {
      const handle = this.driver.findExactDevice();
      this.handle = handle;
      this.validateDescriptor(handle.descriptor());

      // A native open may acquire a descriptor before throwing, so cleanup must
      // attempt close after any open call, including a partially failed one.
      this.deviceOpenAttempted = true;
      handle.open();

      // A detach call can succeed in the kernel before a binding throws. Treat
      // the state as uncertain until an explicit false return proves no detach.
      this.detachMayNeedReattach = true;
      this.detachMayNeedReattach = handle.detachKernelDriver();
      handle.claim();
      this.claimed = true;

      // [확인됨] 아래 8개 vendor-control transfer의 request/value/index/방향/순서는
      // Android APK와 direct-USB HIL에서 그대로 재현해 검증했다. [미확인] 각 CH34x
      // register의 제조사 의미는 확보하지 못했으므로 이름을 붙이거나 일부를 합치지 않는다.
      // literal을 정확히 보존하는 것이 현재 유일한 호환성 계약이다.
      await handle.controlOut(0xa1, 0x0000, 0x0000);
      await this.controlInExactly(handle, 0x5f, 0x0000, 0x0000, 2);
      await handle.controlOut(0x9a, 0x1312, 0xd982);
      await handle.controlOut(0x9a, 0x0f2c, 0x0004);
      await this.controlInExactly(handle, 0x95, 0x2518, 0x0000, 2);
      await handle.controlOut(0x9a, 0x2727, 0x0000);
      await handle.controlOut(0xa4, 0x00ff, 0x0000);
      await handle.controlOut(0xa1, 0xc39c, 0xcc8b);

      // Re-read the descriptor after native initialization. A re-enumerated or
      // differently configured interface must never inherit this connection.
      this.validateDescriptor(handle.descriptor());
      this.inputStartAttempted = true;
      // The endpoint may deliver its first packet during startPoll(). Mark the
      // generation ready before entering native code so startup bytes survive.
      this.ready = true;
      handle.startInput(
        (bytes) => { if (this.ready) for (const listener of this.dataListeners) listener(bytes); },
        (error) => this.disconnected(error)
      );
    } catch (cause) {
      const failures = await this.cleanup();
      if (cause instanceof BioUsbError && failures.length === 0) throw cause;
      const primary = asError(cause);
      const errors = [primary, ...failures.map(({ error }) => error)];
      throw new BioUsbError(cause instanceof BioUsbError ? cause.code : "DISCONNECTED", `BIO direct USB open failed: ${primary.message}`, {
        cause: errors.length === 1 ? primary : new AggregateError(errors, "BIO direct USB open and cleanup failed")
      });
    }
  }

  private async controlInExactly(
    handle: BioUsbDeviceHandle,
    request: number,
    value: number,
    index: number,
    length: number
  ): Promise<void> {
    const bytes = await handle.controlIn(request, value, index, length);
    if (bytes.length !== length) {
      throw new Error(`BIO USB control IN expected ${length} bytes, received ${bytes.length}`);
    }
  }

  private validateDescriptor(descriptor: BioUsbDescriptor): void {
    for (const [field, expected] of Object.entries(EXPECTED_DESCRIPTOR) as Array<[keyof typeof EXPECTED_DESCRIPTOR, number]>) {
      if (descriptor[field] !== expected) {
        throw new BioUsbError("USB_IDENTITY", `BIO USB ${field} mismatch`);
      }
    }
    if (!Number.isInteger(descriptor.busNumber) || descriptor.busNumber < 0
      || !Number.isInteger(descriptor.deviceAddress) || descriptor.deviceAddress < 0) {
      throw new BioUsbError("USB_IDENTITY", "BIO USB physical descriptor is invalid");
    }
  }

  private disconnected(error: Error): void {
    if (this.disconnectDelivered || this.cleanupResult) return;
    this.disconnectDelivered = true;
    for (const listener of this.disconnectListeners) listener(error);
  }

  private cleanup(): Promise<Array<{ stage: CleanupStage; error: Error }>> {
    this.cleanupResult ??= this.cleanupOnce();
    return this.cleanupResult;
  }

  private async cleanupOnce(): Promise<Array<{ stage: CleanupStage; error: Error }>> {
    this.ready = false;
    const failures: Array<{ stage: CleanupStage; error: Error }> = [];
    const attempt = async (stage: CleanupStage, operation: () => void | Promise<void>) => {
      try { await operation(); } catch (error) { failures.push({ stage, error: asError(error) }); }
    };
    // [확인됨] poll → claimed interface → detached kernel driver → device descriptor의
    // 역순으로 해제한다. 앞 단계가 실패해도 뒤 단계를 모두 시도하고, 하나라도 확인되지
    // 않으면 CLOSE_FAILED로 남겨 다음 세대가 불확실한 USB 소유권을 재사용하지 못하게 한다.
    if (this.inputStartAttempted) await attempt("stop input", () => this.handle!.stopInput());
    if (this.claimed) await attempt("release interface", () => this.handle!.release());
    if (this.detachMayNeedReattach) await attempt("reattach kernel driver", () => this.handle!.reattachKernelDriver());
    if (this.deviceOpenAttempted) await attempt("close device", () => this.handle!.close());
    return failures;
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
