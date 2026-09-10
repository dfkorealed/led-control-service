import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import {
  CreateDimmingCommandInput,
  DimmingTarget,
  gatewayDimmingCommandDraftV2Schema,
  isGatewayHeartbeatFresh,
  mqttTopicsV2
} from "@led-control/shared";
import { Prisma } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { SiteAccessService } from "../access/site-access.service";
import { AutomationClock } from "../automation/automation-clock";
import { AutomationSnapshotService } from "../automation/automation-snapshot.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { MeshControlGroupService } from "../mesh-control-groups/mesh-control-group.service";
import { PrismaService } from "../prisma/prisma.service";
import { CommandDispatchService } from "./command-dispatch.service";

type DeliveryMode = "unicast" | "parallel_unicast" | "mesh_group";

interface FixtureGatewayMapping {
  fixtureId: string;
  fixtureName: string;
  floorId: string;
  status: "online" | "offline" | "fault";
  gatewayId: string | null;
  gatewayLastHeartbeatAt: Date | null;
}

interface ResolvedControlTarget {
  fixtureIds: string[];
  gatewayId: string;
  deliveryMode: DeliveryMode;
  destinationAddress?: string;
  meshControlGroupId?: string;
  meshControlGroupVersion?: number;
}

type FixtureRow = {
  id: string;
  floorId: string;
  name: string;
  status: "online" | "offline" | "fault";
  meshNode: {
    gatewayId: string;
    gateway: { lastHeartbeatAt: Date | null };
  } | null;
};

const fixtureControlSelect = {
  id: true,
  floorId: true,
  name: true,
  status: true,
  meshNode: {
    select: {
      gatewayId: true,
      gateway: { select: { lastHeartbeatAt: true } }
    }
  }
} satisfies Prisma.FixtureSelect;

const idempotentCommandInclude = {
  manualOverride: { select: { overrideUntil: true } },
  dispatches: {
    orderBy: { createdAt: "asc" as const },
    select: { deliveryMode: true }
  }
} satisfies Prisma.CommandInclude;

type IdempotentCommand = Prisma.CommandGetPayload<{ include: typeof idempotentCommandInclude }>;

const DEFAULT_OVERRIDE_DURATION_MS = 60 * 60 * 1000;
const MAX_OVERRIDE_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

