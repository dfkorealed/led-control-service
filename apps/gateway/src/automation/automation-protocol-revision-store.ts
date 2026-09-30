import { readJsonFile, writeJsonAtomic } from "../mesh/mesh-store-file";
import { SerialTaskQueue } from "../runtime/serial-task-queue";
import type { AutomationScope } from "./automation-config-store";

type StoredRevision = AutomationScope & { schemaVersion: 1; revision: number };

function parseStoredRevision(raw: unknown): StoredRevision {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid automation protocol revision");
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== "gatewayId,revision,schemaVersion,siteId"
    || value.schemaVersion !== 1 || typeof value.siteId !== "string" || typeof value.gatewayId !== "string"
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
    throw new Error("invalid automation protocol revision");
  }
  return { schemaVersion: 1, siteId: value.siteId, gatewayId: value.gatewayId, revision: value.revision as number };
}

/** Independent of snapshot ACK retention and ordinary telemetry sequence files. */
export class AutomationProtocolRevisionStore {
  private readonly queue = new SerialTaskQueue();
  constructor(private readonly path: string, private readonly scope: AutomationScope,
    private readonly write: (path: string, value: unknown) => Promise<void> = writeJsonAtomic) {}

  next() {
    return this.queue.run(async () => {
      const raw = await readJsonFile(this.path);
      const previous = raw === null ? { schemaVersion: 1 as const, ...this.scope, revision: 0 } : parseStoredRevision(raw);
      if (previous.siteId !== this.scope.siteId || previous.gatewayId !== this.scope.gatewayId) {
        throw new Error("automation protocol revision scope mismatch");
      }
      const next = parseStoredRevision({ ...previous, revision: previous.revision + 1 });
      // writeJsonAtomic syncs both file and directory. On uncertain commits do
      // not publish; the next attempt rereads disk before allocating another ID.
      await this.write(this.path, next);
      return next.revision;
    });
  }
}
