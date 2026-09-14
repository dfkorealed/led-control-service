import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { reportAttemptKeys, type ReportObjectIdentity } from "../energy/reports/energy-report-cleanup.service";
import { PrismaService } from "../prisma/prisma.service";

export type GatewayRecommissionCountKey =
  | "gateway" | "fixture" | "meshNode" | "fixtureGroup"
  | "provisioningSession" | "command" | "automationExecution"
  | "monitoringIncident" | "processedGatewayEvent" | "gatewayEventWatermark"
  | "energyFixtureIdentity" | "energyGroupIdentity" | "energyAggregate"
  | "energyReport" | "floorMapRevision" | "gatewayClaimAudit";

export interface GatewayRecommissionPreview {
  siteId: string;
  inventoryId: string;
  gatewayId: string;
  serialNumber: string;
  resetDigest: string;
  counts: Readonly<Record<GatewayRecommissionCountKey, number>>;
  certificates: { deviceActive: number; mqttActive: number; mqttPending: number };
}

export interface GatewayRecommissionPrepared {
  jobId: string;
  status: "prepared";
  resetDigest: string;
  preparedAt: Date;
}

interface GatewayRecommissionInput {
  siteId: string;
  serialNumber: string;
}

interface GatewayRecommissionPrepareInput extends GatewayRecommissionInput {
  resetDigest: string;
}

type LockedTransaction = Pick<Prisma.TransactionClient, "$queryRaw" | "gatewayRecommissionJob">;
type IdRow = { id: string };
type CertificateRow = { purpose: string; status: string };
type InventoryRow = { id: string; serialNumber: string; claimedGatewayId: string | null; disabledAt: Date | null };
type GatewayRow = { id: string; siteId: string; serialNumber: string };
type ReportRow = ReportObjectIdentity & { id: string; siteId: string; format: "xlsx" | "pdf"; attemptCount: number };

const countKeys: GatewayRecommissionCountKey[] = [
  "gateway", "fixture", "meshNode", "fixtureGroup", "provisioningSession", "command",
  "automationExecution", "monitoringIncident", "processedGatewayEvent", "gatewayEventWatermark",
  "energyFixtureIdentity", "energyGroupIdentity", "energyAggregate", "energyReport",
  "floorMapRevision", "gatewayClaimAudit"
];

@Injectable()
export class GatewayRecommissionService {
  constructor(private readonly prisma: PrismaService) {}

  async preview(input: GatewayRecommissionInput): Promise<GatewayRecommissionPreview> {
    return this.prisma.$transaction(async tx => (await this.buildPreview(tx as LockedTransaction, input)).preview);
  }

  async prepare(input: GatewayRecommissionPrepareInput): Promise<GatewayRecommissionPrepared> {
    return this.prisma.$transaction(async tx => {
      const built = await this.buildPreview(tx as LockedTransaction, input);
      if (input.resetDigest !== built.preview.resetDigest) {
        throw new ConflictException("gateway recommission preview is stale");
      }
      try {
        const job = await (tx as LockedTransaction).gatewayRecommissionJob.create({
          data: {
            siteId: built.preview.siteId,
            inventoryId: built.preview.inventoryId,
            gatewayId: built.preview.gatewayId,
            serialNumber: built.preview.serialNumber,
            resetDigest: built.preview.resetDigest,
            targetSnapshot: built.snapshot,
            objectKeys: built.objectKeys,
            status: "prepared"
          }
        });
        return { jobId: job.id, status: "prepared" as const, resetDigest: job.resetDigest, preparedAt: job.preparedAt };
      } catch (error) {
        if (isActiveJobConflict(error)) throw new ConflictException("gateway recommission is already prepared");
        throw error;
      }
    });
  }

