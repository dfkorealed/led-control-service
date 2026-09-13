import { randomInt } from "node:crypto";
import { BioSerialTransport, type BioTransportOptions } from "./bio-serial-transport";
import { BioEvidenceUnavailableError, decodeBioResponse, encodeBioCommand, type BioControlMode, type BioLampTarget, type BioOperation, type BioResponse } from "./bio-command-codec";
import { BioUsbError } from "./bio-usb-error";
export type BioClientEvent = Exclude<BioResponse, { kind: "probe" | "outer-ack" }> | { kind: "invalid-notification" };
export type BioDongleClientOptions = Pick<BioTransportOptions, "devicePath" | "timeoutMs" | "inspector" | "connectionFactory"> & { initialSequence?: number };
export interface BioCommandAcceptance { outcome: "dongle-accepted"; deviceApplied: false }

/** Traced operations only. ACK acceptance and unsolicited device observations remain separate. */
export class BioDongleClient {
  private readonly transport: BioSerialTransport;
  private readonly listeners = new Set<(event: BioClientEvent) => void>();
  private sequence: number;
  private probeResult?: Extract<BioResponse, { kind: "probe" }>;

  constructor(options: BioDongleClientOptions = {}) {
    this.sequence = options.initialSequence ?? randomInt(10, 100);
    if (!Number.isInteger(this.sequence) || this.sequence < 0 || this.sequence > 255) throw new RangeError("Invalid BIO initial sequence");
    this.transport = new BioSerialTransport({
      devicePath: options.devicePath, timeoutMs: options.timeoutMs,
      inspector: options.inspector, connectionFactory: options.connectionFactory,
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
        // Invalid unsolicited data never becomes device state or a failed unrelated command.
        event = { kind: "invalid-notification" };
      }
      for (const listener of this.listeners) listener(event);
    });
  }

  /** Opens/probes once per connection generation; this does not validate durable fixture mappings. */
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

  // These methods deliberately have no opcodes: explicit captures are still missing.
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
