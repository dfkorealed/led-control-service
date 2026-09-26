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
  constructor(
    @Optional() @Inject(COMMAND_DB_CLOCK_EVIDENCE_SOURCE)
    private readonly evidenceSource?: CommandDbClockEvidenceSource
  ) {}

  async assertHealthy(tx: Prisma.TransactionClient): Promise<void> {
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
  }
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function validGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
