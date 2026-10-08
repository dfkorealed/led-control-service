import { ConflictException, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { bioSensorCatalogV1Schema, bioSensorCatalogTopics, bioSensorPreparationAckV1Schema,
  bioSensorPreparationCommandV1Schema, bioSensorPreparationTopics } from "@led-control/shared";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { MqttService } from "../mqtt/mqtt.service";
import { canonicalPayloadHash } from "./automation-payload-hash";
import { lockBioSensorCatalog, lockBioSensorGateway, loadBioSensorBinding } from "./bio-sensor-catalog-locks";
import { BioSensorProfilesService } from "./bio-sensor-profiles.service";

type Kind = "catalog" | "command" | "ack";
type Permit = { id: string; kind: Kind; token: string; topic: string; payload: Prisma.JsonValue; expiresAt?: Date };

@Injectable()
export class BioSensorCatalogOutboxService implements OnModuleInit {
  private readonly logger = new Logger(BioSensorCatalogOutboxService.name);
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private stopped = false;
  private gatewayCursor = "";
  constructor(private readonly prisma: PrismaService, private readonly mqtt: MqttService,
    private readonly profiles: BioSensorProfilesService) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      if (this.stopped || this.active) return;
      this.active = this.processBatch().catch(() => this.logger.error("BIO catalog/preparation delivery failed"))
        .finally(() => { this.active = undefined; });
    }, 1_000);
  }
  async stopAndDrain() { this.stopped = true; clearInterval(this.timer); await this.active; }

  async processBatch() {
    const gateways = await this.prisma.gateway.findMany({ where: { id: { gt: this.gatewayCursor }, assignmentVersion: { gt: 0 }, claimedAt: { not: null } }, orderBy: { id: "asc" }, take: 50 });
    this.gatewayCursor = gateways.length === 50 ? gateways[49].id : "";
    for (const gateway of gateways) {
      if (this.stopped) return;
      try { await this.profiles.buildCurrentCatalog(gateway.siteId, gateway.id); } catch (error) {
        if (!(error instanceof ConflictException)) throw error;
        // A disabled/expired identity has no current delivery authority.
      }
    }
    const now = new Date();
    await this.prisma.bioSensorPreparationOperation.updateMany({ where: { status: "pending", expiresAt: { lte: now } }, data: { status: "timed_out", lockedBy: null, leaseExpiresAt: null } });
    const catalogs = await this.prisma.bioSensorCatalogDelivery.findMany({ where: { status: "pending", supersededAt: null, nextAttemptAt: { lte: now } }, orderBy: { nextAttemptAt: "asc" }, take: 10 });
    const commands = await this.prisma.bioSensorPreparationOperation.findMany({ where: { status: "pending", supersededAt: null, expiresAt: { gt: now }, nextAttemptAt: { lte: now } }, orderBy: { nextAttemptAt: "asc" }, take: 10 });
    const acknowledgements = await this.prisma.bioSensorPreparationOperation.findMany({ where: { ackHash: { not: null }, ackPublishedAt: null, ackNextAttemptAt: { lte: now } }, orderBy: { ackNextAttemptAt: "asc" }, take: 10 });
    for (const [kind, rows] of [["catalog", catalogs], ["command", commands], ["ack", acknowledgements]] as const) {
      for (const row of rows) {
        if (this.stopped) return;
        const id = "deliveryId" in row ? row.deliveryId : row.commandId;
        let permit: Permit | null;
        try { permit = await this.claim(kind, id); } catch (error) {
          if (!(error instanceof ConflictException)) throw error;
          continue;
        }
        if (permit) await this.publish(permit);
      }
    }
  }

  private claim(kind: Kind, id: string): Promise<Permit | null> {
    return this.prisma.$transaction(async tx => {
      const revision = await lockBioSensorCatalog(tx); const now = new Date(); const token = randomUUID();
      if (kind === "catalog") {
        const row = await tx.bioSensorCatalogDelivery.findUnique({ where: { deliveryId: id } });
        if (!row || row.status !== "pending" || row.supersededAt || row.nextAttemptAt > now || row.leaseExpiresAt && row.leaseExpiresAt > now) return null;
        const assignment = await lockBioSensorGateway(tx, row, now);
        if (assignment !== row.assignmentVersion || revision !== row.catalogRevision) return null;
        const payload = bioSensorCatalogV1Schema.parse(row.payload);
        if (canonicalPayloadHash(payload) !== row.payloadHash) throw new ConflictException("BIO catalog envelope changed");
        await tx.bioSensorCatalogDelivery.update({ where: { deliveryId: id }, data: { lockedBy: token, leaseExpiresAt: new Date(now.getTime() + 10_000), attempts: { increment: 1 } } });
        return { id, kind, token, topic: bioSensorCatalogTopics.command(row.siteId, row.gatewayId), payload: row.payload };
      }
      const row = await tx.bioSensorPreparationOperation.findUnique({ where: { commandId: id } });
      if (!row) return null;
      if (kind === "ack") {
        if (!row.ackHash || row.ackPublishedAt || row.ackNextAttemptAt > now || row.ackLeaseExpiresAt && row.ackLeaseExpiresAt > now) return null;
        const assignment = await lockBioSensorGateway(tx, row, now);
        if (assignment !== row.assignmentVersion) return null;
        const payload = bioSensorPreparationAckV1Schema.parse(row.ackPayload);
        if (canonicalPayloadHash(payload) !== row.ackHash) throw new ConflictException("BIO preparation ACK changed");
        await tx.bioSensorPreparationOperation.update({ where: { commandId: id }, data: { ackLockedBy: token,
          ackLeaseExpiresAt: new Date(now.getTime() + 10_000), ackAttempts: { increment: 1 } } });
        return { id, kind, token, topic: bioSensorPreparationTopics.ack(row.siteId, row.gatewayId), payload: row.ackPayload! };
      }
      if (row.status !== "pending" || row.supersededAt || row.expiresAt <= now || row.nextAttemptAt > now || row.leaseExpiresAt && row.leaseExpiresAt > now) return null;
      const binding = await loadBioSensorBinding(tx, row, now);
      if (binding.bindingHash !== row.bindingHash || row.catalogRevision !== revision) {
        await tx.bioSensorPreparationOperation.update({ where: { commandId: id }, data: { status: "unverified" } });
        return null;
      }
      const site = await tx.site.findUnique({ where: { id: row.siteId }, include: { admin: true } });
      if (site?.adminUserId !== row.actorId || site.admin?.status !== "active" || site.admin.role !== "admin") {
        await tx.bioSensorPreparationOperation.update({ where: { commandId: id }, data: { status: "unverified" } });
        return null;
      }
      const catalog = await tx.bioSensorCatalogDelivery.findUnique({ where: { siteId_gatewayId_assignmentVersion_catalogRevision: {
        siteId: row.siteId, gatewayId: row.gatewayId, assignmentVersion: row.assignmentVersion, catalogRevision: revision } } });
      // First setup must observe a confirmed catalog before any preparation GET
      // or SET. A published PUBACK is not application-level catalog acceptance.
      if (!catalog?.appliedAt || catalog.supersededAt || !["applied", "duplicate"].includes(catalog.status)) return null;
      const command = bioSensorPreparationCommandV1Schema.parse(row.payload);
      if (canonicalPayloadHash(command) !== row.payloadHash) throw new ConflictException("BIO preparation command changed");
      await tx.bioSensorPreparationOperation.update({ where: { commandId: id }, data: { lockedBy: token,
        leaseExpiresAt: new Date(now.getTime() + 10_000), attempts: { increment: 1 } } });
      return { id, kind, token, topic: bioSensorPreparationTopics.command(row.siteId, row.gatewayId), payload: row.payload, expiresAt: row.expiresAt };
    });
  }

  private async publish(permit: Permit) {
    const remaining = permit.expiresAt ? permit.expiresAt.getTime() - Date.now() : 2_000;
    let success = false;
    try {
      if (remaining > 0) {
        // No database transaction stays open during network I/O. Every wire
        // envelope carries assignment/catalog/command identity; reassignment
        // after the permit makes it stale at the consumer, never new authority.
        await this.mqtt.publishTopic(permit.topic, permit.payload, { timeoutMs: Math.min(2_000, remaining),
          messageExpiryInterval: Math.max(1, Math.ceil(Math.min(2_000, remaining) / 1_000)) });
        success = true;
      }
    } catch { /* PUBACK uncertainty retries the same immutable envelope. */ }
    const now = new Date();
    if (permit.kind === "catalog") {
      await this.prisma.bioSensorCatalogDelivery.updateMany({ where: { deliveryId: permit.id, lockedBy: permit.token,
        leaseExpiresAt: { gt: now }, status: "pending", supersededAt: null }, data: {
        ...(success ? { publishedAt: now } : {}), nextAttemptAt: new Date(now.getTime() + 2_000), lockedBy: null, leaseExpiresAt: null } });
    } else if (permit.kind === "command") {
      await this.prisma.bioSensorPreparationOperation.updateMany({ where: { commandId: permit.id, lockedBy: permit.token,
        leaseExpiresAt: { gt: now }, status: "pending", supersededAt: null }, data: {
        ...(success ? { publishedAt: now } : {}), nextAttemptAt: new Date(now.getTime() + 2_000), lockedBy: null, leaseExpiresAt: null } });
    } else {
      await this.prisma.bioSensorPreparationOperation.updateMany({ where: { commandId: permit.id, ackLockedBy: permit.token,
        ackLeaseExpiresAt: { gt: now }, ackPublishedAt: null }, data: {
        ...(success ? { ackPublishedAt: now } : {}), ackNextAttemptAt: new Date(now.getTime() + 2_000), ackLockedBy: null, ackLeaseExpiresAt: null } });
    }
  }
}
