import { Injectable, NotFoundException } from "@nestjs/common";
import { SiteAccessService } from "../access/site-access.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";

type ResultStatus = "pending" | "succeeded" | "failed" | "timed_out";

@Injectable()
export class CommandStatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly siteAccess: SiteAccessService
  ) {}

  async getCommand(user: AuthenticatedUser, commandId: string) {
    const scopedCommand = await this.prisma.command.findUnique({
      where: { id: commandId },
      select: { siteId: true }
    });
    if (!scopedCommand) throw new NotFoundException("command not found");
    await this.siteAccess.assert(user, scopedCommand.siteId, "read");

    const command = await this.prisma.command.findUnique({
      where: { id: commandId },
      include: {
        dispatches: {
          orderBy: { createdAt: "asc" },
          include: {
            gateway: { select: { id: true, name: true } },
            fixtureResults: {
              orderBy: { fixture: { name: "asc" } },
              include: { fixture: { select: { name: true } } }
            }
          }
        }
      }
    });
    if (!command) throw new NotFoundException("command not found");

    const fixtureResults = command.dispatches.flatMap((dispatch) => dispatch.fixtureResults);
    const statuses = fixtureResults.map((result) => result.status as ResultStatus);
    const stage = deriveCommandStage(
      command.status,
      command.dispatches.map((dispatch) => dispatch.status),
      statuses
    );

    return {
      id: command.id,
      siteId: command.siteId,
      targetType: command.targetType,
      targetId: command.targetId,
      brightness: command.brightness,
      status: command.status,
      stage,
      errorMessage: command.errorMessage,
      dispatchCount: command.dispatches.length,
      completedFixtureCount: statuses.filter((status) => status !== "pending").length,
      totalFixtureCount: statuses.length,
      createdAt: command.createdAt.toISOString(),
      updatedAt: command.updatedAt.toISOString(),
      dispatches: command.dispatches.map((dispatch) => ({
        id: dispatch.id,
        status: dispatch.status,
        gateway: dispatch.gateway,
        publishedAt: toIso(dispatch.publishedAt),
        acceptedAt: toIso(dispatch.acceptedAt),
        completedAt: toIso(dispatch.completedAt),
        errorCode: dispatch.errorCode,
        errorMessage: dispatch.errorMessage,
        results: dispatch.fixtureResults.map((result) => ({
          fixtureId: result.fixtureId,
          fixtureName: result.fixture.name,
          status: result.status,
          brightness: result.brightness,
          faultCode: result.faultCode,
          errorMessage: result.errorMessage,
          occurredAt: toIso(result.occurredAt)
        }))
      }))
    };
  }
}

function deriveCommandStage(commandStatus: string, dispatchStatuses: string[], resultStatuses: ResultStatus[]) {
  const succeeded = resultStatuses.filter((status) => status === "succeeded").length;
  const failed = resultStatuses.filter((status) => status === "failed" || status === "timed_out").length;
  if (succeeded > 0 && failed > 0) return "partial_failed" as const;
  if (resultStatuses.length > 0 && succeeded === resultStatuses.length) return "completed" as const;
  if (resultStatuses.includes("timed_out") || dispatchStatuses.includes("timed_out")) return "timed_out" as const;
  if (commandStatus === "failed" || dispatchStatuses.includes("failed") || failed > 0) return "failed" as const;
  if (dispatchStatuses.includes("accepted")) return "accepted" as const;
  if (dispatchStatuses.includes("published")) return "published" as const;
  return "queued" as const;
}

function toIso(value: Date | null | undefined) {
  return value?.toISOString() ?? null;
}