  private async buildPreview(tx: LockedTransaction, input: GatewayRecommissionInput) {
    const siteId = requiredText(input.siteId);
    const serialNumber = requiredText(input.serialNumber);

    // The order is intentional: Site, then inventory/certificates, then Gateway
    // establish the topology fence. This does not lock every child/retention row;
    // the later destructive worker must revalidate/fence this digest snapshot rather
    // than treating the preparation transaction as a broad deletion lock.
    const sites = await tx.$queryRaw<IdRow[]>(Prisma.sql`
      SELECT "id" FROM "Site" WHERE "id" = ${siteId} FOR UPDATE
    `);
    if (sites.length !== 1) throw topologyError();

    const inventories = await tx.$queryRaw<InventoryRow[]>(Prisma.sql`
      SELECT "id", "serialNumber", "claimedGatewayId", "disabledAt"
      FROM "GatewayInventory" WHERE "serialNumber" = ${serialNumber} FOR UPDATE
    `);
    if (inventories.length !== 1 || inventories[0].disabledAt || !inventories[0].claimedGatewayId) throw topologyError();
    const inventory = inventories[0];

    const certificates = await tx.$queryRaw<CertificateRow[]>(Prisma.sql`
      SELECT "purpose", "status" FROM "GatewayCertificate"
      WHERE "inventoryId" = ${inventory.id} ORDER BY "id" FOR UPDATE
    `);

    // Select every Gateway in the Site. Recommission is deliberately an exact
    // first-install reset, never a best-effort subset of a multi-Gateway site.
    const gateways = await tx.$queryRaw<GatewayRow[]>(Prisma.sql`
      SELECT "id", "siteId", "serialNumber" FROM "Gateway"
      WHERE "siteId" = ${siteId} ORDER BY "id" FOR UPDATE
    `);
    if (gateways.length !== 1 || gateways[0].id !== inventory.claimedGatewayId || gateways[0].serialNumber !== serialNumber) throw topologyError();
    const gateway = gateways[0];

    const gatewayRows = await ids(tx, Prisma.sql`SELECT "id" FROM "Gateway" WHERE "id" = ${gateway.id} ORDER BY "id"`);
    const fixtureRows = await tx.$queryRaw<Array<IdRow & { gatewayId: string | null }>>(Prisma.sql`
      SELECT "id", "gatewayId" FROM "Fixture" WHERE "siteId" = ${siteId} ORDER BY "id"
    `);
    // A Site with one Gateway must not carry a fixture whose assignment is absent
    // or points elsewhere; deleting only known rows would leave an unsafe hybrid.
    if (fixtureRows.some(row => row.gatewayId !== gateway.id)) throw topologyError();
    const fixtureIds = fixtureRows.map(row => row.id);
    const meshNodeRows = await ids(tx, Prisma.sql`SELECT "id" FROM "MeshNode" WHERE "gatewayId" = ${gateway.id} ORDER BY "id"`);
    const fixtureGroupRows = await ids(tx, Prisma.sql`SELECT "id" FROM "FixtureGroup" WHERE "siteId" = ${siteId} ORDER BY "id"`);
    const provisioningSessionRows = await ids(tx, Prisma.sql`SELECT "id" FROM "ProvisioningSession" WHERE "gatewayId" = ${gateway.id} ORDER BY "id"`);
    const commandRows = await ids(tx, Prisma.sql`SELECT "id" FROM "Command" WHERE "siteId" = ${siteId} ORDER BY "id"`);
    const automationExecutionRows = await ids(tx, Prisma.sql`SELECT "id" FROM "AutomationExecution" WHERE "gatewayId" = ${gateway.id} ORDER BY "id"`);
    // Fixture incidents intentionally have gatewayId=NULL; Site is the complete
    // validated installation boundary and includes resolved history too.
    const monitoringIncidentRows = await ids(tx, Prisma.sql`SELECT "id" FROM "MonitoringIncident" WHERE "siteId" = ${siteId} ORDER BY "id"`);
    const processedGatewayEventRows = await ids(tx, Prisma.sql`SELECT "eventId" AS "id" FROM "ProcessedGatewayEvent" WHERE "gatewayId" = ${gateway.id} ORDER BY "eventId"`);
    const watermarkRows = await tx.$queryRaw<Array<{ eventType: string; scopeKey: string }>>(Prisma.sql`
      SELECT "eventType", "scopeKey" FROM "GatewayEventWatermark" WHERE "gatewayId" = ${gateway.id}
      ORDER BY "eventType", "scopeKey"
    `);
    // Identity links are nullable after a prior fixture/group deletion. Site is the
    // durable installation boundary, so include both live and retired history.
    const energyFixtureIdentityRows = await idsBySite(tx, "EnergyFixtureIdentity", siteId);
    const energyGroupIdentityRows = await idsBySite(tx, "EnergyGroupIdentity", siteId);
    const energyAggregateRows = await aggregateIds(tx, fixtureIds, energyFixtureIdentityRows.map(row => row.id));
    const reportRows = await tx.$queryRaw<ReportRow[]>(Prisma.sql`
      SELECT "id", "siteId", "format", "attemptCount" FROM "EnergyReportJob"
      WHERE "siteId" = ${siteId} ORDER BY "id"
    `);
    const floorMapRevisionRows = await ids(tx, Prisma.sql`
      SELECT revision."id" FROM "FloorMapRevision" AS revision
      INNER JOIN "Floor" AS floor ON floor."id" = revision."floorId"
      WHERE floor."siteId" = ${siteId} ORDER BY revision."id"
    `);
    const gatewayClaimAuditRows = await ids(tx, Prisma.sql`
      SELECT "id" FROM "GatewayClaimAudit" WHERE "inventoryId" = ${inventory.id} ORDER BY "id"
    `);

    const rows = {
      gateway: gatewayRows, fixture: fixtureRows, meshNode: meshNodeRows, fixtureGroup: fixtureGroupRows,
      provisioningSession: provisioningSessionRows, command: commandRows, automationExecution: automationExecutionRows,
      monitoringIncident: monitoringIncidentRows, processedGatewayEvent: processedGatewayEventRows,
      // PostgreSQL JSONB rejects U+0000. A JSON tuple is collision-free for the
      // composite primary key and remains a valid string value in targetSnapshot.
      gatewayEventWatermark: watermarkRows.map(row => ({ id: JSON.stringify([row.eventType, row.scopeKey]) })),
      energyFixtureIdentity: energyFixtureIdentityRows, energyGroupIdentity: energyGroupIdentityRows,
      energyAggregate: energyAggregateRows, energyReport: reportRows, floorMapRevision: floorMapRevisionRows,
      gatewayClaimAudit: gatewayClaimAuditRows
    };
    const counts = Object.fromEntries(countKeys.map(key => [key, rows[key].length])) as Record<GatewayRecommissionCountKey, number>;
    const certificateCounts = {
      deviceActive: certificates.filter(row => row.purpose === "device" && row.status === "active").length,
      mqttActive: certificates.filter(row => row.purpose === "mqtt" && row.status === "active").length,
      mqttPending: certificates.filter(row => row.purpose === "mqtt" && row.status === "pending").length
    };
    const objectKeys = [...new Set(reportRows.flatMap(reportAttemptKeys))].sort();
    const snapshot = {
      version: 1,
      siteId,
      inventoryId: inventory.id,
      gatewayId: gateway.id,
      serialNumber,
      counts,
      certificates: certificateCounts,
      deletionIds: Object.fromEntries(countKeys.map(key => [key, rows[key].map(row => row.id).sort()])),
      objectKeys
    };
    const resetDigest = sha256(canonicalJson(snapshot));
    return {
      preview: { siteId, inventoryId: inventory.id, gatewayId: gateway.id, serialNumber, resetDigest, counts, certificates: certificateCounts },
      snapshot,
      objectKeys
    };
  }
}

