import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import { MqttService } from "../mqtt/mqtt.service";
import { PrismaService } from "../prisma/prisma.service";
import { RedisProvider } from "../redis/redis.provider";
import { ObjectStorageService } from "../storage/object-storage.service";
import { ObservabilityMetrics } from "./observability-metrics.service";

export const OBSERVABILITY_CLOCK = Symbol("OBSERVABILITY_CLOCK");
export const READINESS_PROBE_TIMEOUT_MS = Symbol("READINESS_PROBE_TIMEOUT_MS");
export const DEFAULT_READINESS_PROBE_TIMEOUT_MS = 1_000;

const dependencyNames = ["postgres", "redis", "mqtt", "objectStorage"] as const;
type DependencyName = (typeof dependencyNames)[number];
export type DependencyChecks = Record<DependencyName, "up" | "down">;
export interface ReadinessResult {
  status: "ready" | "not_ready";
  checks: DependencyChecks;
  timestamp: string;
}

@Injectable()
export class ReadinessService implements OnModuleDestroy {
  private stopping = false;
  private activeCheck: { response: Promise<ReadinessResult> } | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisProvider,
    private readonly mqtt: MqttService,
    private readonly objectStorage: ObjectStorageService,
    private readonly metrics: ObservabilityMetrics,
    @Inject(OBSERVABILITY_CLOCK) private readonly clock: () => Date,
    @Inject(READINESS_PROBE_TIMEOUT_MS) private readonly probeTimeoutMs: number
  ) {}

  onModuleDestroy() {
    // Hook ordering across imported Nest modules is not stable. Once this hook runs,
    // every later readiness observation remains fail-closed without dependency I/O.
    this.stopping = true;
  }

  check(): Promise<ReadinessResult> {
    if (this.stopping) return Promise.resolve(this.result(this.allDown()));
    if (this.activeCheck) return this.activeCheck.response;

    const probes: Record<DependencyName, (signal: AbortSignal) => Promise<void>> = {
      postgres: () => this.prisma.probeReadiness(),
      redis: () => this.redis.probeReadiness(),
      mqtt: () => this.mqtt.probeReadiness(),
      objectStorage: signal => this.objectStorage.probeReadiness(signal)
    };
    const executions = dependencyNames.map(name => {
      const controller = new AbortController();
      const raw = Promise.resolve().then(() => probes[name](controller.signal));
      return { raw, bounded: this.withTimeout(raw, controller) };
    });
    let rawSettled = false;
    let responseSettled = false;
    const generation = { response: Promise.resolve({} as ReadinessResult) };
    const clearIfSettled = () => {
      if (rawSettled && responseSettled && this.activeCheck === generation) this.activeCheck = undefined;
    };
    const response = Promise.allSettled(executions.map(execution => execution.bounded)).then(outcomes => {
      const checks = Object.fromEntries(dependencyNames.map((name, index) => [
        name,
        outcomes[index].status === "fulfilled" ? "up" : "down"
      ])) as DependencyChecks;
      return this.result(this.stopping ? this.allDown() : checks);
    }).finally(() => {
      responseSettled = true;
      clearIfSettled();
    });
    generation.response = response;
    this.activeCheck = generation;
    void Promise.allSettled(executions.map(execution => execution.raw)).then(() => {
      rawSettled = true;
      clearIfSettled();
    });
    return response;
  }

  private result(checks: DependencyChecks): ReadinessResult {
    this.metrics.recordReadiness(checks);
    return {
      status: dependencyNames.every(name => checks[name] === "up") ? "ready" : "not_ready",
      checks,
      timestamp: this.clock().toISOString()
    };
  }

  private allDown(): DependencyChecks {
    return { postgres: "down", redis: "down", mqtt: "down", objectStorage: "down" };
  }

  private withTimeout(probe: Promise<void>, controller: AbortController) {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const succeed = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const fail = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error("readiness probe failed"));
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        controller.abort();
        reject(new Error("readiness probe deadline exceeded"));
      }, this.probeTimeoutMs);
      probe.then(succeed, fail);
    });
  }
}
