import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, type BioRegistrationRevalidationOperation } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { bioRegistrationRevalidationRequestSchema, bioRegistrationRevalidationCommandSchema,
  bioRegistrationRevalidationResultSchema } from "@led-control/shared";
import { SiteAccessService } from "../access/site-access.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { CommandDbClockHealth } from "../mqtt/command-db-clock-health.service";
import { PrismaService } from "../prisma/prisma.service";
import { bioRegistrationRevalidationHash, loadLockedBioRegistrationBinding } from "./bio-registration-revalidation-binding";

export interface BioRegistrationRevalidationView {
  commandId: string; siteId: string; gatewayId: string; fixtureId: string;
  status: "pending" | "observed" | "unknown" | "timed_out";
  observedMode: "sensor" | "force-on" | "force-off" | null;
  requestedAt: string; expiresAt: string; applyDeadlineAt: string; supersededAt: string | null; appliedAt: string | null;
}

@Injectable()
export class BioRegistrationRevalidationService {
  constructor(private readonly prisma: PrismaService, private readonly access: SiteAccessService,
    private readonly clock: CommandDbClockHealth) {}

  async create(user: AuthenticatedUser, input: unknown): Promise<BioRegistrationRevalidationView> {
    const parsed = bioRegistrationRevalidationRequestSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("invalid BIO registration revalidation request");
    const request = parsed.data;
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT "lock_automation_membership_mutation"()`;
      await this.access.assertCommissionInTransaction(tx, user, request.siteId);
      const now = await this.clock.assertHealthy(tx);
      const prior = await tx.bioRegistrationRevalidationOperation.findUnique({ where: {
        siteId_requestedById_clientRequestId: { siteId: request.siteId, requestedById: user.id, clientRequestId: request.clientRequestId }
      } });
      if (prior && (prior.fixtureId !== request.fixtureId || prior.gatewayId !== request.gatewayId ||
          prior.assignmentVersion !== request.expectedAssignmentVersion)) throw new ConflictException("BIO request identity conflict");
      const binding = await loadLockedBioRegistrationBinding(tx, request, prior?.appliedAt ? "provisioned" : "discovered", now);
      // The operation lock always follows the full registration/native/canonical chain.
      if (prior) {
        await tx.$queryRaw`SELECT "commandId" FROM "BioRegistrationRevalidationOperation" WHERE "commandId"=${prior.commandId} FOR UPDATE`;
        const current = await tx.bioRegistrationRevalidationOperation.findUniqueOrThrow({ where: { commandId: prior.commandId } });
        if (current.bindingHash !== bioRegistrationRevalidationHash(binding)) throw new ConflictException("BIO current binding changed");
        return view(current);
      }
      const commandId = randomUUID(); const expiresAt = new Date(now.getTime() + 30_000);
      const payload = bioRegistrationRevalidationCommandSchema.parse({ version: 2, purpose: "bio_registration_revalidation",
        operation: "query", commandId, siteId: binding.siteId, gatewayId: binding.gatewayId, fixtureId: binding.fixtureId,
        nodeId: binding.nodeId, assignmentVersion: binding.assignmentVersion, deviceIdentityHash: binding.deviceIdentityHash,
        meshAddress: binding.meshAddress, requestedAt: now.toISOString(), expiresAt: expiresAt.toISOString() });
      await tx.$queryRaw`SELECT "commandId" FROM "BioRegistrationRevalidationOperation" WHERE "fixtureId"=${binding.fixtureId}
        AND "supersededAt" IS NULL AND "appliedAt" IS NULL ORDER BY "commandId" FOR UPDATE`;
      await tx.bioRegistrationRevalidationOperation.updateMany({ where: { fixtureId: binding.fixtureId, supersededAt: null, appliedAt: null },
        data: { supersededAt: now } });
      const row = await tx.bioRegistrationRevalidationOperation.create({ data: { ...binding, commandId,
        requestedById: user.id, clientRequestId: request.clientRequestId, bindingSnapshot: binding as unknown as Prisma.InputJsonValue,
        bindingHash: bioRegistrationRevalidationHash(binding), payload, payloadHash: bioRegistrationRevalidationHash(payload),
        requestedAt: now, expiresAt, applyDeadlineAt: new Date(now.getTime() + 120_000), nextAttemptAt: now } });
      return view(row);
    }, { timeout: 10_000 });
  }

  async get(user: AuthenticatedUser, commandId: string): Promise<BioRegistrationRevalidationView> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(commandId)) {
      throw new BadRequestException("invalid BIO revalidation command ID");
    }
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT "lock_automation_membership_mutation"()`;
      const initial = await tx.bioRegistrationRevalidationOperation.findUnique({ where: { commandId } });
      if (!initial || initial.requestedById !== user.id) throw new NotFoundException("BIO revalidation request not found");
      await this.access.assertCommissionInTransaction(tx, user, initial.siteId);
      const now = await this.clock.assertHealthy(tx);
      const binding = await loadLockedBioRegistrationBinding(tx, { siteId: initial.siteId, gatewayId: initial.gatewayId,
        fixtureId: initial.fixtureId, expectedAssignmentVersion: initial.assignmentVersion }, initial.appliedAt ? "provisioned" : "discovered", now);
      await tx.$queryRaw`SELECT "commandId" FROM "BioRegistrationRevalidationOperation" WHERE "commandId"=${commandId} FOR UPDATE`;
      const row = await tx.bioRegistrationRevalidationOperation.findUniqueOrThrow({ where: { commandId } });
      if (row.bindingHash !== bioRegistrationRevalidationHash(binding)) throw new ConflictException("BIO current binding changed");
      return view(row);
    }, { timeout: 10_000 });
  }
}

function view(row: BioRegistrationRevalidationOperation): BioRegistrationRevalidationView {
  const parsed = row.proofAcceptedAt && bioRegistrationRevalidationResultSchema.safeParse(row.result);
  return { commandId: row.commandId, siteId: row.siteId, gatewayId: row.gatewayId, fixtureId: row.fixtureId,
    status: row.status as BioRegistrationRevalidationView["status"],
    observedMode: parsed && parsed.success && parsed.data.status === "observed" ? parsed.data.observedMode : null,
    requestedAt: row.requestedAt.toISOString(), expiresAt: row.expiresAt.toISOString(), applyDeadlineAt: row.applyDeadlineAt.toISOString(),
    supersededAt: row.supersededAt?.toISOString() ?? null, appliedAt: row.appliedAt?.toISOString() ?? null };
}