async function ids(tx: Pick<Prisma.TransactionClient, "$queryRaw">, query: Prisma.Sql) {
  return tx.$queryRaw<IdRow[]>(query);
}

async function idsBySite(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  table: "EnergyFixtureIdentity" | "EnergyGroupIdentity",
  siteId: string
) {
  const query = table === "EnergyFixtureIdentity"
    ? Prisma.sql`SELECT "id" FROM "EnergyFixtureIdentity" WHERE "siteId" = ${siteId} ORDER BY "id"`
    : Prisma.sql`SELECT "id" FROM "EnergyGroupIdentity" WHERE "siteId" = ${siteId} ORDER BY "id"`;
  return ids(tx, query);
}

async function aggregateIds(tx: Pick<Prisma.TransactionClient, "$queryRaw">, fixtureIds: string[], energyFixtureIds: string[]) {
  const rows: IdRow[] = [];
  if (fixtureIds.length) {
    rows.push(...await ids(tx, Prisma.sql`
      SELECT 'usage:' || "id" AS "id" FROM "EnergyUsage" WHERE "fixtureId" IN (${Prisma.join(fixtureIds)})
      UNION ALL
      SELECT 'cursor:' || "fixtureId" AS "id" FROM "FixtureEnergyStateCursor" WHERE "fixtureId" IN (${Prisma.join(fixtureIds)})
      ORDER BY "id"
    `));
  }
  if (energyFixtureIds.length) {
    rows.push(...await ids(tx, Prisma.sql`
      SELECT 'daily:' || "id" AS "id" FROM "FixtureEnergyDailyAggregate" WHERE "energyFixtureId" IN (${Prisma.join(energyFixtureIds)})
      UNION ALL
      SELECT 'hourly:' || "id" AS "id" FROM "FixtureEnergyHourlyAggregate" WHERE "energyFixtureId" IN (${Prisma.join(energyFixtureIds)})
      ORDER BY "id"
    `));
  }
  return rows.sort((left, right) => left.id.localeCompare(right.id));
}

function requiredText(value: string) {
  if (typeof value !== "string" || !value.trim()) throw topologyError();
  return value.trim();
}

function topologyError() {
  return new NotFoundException("gateway recommission topology not found");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function isActiveJobConflict(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}
