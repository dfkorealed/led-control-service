import { Inject, Injectable, Optional } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

export const COMMAND_DB_CLOCK_EVIDENCE_SOURCE = Symbol("COMMAND_DB_CLOCK_EVIDENCE_SOURCE");
const MAX_EVIDENCE_AGE_MS = 1_000;
const MAX_ABSOLUTE_OFFSET_MS = 100;

export interface CommandDbPrimaryIdentity {
  startedAt: Date;
  address: string | null;
  port: number | null;
}

/** A future DB-host attestor must issue this evidence; MQTT requests cannot supply it. */
export interface CommandDbClockEvidence {
  issuedAt: Date;
  offsetMs: number;
  stepGeneration: number;
  clearedStepGeneration: number;
  failoverGeneration: number;
  clearedFailoverGeneration: number;
  primary: CommandDbPrimaryIdentity;
}

export interface CommandDbClockEvidenceSource {
  read(): Promise<CommandDbClockEvidence | null>;
  /** Immutable epoch baseline from an independently durable trusted attestor.
   * It must not synthesize a baseline from the process's current clock sample. */
  readEpochContinuity?(generation: number): Promise<CommandDbClockEpochContinuity | null>;
}

export interface CommandDbClockEpochContinuity {
  generation: number;
  primary: CommandDbPrimaryIdentity;
  stepGeneration: number;
  failoverGeneration: number;
}

interface PrimaryObservation {
  dbNow: Date;
  isReplica: boolean;
  primaryStartedAt: Date;
  serverAddress: string | null;
  serverPort: number | null;
}

@Injectable()
export class CommandDbClockHealth {
  private readonly epochContinuity = new Map<number, string | null>();
  constructor(
    @Optional() @Inject(COMMAND_DB_CLOCK_EVIDENCE_SOURCE)
    private readonly evidenceSource?: CommandDbClockEvidenceSource
  ) {}

  async assertHealthy(tx: Prisma.TransactionClient, generation?: number): Promise<Date> {
    if (generation !== undefined && (!Number.isSafeInteger(generation) || generation <= 0)) {
      throw new Error("invalid command clock epoch");
    }
    try {
      let baseline: string | undefined;
      if (generation !== undefined && !this.epochContinuity.has(generation)) {
        const durable = await this.evidenceSource?.readEpochContinuity?.(generation);
        if (!durable || durable.generation !== generation || !validDate(durable.primary?.startedAt) ||
          !validGeneration(durable.stepGeneration) || !validGeneration(durable.failoverGeneration)) {
          throw new Error("DB clock durable epoch continuity unavailable");
        }
        baseline = continuityKey(durable.primary, durable.stepGeneration, durable.failoverGeneration);
      }
      const { now, continuity } = await this.observeHealthy(tx);
      if (generation !== undefined) {
        const previous = this.epochContinuity.get(generation) ?? baseline;
        if (this.epochContinuity.get(generation) === null) throw new Error("DB clock epoch continuity lost");
        if (previous !== undefined && previous !== continuity) throw new Error("DB clock epoch continuity lost");
        this.epochContinuity.set(generation, continuity);
      }
      return now;
    } catch (error) {
      // Recovery of an attestor never revives this process's old Set epoch.
      // This local latch is NOT durable barrier evidence across process restart;
      // the protected worker separately requires signed clock/primary continuity.
      if (generation !== undefined) this.epochContinuity.set(generation, null);
      throw error;
    }
  }

  private async observeHealthy(tx: Prisma.TransactionClient): Promise<{ now: Date; continuity: string }> {
    // No production provider is registered until the central DB host has a
    // trusted sync/step/failover attestor. Missing evidence always denies Set time.
    if (!this.evidenceSource) throw new Error("DB clock attestation unavailable");
    const evidence = await this.evidenceSource.read();
    const [observed] = await tx.$queryRaw<PrimaryObservation[]>`
      SELECT clock_timestamp() AS "dbNow", pg_is_in_recovery() AS "isReplica",
        pg_postmaster_start_time() AS "primaryStartedAt",
        inet_server_addr()::text AS "serverAddress", inet_server_port() AS "serverPort"`;
    if (!observed || observed.isReplica || !validDate(observed.dbNow) || !validDate(observed.primaryStartedAt) ||
      !evidence || !validDate(evidence.issuedAt) || !validDate(evidence.primary?.startedAt)) {
      throw new Error("DB clock primary evidence unavailable");
    }
    const ageMs = observed.dbNow.getTime() - evidence.issuedAt.getTime();
    if (ageMs < -MAX_ABSOLUTE_OFFSET_MS || ageMs > MAX_EVIDENCE_AGE_MS ||
      !Number.isFinite(evidence.offsetMs) || Math.abs(evidence.offsetMs) > MAX_ABSOLUTE_OFFSET_MS ||
      !validGeneration(evidence.stepGeneration) || evidence.stepGeneration !== evidence.clearedStepGeneration ||
      !validGeneration(evidence.failoverGeneration) || evidence.failoverGeneration !== evidence.clearedFailoverGeneration ||
      evidence.primary.startedAt.getTime() !== observed.primaryStartedAt.getTime() ||
      evidence.primary.address !== observed.serverAddress || evidence.primary.port !== observed.serverPort) {
      throw new Error("DB clock attestation not current for primary");
    }
    return { now: observed.dbNow, continuity: continuityKey({ startedAt: observed.primaryStartedAt,
      address: observed.serverAddress, port: observed.serverPort }, evidence.stepGeneration, evidence.failoverGeneration) };
  }
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function validGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function continuityKey(primary: CommandDbPrimaryIdentity, stepGeneration: number, failoverGeneration: number) {
  return JSON.stringify([primary.startedAt.toISOString(), primary.address, primary.port, stepGeneration, failoverGeneration]);
}
