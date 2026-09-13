import { pathToFileURL } from "node:url";
import { BioDirectUsbConnection } from "../src/bio/bio-direct-usb-connection";
import { decodeBioResponse } from "../src/bio/bio-command-codec";
import type { BioFrame } from "../src/bio/bio-frame-codec";
import {
  NodeUsbDriver,
  type BioUsbDescriptor,
  type BioUsbDeviceHandle,
  type BioUsbDriver
} from "../src/bio/node-usb-driver";
import { BioUsbError } from "../src/bio/bio-usb-error";
import { BioUsbTransport } from "../src/bio/bio-usb-transport";

interface ProbeOptions {
  timeoutMs: number;
}

/**
 * Task 3 read-only product probe allowlist
 *
 * [확인됨] 실행 경로는 exact descriptor/open, 캡처된 CH34x 초기화, 두 고정 82 literal,
 * checksum-valid 03 준비, GET_NWK 0A, CRC16 0B의 정확한 13-byte payload 검증뿐이다.
 * 임의 command/raw payload 인자를 제공하지 않으므로 외부 10, 주소/밝기/mode/password/reset
 * write로 확장할 수 없다. 출력은 descriptor와 protocol/command/payload length/elapsed만 남기며
 * UUID, 비밀번호로 보이는 0B bytes, 원시 payload는 성공/실패 모두 redaction한다.
 * [미확인] 03/0B 개별 payload 필드 의미는 probe 성공 조건에 사용하지 않는다.
 */

interface ProbeDependencies {
  driverFactory?: () => BioUsbDriver;
  output?: (line: string) => void;
  now?: () => number;
}

interface FrameMetadata {
  protocol: "crc16" | "gs";
  command: string;
  payloadBytes: number;
}

class DescriptorCapturingHandle implements BioUsbDeviceHandle {
  constructor(
    private readonly handle: BioUsbDeviceHandle,
    private readonly capture: (descriptor: BioUsbDescriptor) => void
  ) {}

  descriptor(): BioUsbDescriptor {
    const value = this.handle.descriptor();
    this.capture(value);
    return value;
  }
  open(): void { this.handle.open(); }
  detachKernelDriver(): boolean { return this.handle.detachKernelDriver(); }
  claim(): void { this.handle.claim(); }
  controlOut(request: number, value: number, index: number): Promise<void> {
    return this.handle.controlOut(request, value, index);
  }
  controlIn(request: number, value: number, index: number, length: number): Promise<Buffer> {
    return this.handle.controlIn(request, value, index, length);
  }
  transferOut(bytes: Uint8Array): Promise<void> { return this.handle.transferOut(bytes); }
  startInput(listener: (bytes: Buffer) => void, onError: (error: Error) => void): void {
    this.handle.startInput(listener, onError);
  }
  stopInput(): Promise<void> { return this.handle.stopInput(); }
  release(): Promise<void> { return this.handle.release(); }
  reattachKernelDriver(): void { this.handle.reattachKernelDriver(); }
  close(): void { this.handle.close(); }
}

class DescriptorCapturingDriver implements BioUsbDriver {
  descriptor?: BioUsbDescriptor;

  constructor(private readonly driver: BioUsbDriver) {}

  findExactDevice(): BioUsbDeviceHandle {
    return new DescriptorCapturingHandle(
      this.driver.findExactDevice(),
      (value) => { this.descriptor = { ...value }; }
    );
  }
}

function parseArguments(args: string[]): ProbeOptions {
  if (args.length === 0) return { timeoutMs: 1000 };
  if (args.length !== 2 || args[0] !== "--timeout-ms") throw new Error("Invalid arguments");
  const value = args[1];
  if (!/^[0-9]+$/.test(value)) throw new Error("Invalid arguments");
  const timeoutMs = Number(value);
  if (timeoutMs < 1 || timeoutMs > 10000) throw new Error("Invalid arguments");
  return { timeoutMs };
}

function frameMetadata(frame: BioFrame): FrameMetadata {
  return {
    protocol: frame.protocol,
    command: `0x${frame.command.toString(16).padStart(2, "0")}`,
    payloadBytes: frame.payload.length
  };
}

function descriptorMetadata(value: BioUsbDescriptor): string {
  return [
    `${value.idVendor.toString(16).padStart(4, "0")}:${value.idProduct.toString(16).padStart(4, "0")}`,
    `interface${value.interfaceNumber}`,
    `out${value.bulkOutAddress.toString(16).padStart(2, "0")}`,
    `in${value.bulkInAddress.toString(16).padStart(2, "0")}`,
    `packet${value.maxPacketSize}`
  ].join("/");
}

/** [확인됨] 위 한 가지 고정 read-only 준비 시퀀스만 실행하고 device-owned data는 반환하지 않는다. */
export async function runBioDongleProbe(args: string[], dependencies: ProbeDependencies = {}): Promise<number> {
  const output = dependencies.output ?? ((line: string) => console.log(line));
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  const elapsedMs = () => Math.max(0, Math.round(now() - startedAt));
  let options: ProbeOptions;
  try {
    options = parseArguments(args);
  } catch {
    output(JSON.stringify({ error: "INVALID_ARGUMENTS", elapsedMs: elapsedMs() }));
    return 2;
  }

  const driver = new DescriptorCapturingDriver(dependencies.driverFactory?.() ?? new NodeUsbDriver(undefined, {
    transferTimeoutMs: options.timeoutMs
  }));
  let converterInfo: BioFrame | undefined;
  let networkProbe: BioFrame | undefined;
  let failure: unknown;
  const transport = new BioUsbTransport({
    profile: "android-v1.2.0",
    protocol: "crc16",
    timeoutMs: options.timeoutMs,
    connectionFactory: () => new BioDirectUsbConnection(driver),
    validateReadiness: async (frame) => {
      if (decodeBioResponse(frame).kind !== "probe") {
        throw new BioUsbError("READINESS", "BIO network probe was not validated");
      }
      networkProbe = frame;
    }
  });
  const unsubscribe = transport.onNotification((frame) => {
    if (!converterInfo && frame.command === 0x03) converterInfo = frame;
  });

  try {
    await transport.start();
  } catch (error) {
    failure = error;
  } finally {
    unsubscribe();
    try { await transport.stop(); } catch (error) { failure = error; }
  }

  if (failure || !driver.descriptor || !converterInfo || !networkProbe) {
    output(JSON.stringify({
      error: failure instanceof BioUsbError ? failure.code : "PROBE_FAILED",
      elapsedMs: elapsedMs()
    }));
    return 1;
  }

  output(JSON.stringify({
    adapterKind: "bio-usb",
    descriptor: descriptorMetadata(driver.descriptor),
    converterInfo: frameMetadata(converterInfo),
    networkProbe: frameMetadata(networkProbe),
    elapsedMs: elapsedMs()
  }));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runBioDongleProbe(process.argv.slice(2));
}
