import { Injectable } from "@nestjs/common";
import { CommandDispatchKind } from "@prisma/client";
import { OutboxPublisherService } from "./outbox-publisher.service";

/** Publishes status-check Get from the original Command while that Command is retained. */
@Injectable()
export class LegacyStatusCheckPublisherService extends OutboxPublisherService {
  protected override get dispatchKind(): CommandDispatchKind { return "status_check"; }
}
