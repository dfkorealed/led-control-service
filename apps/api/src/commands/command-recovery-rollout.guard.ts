import { Injectable, OnModuleInit } from "@nestjs/common";

/**
 * A process env toggle cannot declare the Get recovery protocol ready while
 * this build intentionally omits its POST route. Refuse startup rather than
 * hiding the legacy status-check path behind a 410 with no usable replacement.
 * Remove this hard gate only in the same change that registers and verifies
 * the Get publisher, ACK, timeout, late-Set race, and user POST route.
 */
@Injectable()
export class CommandRecoveryRolloutGuard implements OnModuleInit {
  onModuleInit() {
    // No production scheduler may enable physical deletion while Gateway
    // absolute-expiry, broker DUP and protected worker credentials remain an
    // external rollout gate. This is deliberately independent of the read flag.
    if (process.env.COMMAND_RETENTION_PURGE_ENABLED === "1") {
      throw new Error("command physical purge is not certified in this build");
    }
    if (process.env.COMMAND_RECOVERY_ACTIONS_ENABLED === "1") {
      throw new Error("recovery POST route is not registered in this build");
    }
  }
}
