import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CommandSafetyDigest, CommandSafetyKeyUnavailableError } from "./command-safety-digest";

/**
 * An old status-check dispatch may be deleted with its expired Command after
 * every live publisher is fenced. Delayed ACKs for that dispatch are consumed
 * for MQTT PUBACK only: observations cannot safely be applied once the
 * original attempt/result rows are gone. A fresh recovery-case Get is needed.
 */
@Injectable()
export class CommandLegacyGetAckService {
  constructor(private readonly prisma: PrismaService, private readonly digest: CommandSafetyDigest) {}

  tryStoreAcceptanceAck(ack: { dispatchId: string }): Promise<boolean> {
    return this.ownsPurgedDispatch(ack.dispatchId);
  }

  tryStoreDeviceStatusAck(ack: { dispatchId: string }): Promise<boolean> {
    return this.ownsPurgedDispatch(ack.dispatchId);
  }

  private async ownsPurgedDispatch(dispatchId: string): Promise<boolean> {
    if (process.env.COMMAND_LEGACY_GET_ACK_FENCE_ENABLED !== "1") return false;
    const versions = this.digest.signAll("legacy-status-check-dispatch", [dispatchId]);
    // Old version loss must not turn an owned late ACK into an unowned legacy
    // packet. The rollout guard requires the whole keyring before this flag.
    if (await this.prisma.legacyStatusCheckDispatchFence.count({ where: {
      keyVersion: { notIn: versions.map(row => row.keyVersion) }
    } }) > 0) throw new CommandSafetyKeyUnavailableError("command safety HMAC key unavailable");
    return !!await this.prisma.legacyStatusCheckDispatchFence.findFirst({ where: {
      OR: versions.map(row => ({ dispatchDigest: row.value, keyVersion: row.keyVersion }))
    }, select: { id: true } });
  }
}
