import { readFile } from "node:fs/promises";
import { normalizeCertificateChain, type DeviceCertificateClient } from "./device-certificate-client";
import type { KeyMaterialStore } from "./key-material-store";
import type { MqttCertificateClient } from "./mqtt-certificate-client";
import type { MqttIdentityCandidate, MqttIdentityStore, PreparedMqttIdentity } from "./mqtt-identity-store";

export const CERTIFICATE_ROTATION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_DELAY_MS = 12 * 60 * 60 * 1000;
const DEFAULT_MAXIMUM_DELAY_MS = 60 * 60 * 1000;

export function shouldRotateCertificate(notAfter: Date, clock: () => Date = () => new Date()) {
  const expiration = notAfter.getTime();
  const now = clock().getTime();
  if (!Number.isFinite(expiration) || !Number.isFinite(now)) throw new Error("certificate date is invalid");
  return expiration - now < CERTIFICATE_ROTATION_WINDOW_MS;
}

export interface CertificateRotationOptions {
  rotateDevice: () => Promise<void>;
  rotateMqtt: () => Promise<void>;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (timer: unknown) => void;
  logger?: { error: (message: string) => void };
  initialDelayMs?: number;
  maximumDelayMs?: number;
}

export class CertificateRotation {
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly logger: { error: (message: string) => void };
  private readonly initialDelayMs: number;
  private readonly maximumDelayMs: number;
  private readonly cancel: (timer: unknown) => void;
  private running: Promise<void> | undefined;
  private timer: unknown;
  private stopped = false;
  private consecutiveFailures = 0;

  constructor(private readonly options: CertificateRotationOptions) {
    this.schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
    this.cancel = options.cancel ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.logger = options.logger ?? console;
    this.initialDelayMs = boundedDelay(options.initialDelayMs ?? DEFAULT_DELAY_MS);
    this.maximumDelayMs = boundedDelay(options.maximumDelayMs ?? DEFAULT_MAXIMUM_DELAY_MS);
  }

  start() {
    if (this.stopped) return;
    void this.run();
  }

  async stop() {
    this.stopped = true;
    if (this.timer !== undefined) {
      this.cancel(this.timer);
      this.timer = undefined;
    }
    await this.running;
  }

  run(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.execute().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async execute() {
    try {
      await this.options.rotateDevice();
      await this.options.rotateMqtt();
      this.consecutiveFailures = 0;
      this.scheduleNext(this.initialDelayMs);
    } catch {
      this.consecutiveFailures += 1;
      this.logger.error("gateway certificate rotation failed");
      this.scheduleNext(Math.min(this.maximumDelayMs, this.initialDelayMs * 2 ** this.consecutiveFailures));
    }
  }

  private scheduleNext(delayMs: number) {
    if (this.stopped) return;
    this.timer = this.schedule(() => {
      this.timer = undefined;
      this.start();
    }, delayMs);
  }
}

export function createGatewayCertificateRotation(options: {
  gatewayId: string;
  deviceStore: KeyMaterialStore;
  mqttStore: MqttIdentityStore;
  deviceClient: DeviceCertificateClient;
  mqttClient: MqttCertificateClient;
  mqttProbe: (candidate: MqttIdentityCandidate) => Promise<void>;
  activateMqttIdentity?: (prepared: PreparedMqttIdentity) => Promise<void>;
  clock?: () => Date;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  logger?: { error: (message: string) => void };
}) {
  const clock = options.clock ?? (() => new Date());
  return new CertificateRotation({
    schedule: options.schedule,
    logger: options.logger,
    rotateDevice: async () => {
      const current = await options.deviceStore.currentIdentity();
      rejectExpired(current.notAfter, clock());
      if (!shouldRotateCertificate(current.notAfter, clock)) return;
      const generated = await options.deviceStore.generateDeviceIdentity(options.gatewayId);
      const renewed = await options.deviceClient.renew(generated.csrPem);
      if (renewed.gatewayId !== options.gatewayId) throw new Error("device certificate renewal failed");
      const [deviceCaBundlePem, apiCaBundlePem, mqttCaBundlePem] = await Promise.all([
        readFile(current.deviceCaPath, "utf8"), readFile(current.apiCaPath, "utf8"), readFile(current.mqttCaPath, "utf8")
      ]);
      const renewedChainPem = normalizeCertificateChain(renewed.caChainPem).join("");
      await options.deviceStore.installIdentityBundle({
        deviceCertificatePem: renewed.certificatePem,
        deviceCaBundlePem: `${deviceCaBundlePem.trim()}\n${renewedChainPem}`,
        apiCaBundlePem,
        mqttCaBundlePem
      }, { activate: (candidate) => options.deviceClient.activate(candidate) });
    },
    rotateMqtt: async () => {
      const current = await options.mqttStore.currentIdentity(options.gatewayId);
      rejectExpired(current.notAfter, clock());
      if (!shouldRotateCertificate(current.notAfter, clock)) return;
      const caBundlePem = await readFile(current.caPath, "utf8");
      const prepared = await options.mqttStore.prepare(
        options.gatewayId,
        caBundlePem,
        (csrPem) => options.mqttClient.requestCertificate(csrPem),
        true
      );
      if (!prepared) return;
      let activated = false;
      try {
        await options.mqttProbe(prepared.candidate);
        if (options.activateMqttIdentity) await options.activateMqttIdentity(prepared);
        else await prepared.commit();
        activated = true;
        await prepared.finalize();
      } catch (error) {
        if (!activated) await prepared.rollback().catch(() => undefined);
        throw error;
      }
    }
  });
}

function rejectExpired(notAfter: Date, now: Date) {
  if (notAfter.getTime() <= now.getTime()) throw new Error("certificate is expired");
}

function boundedDelay(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > 24 * 60 * 60 * 1000) throw new Error("invalid rotation delay");
  return value;
}
