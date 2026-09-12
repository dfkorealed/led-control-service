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
    // ObservabilityModule is imported before dependency modules so this hook runs
    // before their destroy hooks and makes every subsequent readiness call fail closed.
    this.stopping = true;
  }

  async check(): Promise<ReadinessResult> {
    if (this.stopping) return this.result(this.allDown());

    const probes: Record<DependencyName, () => Promise<void>> = {
      postgres: () => this.prisma.probeReadiness(),
      redis: () => this.redis.probeReadiness(),
      mqtt: () => this.mqtt.probeReadiness(),
      objectStorage: () => this.objectStorage.probeReadiness()
    };
    const outcomes = await Promise.allSettled(
      dependencyNames.map(name => this.withTimeout(probes[name]))
    );
    const checks = Object.fromEntries(dependencyNames.map((name, index) => [
      name,
      outcomes[index].status === "fulfilled" ? "up" : "down"
    ])) as DependencyChecks;

    return this.result(this.stopping ? this.allDown() : checks);
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

  private withTimeout(probe: () => Promise<void>) {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error === undefined ? resolve() : reject(error);
      };
      const timer = setTimeout(() => finish(new Error("readiness probe deadline exceeded")), this.probeTimeoutMs);
      Promise.resolve().then(probe).then(() => finish(), error => finish(error));
    });
  }
}
