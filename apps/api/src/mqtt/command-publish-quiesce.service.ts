import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CommandSetMqttService } from "./command-set-mqtt.service";
import { COMMAND_PUBLISH_PERMIT_KEY, OutboxPublisherService } from "./outbox-publisher.service";

/** Local member ACKs never attest broker admission, session drain or RF safety. */
@Injectable()
export class CommandPublishQuiesceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CommandPublishQuiesceService.name);
  private timer: NodeJS.Timeout | null = null;
  private observing: Promise<void> | null = null;

  constructor(private readonly prisma: PrismaService,
    @Optional() private readonly publisher?: OutboxPublisherService,
    @Optional() private readonly egress?: CommandSetMqttService) {}

  onModuleInit() {
    if (process.env.COMMAND_SET_EGRESS_ENABLED !== "1") return;
    this.timer = setInterval(() => {
      if (this.observing) return;
      this.observing = this.acknowledgeLocal().catch(() => {
        this.logger.error("Command Set quiesce member acknowledgement unavailable");
      }).finally(() => { this.observing = null; });
    }, 1000);
    this.timer.unref();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.observing;
  }

  async begin() {
    const generation = await this.prisma.$transaction(async tx => {
      // Never acquire automation mutation after this exclusive permit. Existing
      // publishers take automation -> shared permit; reversing that order can
      // deadlock their final state writes. No broker/drain wait belongs here.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${COMMAND_PUBLISH_PERMIT_KEY})`;
      const epoch = await tx.commandPublishEpoch.findFirst({ where: { status: { in: ["active", "quiescing"] } } });
      if (!epoch) throw new Error("command publish quiesce generation unavailable");
      if (epoch.status === "active") await tx.commandPublishEpoch.update({
        where: { generation: epoch.generation }, data: { status: "quiescing" }
      });
      return epoch.generation;
    }, { maxWait: 2000, timeout: 25_000 });
    // The transaction/permit is already released, including before local close.
    await this.acknowledgeLocal();
    const members = await this.prisma.commandPublishMember.findMany({ where: { generation }, orderBy: { workerId: "asc" } });
    const pendingWorkerIds = members.filter(member => member.quiesceAckAt === null).map(member => member.workerId);
    return { generation, allMembersAcknowledged: members.length > 0 && pendingWorkerIds.length === 0,
      pendingWorkerIds, brokerFenced: false as const };
  }

  async acknowledgeLocal() {
    const identity = this.egress?.memberIdentity;
    if (!identity || !this.publisher || this.publisher.publishWorkerId !== identity.workerId) return;
    const member = await this.prisma.commandPublishMember.findFirst({ where: {
      ...identity, quiesceAckAt: null, epoch: { status: "quiescing" }
    } });
    if (!member) return;
    await this.publisher.stopAndDrain();
    await this.egress!.close();
    // A missing/unresponsive process never gets an ACK from elapsed time. Close
    // is merely local cessation; Task 5 must still deny deferred QoS1 at broker.
    await this.prisma.commandPublishMember.updateMany({ where: { ...identity, quiesceAckAt: null,
      epoch: { status: "quiescing" } }, data: { quiesceAckAt: new Date() } });
  }
}
