import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  automationSnapshotV1Schema,
  type AutomationSnapshotV1
} from "@led-control/shared";
import {
  AtomicJsonCommitUncertainError,
  readJsonFile,
  removeFileDurable,
  writeJsonAtomic
} from "../mesh/mesh-store-file";

export interface AutomationScope {
  siteId: string;
  gatewayId: string;
}

export interface AutomationConfigStore {
  load(): Promise<AutomationSnapshotV1 | null>;
  apply(snapshot: AutomationSnapshotV1): Promise<void>;
  restore(snapshot: AutomationSnapshotV1 | null): Promise<void>;
}

type AtomicJsonWriter = (path: string, value: unknown) => Promise<void>;

export type AutomationConfigStoreErrorCode =
  | "snapshot_invalid"
  | "snapshot_scope_mismatch"
  | "snapshot_hash_mismatch";

export class AutomationConfigStoreError extends Error {
  constructor(
    readonly code: AutomationConfigStoreErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "AutomationConfigStoreError";
  }
}

export class AutomationConfigCommitUncertainError extends Error {
  readonly code = "snapshot_commit_uncertain";

  constructor(options?: ErrorOptions) {
    super("snapshot_commit_uncertain", options);
    this.name = "AutomationConfigCommitUncertainError";
  }
}

export class FileAutomationConfigStore implements AutomationConfigStore {
  constructor(
    private readonly path: string,
    private readonly scope: AutomationScope,
    private readonly write: AtomicJsonWriter = writeJsonAtomic
  ) {}

  async load(): Promise<AutomationSnapshotV1 | null> {
    await this.removeInterruptedWrites();
    let raw: unknown | null;
    try {
      raw = await readJsonFile(this.path);
    } catch (error) {
      throw new AutomationConfigStoreError("snapshot_invalid", "snapshot_invalid", { cause: error });
    }
    return raw === null ? null : parseAutomationSnapshot(raw, this.scope);
  }

  async apply(snapshot: AutomationSnapshotV1): Promise<void> {
    const parsed = parseAutomationSnapshot(snapshot, this.scope);
    const previous = await this.load();
    try {
      await this.write(this.path, parsed);
    } catch (error) {
      if (!(error instanceof AtomicJsonCommitUncertainError)) throw error;
      let rollbackError: unknown;
      try {
        await this.restore(previous);
      } catch (caught) {
        rollbackError = caught;
      }
      let visible: AutomationSnapshotV1 | null;
      try {
        visible = await this.load();
      } catch (readbackError) {
        throw new AutomationConfigCommitUncertainError({
          cause: new AggregateError([error, rollbackError, readbackError].filter(Boolean), "snapshot visibility recovery failed")
        });
      }
      if (!isDeepStrictEqual(visible, previous)) {
        throw new AutomationConfigCommitUncertainError({
          cause: new AggregateError([error, rollbackError].filter(Boolean), "snapshot target differs from runtime state")
        });
      }
      throw new AutomationConfigCommitUncertainError({
        cause: rollbackError
          ? new AggregateError([error, rollbackError], "snapshot durability and rollback barriers failed")
          : error
      });
    }
  }

  async restore(snapshot: AutomationSnapshotV1 | null): Promise<void> {
    if (snapshot) {
      await this.write(this.path, parseAutomationSnapshot(snapshot, this.scope));
      return;
    }
    await removeFileDurable(this.path);
  }

  private async removeInterruptedWrites() {
    const directory = dirname(this.path);
    const temporaryPrefix = `${basename(this.path)}.`;
    try {
      const entries = await readdir(directory);
      await Promise.all(entries
        .filter((entry) => entry.startsWith(temporaryPrefix) && entry.endsWith(".tmp"))
        .map((entry) => rm(`${directory}/${entry}`, { force: true })));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function parseAutomationSnapshot(value: unknown, scope: AutomationScope): AutomationSnapshotV1 {
  const parsed = automationSnapshotV1Schema.safeParse(value);
  if (!parsed.success) {
    throw new AutomationConfigStoreError("snapshot_invalid", "snapshot_invalid", { cause: parsed.error });
  }
  if (parsed.data.siteId !== scope.siteId || parsed.data.gatewayId !== scope.gatewayId) {
    throw new AutomationConfigStoreError("snapshot_scope_mismatch", "snapshot_scope_mismatch");
  }
  const { payloadHash, ...withoutHash } = parsed.data;
  if (canonicalPayloadHash(withoutHash) !== payloadHash) {
    throw new AutomationConfigStoreError("snapshot_hash_mismatch", "snapshot_hash_mismatch");
  }
  return parsed.data as AutomationSnapshotV1;
}

function canonicalPayloadHash(value: unknown) {
  return `sha256:${createHash("sha256").update(JSON.stringify(sortJson(value))).digest("hex")}`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, sortJson(child)])
  );
}