@Injectable()
export class CommandsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatchService: CommandDispatchService,
    private readonly siteAccess: SiteAccessService,
    private readonly meshControlGroups: MeshControlGroupService,
    private readonly automationSnapshot: AutomationSnapshotService,
    private readonly clock: AutomationClock
  ) {}

  async createDimmingCommand(user: AuthenticatedUser, input: CreateDimmingCommandInput) {
    if (!Number.isInteger(input.brightness) || input.brightness < 0 || input.brightness > 100) {
      throw new BadRequestException("brightness must be an integer from 0 to 100");
    }

    await this.siteAccess.assert(user, input.siteId, "control");

    const requestFingerprint = createRequestFingerprint(input.target, input.brightness, input.overrideUntil);

    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.automationSnapshot.lockMutation(tx);
        await this.siteAccess.assertControlInTransaction(tx, user, input.siteId);
        const existing = await this.findIdempotentCommand(tx, user, input, requestFingerprint);
        if (existing) return existing;

        const now = this.clock.now();
        const overrideUntil = resolveOverrideUntil(input.overrideUntil, now);

        const mappings = await this.resolveTargetMappings(tx, input.siteId, input.target);
        if (mappings.length === 0) {
          throw new BadRequestException("control target not found in the user's site");
        }
        for (const mapping of mappings) this.assertControllable(mapping, input.target.type);

        const dispatchTarget = this.dispatchService.resolveSingleGateway(mappings);
        const resolved = await this.resolveDelivery(
          tx,
          input.siteId,
          input.target,
          mappings,
          dispatchTarget.gatewayId,
          dispatchTarget.fixtureIds
        );
        const targetId = this.targetId(input.target);
        const command = await tx.command.create({
          data: {
            siteId: input.siteId,
            requestedBy: user.id,
            clientRequestId: input.clientRequestId,
            requestFingerprint,
            targetType: input.target.type,
            targetId,
            targetFixtureIds: resolved.fixtureIds,
            brightness: input.brightness
          }
        });
        const manualOverride = await tx.manualOverride.create({
          data: {
            siteId: input.siteId,
            gatewayId: resolved.gatewayId,
            commandId: command.id,
            requestedById: user.id,
            brightnessPercent: input.brightness,
            startedAt: now,
            overrideUntil,
            fixtures: {
              createMany: {
                data: resolved.fixtureIds.map((fixtureId) => ({
                  fixtureId
                }))
              }
            }
          }
        });

        const gateway = await tx.gateway.update({
          where: { id: resolved.gatewayId },
          data: { nextCommandSequence: { increment: 1 } },
          select: { id: true, siteId: true, nextCommandSequence: true }
        });
        if (gateway.siteId !== input.siteId) {
          throw new BadRequestException("gateway does not belong to command site");
        }
        const sequence = Number(gateway.nextCommandSequence);
        if (!Number.isSafeInteger(sequence)) throw new Error("gateway command sequence exceeded safe integer range");

        const idempotencyKey = randomUUID();
        const dispatch = await tx.commandDispatch.create({
          data: {
            commandId: command.id,
            gatewayId: gateway.id,
            idempotencyKey,
            sequence,
            deliveryMode: resolved.deliveryMode,
            destinationAddress: resolved.destinationAddress ?? null,
            meshControlGroupId: resolved.meshControlGroupId ?? null,
            meshControlGroupVersion: resolved.meshControlGroupVersion ?? null
          }
        });
        await tx.commandFixtureResult.createMany({
          data: resolved.fixtureIds.map((fixtureId) => ({ dispatchId: dispatch.id, fixtureId }))
        });
        const payload = gatewayDimmingCommandDraftV2Schema.parse({
          commandId: command.id,
          dispatchId: dispatch.id,
          idempotencyKey,
          sequence,
          siteId: command.siteId,
          gatewayId: gateway.id,
          targetType: command.targetType,
          targetId: command.targetId,
          targetFixtureIds: resolved.fixtureIds,
          deliveryMode: resolved.deliveryMode,
          ...(resolved.destinationAddress ? { destinationAddress: resolved.destinationAddress } : {}),
          ...(resolved.meshControlGroupId
            ? {
              meshControlGroupId: resolved.meshControlGroupId,
              meshControlGroupVersion: resolved.meshControlGroupVersion
            }
            : {}),
          brightness: command.brightness,
          requestedBy: command.requestedBy,
          requestedAt: command.createdAt.toISOString(),
          overrideUntil: manualOverride.overrideUntil.toISOString()
        });
        await tx.mqttOutbox.create({
          data: {
            dispatchId: dispatch.id,
            topic: mqttTopicsV2.gatewayCommand(command.siteId, gateway.id, "dimming"),
            payload
          }
        });

        return this.toCreateResponse({
          ...command,
          manualOverride,
          dispatches: [{ deliveryMode: resolved.deliveryMode }]
        });
      });
    } catch (error) {
      if (!isClientRequestUniqueConflict(error)) throw error;

      // A failed PostgreSQL transaction cannot be reused after P2002. Re-read in a fresh transaction.
      return this.prisma.$transaction(async (tx) => {
        await this.automationSnapshot.lockMutation(tx);
        await this.siteAccess.assertControlInTransaction(tx, user, input.siteId);
        const existing = await this.findIdempotentCommand(tx, user, input, requestFingerprint);
        if (!existing) throw error;
        return existing;
      });
    }
  }

  private async findIdempotentCommand(
    tx: Prisma.TransactionClient,
    user: AuthenticatedUser,
    input: CreateDimmingCommandInput,
    requestFingerprint: string
  ) {
    const existing = await tx.command.findUnique({
      where: {
        siteId_requestedBy_clientRequestId: {
          siteId: input.siteId,
          requestedBy: user.id,
          clientRequestId: input.clientRequestId
        }
      },
      include: idempotentCommandInclude
    });
    if (!existing) return null;
    // Pre-Task 10 commands have no ManualOverride and hash only target/brightness.
    // Limit this fallback to omitted overrides so a timed payload cannot reuse a legacy request ID.
    const matchesLegacyFingerprint = !existing.manualOverride
      && input.overrideUntil === undefined
      && existing.requestFingerprint === createLegacyRequestFingerprint(input.target, input.brightness);
    if (existing.requestFingerprint !== requestFingerprint && !matchesLegacyFingerprint) {
      throw new ConflictException({ code: "client_request_id_payload_conflict" });
    }
    return this.toCreateResponse(existing);
  }

  private toCreateResponse(command: IdempotentCommand) {
    const { dispatches, manualOverride, ...storedCommand } = command;
    const deliveryMode = dispatches[0]?.deliveryMode;
    if (!isDeliveryMode(deliveryMode)) throw new Error("stored command delivery mode is invalid");
    const fixtureIds = Array.isArray(command.targetFixtureIds)
      ? command.targetFixtureIds.filter((fixtureId): fixtureId is string => typeof fixtureId === "string")
      : [];

    return {
      ...storedCommand,
      dispatchCount: dispatches.length,
      selectedTargetCount: fixtureIds.length,
      transmissionCount: deliveryMode === "mesh_group" ? dispatches.length : fixtureIds.length,
      deliveryMode,
      ...(manualOverride ? { overrideUntil: manualOverride.overrideUntil.toISOString() } : {}),
      terminalStatusUrl: `/commands/${storedCommand.id}`
    };
  }

  private async resolveTargetMappings(
    tx: Prisma.TransactionClient,
    siteId: string,
    target: DimmingTarget
  ): Promise<FixtureGatewayMapping[]> {
    if (target.type === "fixture" || target.type === "fixtures") {
      const requestedIds = target.type === "fixture" ? [target.fixtureId] : [...target.fixtureIds].sort();
      const fixtures = await tx.fixture.findMany({
        where: { id: { in: requestedIds }, floor: { siteId } },
        select: fixtureControlSelect
      });
      if (fixtures.length !== requestedIds.length) return [];
      return this.toMappings(fixtures as FixtureRow[]);
    }

    if (target.type === "floor") {
      const floor = await tx.floor.findFirst({
        where: { id: target.floorId, siteId },
        select: { id: true, fixtures: { select: fixtureControlSelect } }
      });
      return floor ? this.toMappings(floor.fixtures as FixtureRow[]) : [];
    }

    const group = await tx.fixtureGroup.findFirst({
      where: {
        id: target.groupId,
        siteId,
        lifecycleStatus: "active",
        groupFixtures: { every: { fixture: { floor: { siteId } } } }
      },
      select: {
        id: true,
        groupFixtures: {
          select: { fixtureId: true, fixture: { select: fixtureControlSelect } }
        }
      }
    });
    return group
      ? this.toMappings(group.groupFixtures.map((item) => item.fixture) as FixtureRow[])
      : [];
  }

  private toMappings(fixtures: FixtureRow[]): FixtureGatewayMapping[] {
    return fixtures.map((fixture) => ({
      fixtureId: fixture.id,
      fixtureName: fixture.name,
      floorId: fixture.floorId,
      status: fixture.status,
      gatewayId: fixture.meshNode?.gatewayId ?? null,
      gatewayLastHeartbeatAt: fixture.meshNode?.gateway.lastHeartbeatAt ?? null
    })).sort((left, right) => left.fixtureId.localeCompare(right.fixtureId));
  }

  private async resolveDelivery(
    tx: Prisma.TransactionClient,
    siteId: string,
    target: DimmingTarget,
    mappings: FixtureGatewayMapping[],
    gatewayId: string,
    fixtureIds: string[]
  ): Promise<ResolvedControlTarget> {
    if (target.type === "fixture" || (target.type === "fixtures" && fixtureIds.length === 1)) {
      return { fixtureIds, gatewayId, deliveryMode: "unicast" };
    }
    if (target.type === "floor") {
      const destination = await this.meshControlGroups.getReadyDestination(tx, {
        type: "floor",
        floorId: target.floorId,
        gatewayId
      });
      return this.toMeshGroupTarget(fixtureIds, gatewayId, destination);
    }
    if (target.type === "group") {
      const destination = await this.meshControlGroups.getReadyDestination(tx, {
        type: "fixture_group",
        fixtureGroupId: target.groupId,
        gatewayId
      });
      return this.toMeshGroupTarget(fixtureIds, gatewayId, destination);
    }

    const promoted = await this.findExactReadyDestination(tx, siteId, gatewayId, mappings, fixtureIds);
    return promoted
      ? this.toMeshGroupTarget(fixtureIds, gatewayId, promoted)
      : { fixtureIds, gatewayId, deliveryMode: "parallel_unicast" };
  }

  private async findExactReadyDestination(
    tx: Prisma.TransactionClient,
    siteId: string,
    gatewayId: string,
    mappings: FixtureGatewayMapping[],
    fixtureIds: string[]
  ) {
    const floorIds = [...new Set(mappings.map((mapping) => mapping.floorId))];
    const floors = await tx.floor.findMany({
      where: { id: { in: floorIds }, siteId },
      select: { id: true, fixtures: { select: { id: true } } }
    });
    const exactFloors = floors
      .filter((floor) => this.sameFixtureSet(fixtureIds, floor.fixtures.map((fixture) => fixture.id)))
      .sort((left, right) => left.id.localeCompare(right.id));
    for (const floor of exactFloors) {
      const destination = await this.tryReadyDestination(tx, {
        type: "floor" as const,
        floorId: floor.id,
        gatewayId
      });
      if (destination) return destination;
    }

    const groups = await tx.fixtureGroup.findMany({
      where: {
        siteId,
        lifecycleStatus: "active",
        AND: [
          { groupFixtures: { some: { fixtureId: { in: fixtureIds } } } },
          { groupFixtures: { every: { fixture: { floor: { siteId } } } } }
        ]
      },
      select: { id: true, groupFixtures: { select: { fixtureId: true } } }
    });
    const exactGroups = groups
      .filter((group) => this.sameFixtureSet(fixtureIds, group.groupFixtures.map((item) => item.fixtureId)))
      .sort((left, right) => left.id.localeCompare(right.id));
    for (const group of exactGroups) {
      const destination = await this.tryReadyDestination(tx, {
        type: "fixture_group" as const,
        fixtureGroupId: group.id,
        gatewayId
      });
      if (destination) return destination;
    }
    return null;
  }

  private async tryReadyDestination(
    tx: Prisma.TransactionClient,
    input:
      | { type: "floor"; floorId: string; gatewayId: string }
      | { type: "fixture_group"; fixtureGroupId: string; gatewayId: string }
  ) {
    try {
      return await this.meshControlGroups.getReadyDestination(tx, input);
    } catch (error) {
      if (error instanceof BadRequestException && error.message === "mesh control group is not ready") return null;
      throw error;
    }
  }

  private toMeshGroupTarget(
    fixtureIds: string[],
    gatewayId: string,
    destination: { groupId: string; groupAddress: string; configurationVersion: number }
  ): ResolvedControlTarget {
    return {
      fixtureIds,
      gatewayId,
      deliveryMode: "mesh_group",
      destinationAddress: destination.groupAddress,
      meshControlGroupId: destination.groupId,
      meshControlGroupVersion: destination.configurationVersion
    };
  }

  private sameFixtureSet(expected: string[], actual: string[]) {
    if (expected.length !== actual.length) return false;
    const sortedActual = [...actual].sort();
    return expected.every((fixtureId, index) => fixtureId === sortedActual[index]);
  }

  private targetId(target: DimmingTarget) {
    if (target.type === "fixture") return target.fixtureId;
    if (target.type === "floor") return target.floorId;
    if (target.type === "group") return target.groupId;
    return null;
  }

  private assertControllable(mapping: FixtureGatewayMapping, targetType: DimmingTarget["type"]) {
    const prefix = targetType === "fixture" ? null : `target contains uncontrollable fixture: ${mapping.fixtureName}`;
    if (!mapping.gatewayId) throw new BadRequestException(prefix ?? "fixture is not mapped to a gateway");
    if (!isGatewayHeartbeatFresh(mapping.gatewayLastHeartbeatAt, new Date())) {
      throw new BadRequestException(prefix ?? "gateway is offline");
    }
    if (mapping.status === "fault") throw new BadRequestException(prefix ?? "fixture is in fault state");
    if (mapping.status === "offline") throw new BadRequestException(prefix ?? "fixture is offline");
  }
}

