import { randomInt } from "node:crypto";
import { BioUsbTransport, type BioTransportOptions } from "./bio-usb-transport";
import { BioDirectUsbConnection } from "./bio-direct-usb-connection";
import { BioEvidenceUnavailableError, decodeBioResponse, encodeBioCommand, type BioControlMode, type BioLampTarget, type BioOperation, type BioResponse } from "./bio-command-codec";
import { BioUsbError } from "./bio-usb-error";
export type BioClientEvent = Exclude<BioResponse, { kind: "probe" | "outer-ack" }> | { kind: "invalid-notification" };
export type BioDongleClientOptions = Pick<BioTransportOptions, "timeoutMs"> & {
  connectionFactory?: BioTransportOptions["connectionFactory"];
  initialSequence?: number;
};
export interface BioCommandAcceptance { outcome: "dongle-accepted"; deviceApplied: false }

/**
 * [확인됨] 이 client는 캡처된 operation만 transport에 전달한다. 외부 11의 status 0은
 * dongle이 TX 요청을 수락했다는 뜻이고, 실제 조명 적용은 별도의 12 관측/물리 확인 없이는
 * 승격하지 않는다. [미확인] opcode를 편의상 추측하는 API는 의도적으로 제공하지 않는다.
 */
export class BioDongleClient {
  private readonly transport: BioUsbTransport;
  private readonly listeners = new Set<(event: BioClientEvent) => void>();
  private sequence: number;
  private probeResult?: Extract<BioResponse, { kind: "probe" }>;

  constructor(options: BioDongleClientOptions) {
    this.sequence = options.initialSequence ?? randomInt(10, 100);
    if (!Number.isInteger(this.sequence) || this.sequence < 0 || this.sequence > 255) throw new RangeError("Invalid BIO initial sequence");
    this.transport = new BioUsbTransport({
      timeoutMs: options.timeoutMs,
      connectionFactory: options.connectionFactory ?? (() => new BioDirectUsbConnection()),
      profile: "android-v1.2.0", protocol: "crc16",
      validateReadiness: async (frame) => {
        const parsed = decodeBioResponse(frame);
        if (parsed.kind !== "probe") throw new BioUsbError("READINESS", "BIO traced probe was not validated");
        this.probeResult = parsed;
      }
    });
    this.transport.onNotification((frame) => {
      let event: BioClientEvent;
      try {
        const parsed = decodeBioResponse(frame);
        if (parsed.kind === "probe" || parsed.kind === "outer-ack") return;
        event = parsed;
      } catch {
        // [추정] 비동기 12의 손상은 동시에 진행 중인 ACK 요청과 다른 소유권이다. 따라서
        // device state로 만들지 않되, 무관한 요청 실패로 바꾸지도 않고 invalid event로 격리한다.
        event = { kind: "invalid-notification" };
      }
      for (const listener of this.listeners) listener(event);
    });
  }

  /** [확인됨] 세대별 USB/GET_NWK만 검증하며 fixture의 durable mapping 확인을 대신하지 않는다. */
  async probe(): Promise<Extract<BioResponse, { kind: "probe" }>> {
    await this.transport.start();
    if (!this.probeResult) throw new BioUsbError("READINESS", "BIO traced probe was not validated");
    return { ...this.probeResult };
  }
  async close(): Promise<void> { await this.transport.stop(); }
  async scan(): Promise<BioCommandAcceptance> { return this.send({ kind: "scan" }); }
  async stopScan(): Promise<BioCommandAcceptance> { return this.send({ kind: "stopScan" }); }

  /** Sets raw Scene.highBrightness; it is neither a linear percent nor proof of current output. */
  async setBrightness(target: BioLampTarget, value: { rawHighBrightness: number }): Promise<BioCommandAcceptance> {
    return this.send({ kind: "setHighBrightness", target, rawHighBrightness: value.rawHighBrightness });
  }
  async setControlMode(target: BioLampTarget, mode: BioControlMode): Promise<BioCommandAcceptance> {
    return this.send({ kind: "setControlMode", target, mode });
  }

  // [미확인] identify/address/read-back opcode 캡처가 없으므로 method에 임의 bytes를 넣지 않는다.
  async startIdentify(_nativeId: string): Promise<never> { throw new BioEvidenceUnavailableError(); }
  async stopIdentify(_nativeId: string): Promise<never> { throw new BioEvidenceUnavailableError(); }
  async assignAddress(_nativeId: string, _logicalAddress: number): Promise<never> { throw new BioEvidenceUnavailableError(); }
  async readBrightness(_target: BioLampTarget): Promise<never> { throw new BioEvidenceUnavailableError(); }
  async readDeviceInfo(_target: BioLampTarget): Promise<never> { throw new BioEvidenceUnavailableError(); }

  onEvent(listener: (event: BioClientEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private async send(operation: BioOperation): Promise<BioCommandAcceptance> {
    const request = encodeBioCommand(operation, this.sequence);
    this.sequence = (this.sequence + 1) & 0xff;
    const response = decodeBioResponse(await this.transport.request(request));
    if (response.kind !== "outer-ack") throw new BioUsbError("MALFORMED_FRAME", "BIO outer ACK was not validated");
    if (!response.accepted) throw Object.assign(new Error("BIO dongle rejected the command"), { code: "BIO_DONGLE_REJECTED" });
    return { outcome: "dongle-accepted", deviceApplied: false };
  }
}