function createRequestFingerprint(target: DimmingTarget, brightness: number, requestedOverrideUntil?: string) {
  return createFingerprint(target, brightness, requestedOverrideUntil ?? null);
}

function createLegacyRequestFingerprint(target: DimmingTarget, brightness: number) {
  return createFingerprint(target, brightness);
}

function createFingerprint(target: DimmingTarget, brightness: number, overrideUntil?: string | null) {
  const canonicalTarget = target.type === "fixture"
    ? [target.type, target.fixtureId]
    : target.type === "fixtures"
      ? [target.type, ...target.fixtureIds.slice().sort()]
      : target.type === "floor"
        ? [target.type, target.floorId]
        : [target.type, target.groupId];
  const payload = overrideUntil === undefined
    ? { target: canonicalTarget, brightness }
    : { target: canonicalTarget, brightness, overrideUntil };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function resolveOverrideUntil(rawOverrideUntil: unknown, now: Date) {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("clock returned an invalid current time");
  if (rawOverrideUntil === undefined) return new Date(nowMs + DEFAULT_OVERRIDE_DURATION_MS);
  if (typeof rawOverrideUntil !== "string" || !isIsoInstant(rawOverrideUntil)) {
    throw new BadRequestException("overrideUntil must be an ISO instant");
  }

  const overrideUntil = new Date(rawOverrideUntil);
  if (!Number.isFinite(overrideUntil.getTime()) || overrideUntil.toISOString().slice(0, 10) !== rawOverrideUntil.slice(0, 10)) {
    throw new BadRequestException("overrideUntil must be an ISO instant");
  }
  if (overrideUntil.getTime() <= nowMs) {
    throw new BadRequestException("overrideUntil must be in the future");
  }
  if (overrideUntil.getTime() > nowMs + MAX_OVERRIDE_DURATION_MS) {
    throw new BadRequestException("overrideUntil must be within 30 days");
  }
  return overrideUntil;
}

function isIsoInstant(value: string) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value);
}

function isDeliveryMode(value: unknown): value is DeliveryMode {
  return value === "unicast" || value === "parallel_unicast" || value === "mesh_group";
}

function isClientRequestUniqueConflict(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error) || error.code !== "P2002") return false;
  const target = "meta" in error && error.meta && typeof error.meta === "object" && "target" in error.meta
    ? error.meta.target
    : null;
  const fields = Array.isArray(target) ? target : typeof target === "string" ? [target] : [];
  return fields.some((field) => typeof field === "string" && (
    field === "Command_siteId_requestedBy_clientRequestId_key"
    || field.includes("siteId") && field.includes("requestedBy") && field.includes("clientRequestId")
  )) || ["siteId", "requestedBy", "clientRequestId"].every((field) => fields.includes(field));
}
