import { readJsonFile, writeJsonAtomic } from "./mesh-store-file";

export type GroupStateStatus = "configuring" | "ready" | "failed";

export interface GroupStateIdentity {
  groupId: string;
  groupAddress: string;
  version: number;
}

export interface DurableGroupState extends GroupStateIdentity {
  status: GroupStateStatus;
  members: GroupStateMember[];
  updatedAt: string;
}

export interface GroupStateMember {
  meshNodeId: string;
  meshAddress: string;
}

export type GroupStateRestoreReason = "startup" | "first_run" | "state_missing" | "state_corrupt";

interface StoredGroupState {
  version: 1;
  revision: number;
  groups: DurableGroupState[];
}

interface StoreManifest {
  version: 1;
  revision: number;
}

export class GroupStateError extends Error {
  constructor(readonly code: "MESH_GROUP_NOT_READY" | "MESH_GROUP_STALE_SYNC" | "MESH_GROUP_ADDRESS_CONFLICT", message: string) {
    super(message);
    this.name = "GroupStateError";
  }
}

export class GroupStateStore {
  private state: StoredGroupState = { version: 1, revision: 0, groups: [] };
  private available = false;
  private initialization: Promise<{ reason: GroupStateRestoreReason }> | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly write: typeof writeJsonAtomic = writeJsonAtomic
  ) {}

  initialize() {
    this.initialization ??= this.restore();
    return this.initialization;
  }

  async assertReady(identity: GroupStateIdentity) {
    await this.initialize();
    const group = this.available ? this.state.groups.find((candidate) => candidate.groupId === identity.groupId) : undefined;
    if (
      !group ||
      group.status !== "ready" ||
      group.groupAddress.toLowerCase() !== identity.groupAddress.toLowerCase() ||
      group.version !== identity.version
    ) {
      throw new GroupStateError("MESH_GROUP_NOT_READY", "mesh group snapshot is not ready on this gateway");
    }
  }

  writeConfiguring(identity: GroupStateIdentity) {
    return this.update(identity, "configuring", true);
  }

  writeReady(identity: GroupStateIdentity, members: GroupStateMember[] = []) {
    return this.update(identity, "ready", false, members);
  }

  writeFailed(identity: GroupStateIdentity) {
    return this.update(identity, "failed", false);
  }

  async readAppliedMembers(groupId: string): Promise<GroupStateMember[]> {
    await this.initialize();
    const group = this.available ? this.state.groups.find((candidate) => candidate.groupId === groupId) : undefined;
    return group ? group.members.map((member) => ({ ...member })) : [];
  }

  private async restore(): Promise<{ reason: GroupStateRestoreReason }> {
    let rawState: unknown | null;
    let rawManifest: unknown | null;
    try {
      [rawState, rawManifest] = await Promise.all([readJsonFile(this.path), readJsonFile(`${this.path}.manifest`)]);
    } catch {
      this.available = false;
      return { reason: "state_corrupt" };
    }

    if (rawState === null && rawManifest === null) {
      const initial = { version: 1, revision: 1, groups: [] } satisfies StoredGroupState;
      await this.write(`${this.path}.manifest`, { version: 1, revision: 1 } satisfies StoreManifest);
      await this.write(this.path, initial);
      this.state = initial;
      this.available = true;
      return { reason: "first_run" };
    }
    if (rawState === null && rawManifest !== null) {
      this.available = false;
      return { reason: "state_missing" };
    }
    if (rawState === null || rawManifest === null) {
      this.available = false;
      return { reason: "state_corrupt" };
    }

    try {
      const state = parseState(rawState);
      const manifest = parseManifest(rawManifest);
      if (state.revision !== manifest.revision) throw new Error("group state revision mismatch");
      this.state = state;
      this.available = true;
      return { reason: "startup" };
    } catch {
      this.available = false;
      return { reason: "state_corrupt" };
    }
  }

  private update(identity: GroupStateIdentity, status: GroupStateStatus, allowRecovery: boolean, members?: GroupStateMember[]) {
    return this.exclusive(async () => {
      await this.initialize();
      validateIdentity(identity);
      if (!this.available && !allowRecovery) {
        throw new GroupStateError("MESH_GROUP_NOT_READY", "mesh group state must be recovered before it can become terminal");
      }
      // Keep the last fully persisted snapshot in memory while disk writes are unavailable.
      // A configuring retry must recover every group, not rebuild from an empty list.
      const groups = this.state.groups.map((group) => ({ ...group }));
      const existingIndex = groups.findIndex((group) => group.groupId === identity.groupId);
      const existing = existingIndex < 0 ? undefined : groups[existingIndex];
      const addressOwner = groups.find(
        (group) => group.groupId !== identity.groupId && group.groupAddress.toLowerCase() === identity.groupAddress.toLowerCase()
      );
      if (addressOwner) {
        throw new GroupStateError("MESH_GROUP_ADDRESS_CONFLICT", "mesh group address is already owned by another group");
      }
      if (allowRecovery && existing && identity.version < existing.version) {
        throw new GroupStateError("MESH_GROUP_STALE_SYNC", "mesh group sync version is older than durable state");
      }
      if (existing && identity.version === existing.version && existing.groupAddress.toLowerCase() !== identity.groupAddress.toLowerCase()) {
        throw new GroupStateError("MESH_GROUP_STALE_SYNC", "mesh group address changed without a version increment");
      }
      if (!allowRecovery && (
        !existing ||
        existing.status !== "configuring" ||
        existing.version !== identity.version ||
        existing.groupAddress.toLowerCase() !== identity.groupAddress.toLowerCase()
      )) {
        throw new GroupStateError("MESH_GROUP_NOT_READY", "mesh group terminal state does not match the configuring snapshot");
      }

      const nextGroup: DurableGroupState = {
        ...identity,
        groupAddress: identity.groupAddress.toLowerCase(),
        status,
        members: (members ?? existing?.members ?? []).map(parseMember),
        updatedAt: this.now()
      };
      if (existingIndex < 0) groups.push(nextGroup);
      else groups[existingIndex] = nextGroup;
      if (groups.length > 1_000) throw new Error("mesh group state exceeds the supported limit");
      groups.sort((left, right) => left.groupId.localeCompare(right.groupId));
      const next = { version: 1, revision: this.state.revision + 1, groups } satisfies StoredGroupState;

      this.available = false;
      try {
        // Manifest-first revision fencing makes a crash between the two renames fail closed on restart.
        await this.write(`${this.path}.manifest`, { version: 1, revision: next.revision } satisfies StoreManifest);
        await this.write(this.path, next);
        this.state = next;
        this.available = true;
      } catch (error) {
        throw new Error("failed to persist mesh group state", { cause: error });
      }
    });
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function parseManifest(value: unknown): StoreManifest {
  if (!isRecord(value) || value.version !== 1 || !isPositiveInteger(value.revision)) {
    throw new Error("invalid mesh group state manifest");
  }
  return { version: 1, revision: value.revision };
}

function parseState(value: unknown): StoredGroupState {
  if (!isRecord(value) || value.version !== 1 || !isPositiveInteger(value.revision) || !Array.isArray(value.groups)) {
    throw new Error("invalid mesh group state file");
  }
  if (value.groups.length > 1_000) throw new Error("invalid mesh group state file");
  const groups = value.groups.map(parseGroup);
  const ids = new Set<string>();
  const addresses = new Set<string>();
  for (const group of groups) {
    if (ids.has(group.groupId) || addresses.has(group.groupAddress)) throw new Error("duplicate mesh group state");
    ids.add(group.groupId);
    addresses.add(group.groupAddress);
  }
  return { version: 1, revision: value.revision, groups };
}

function parseGroup(value: unknown): DurableGroupState {
  if (!isRecord(value)) throw new Error("invalid mesh group state");
  const identity = { groupId: value.groupId, groupAddress: value.groupAddress, version: value.version };
  validateIdentity(identity as GroupStateIdentity);
  if (value.status !== "configuring" && value.status !== "ready" && value.status !== "failed") {
    throw new Error("invalid mesh group status");
  }
  if (typeof value.updatedAt !== "string" || Number.isNaN(Date.parse(value.updatedAt))) {
    throw new Error("invalid mesh group update time");
  }
  // Older durable snapshots did not record memberships; treat them as empty so the next cloud snapshot safely reapplies it.
  const members = value.members === undefined ? [] : Array.isArray(value.members) ? value.members.map(parseMember) : (() => { throw new Error("invalid mesh group members"); })();
  return { ...(identity as GroupStateIdentity), groupAddress: (identity.groupAddress as string).toLowerCase(), status: value.status, members, updatedAt: value.updatedAt };
}

function parseMember(value: unknown): GroupStateMember {
  if (!isRecord(value) || typeof value.meshNodeId !== "string" || !/^0x[0-9a-f]{4}$/i.test(String(value.meshAddress))) {
    throw new Error("invalid mesh group member");
  }
  return { meshNodeId: value.meshNodeId, meshAddress: String(value.meshAddress).toLowerCase() };
}

function validateIdentity(identity: GroupStateIdentity) {
  if (typeof identity.groupId !== "string" || identity.groupId.length === 0) throw new Error("invalid mesh group id");
  if (!/^0x[0-9a-f]{4}$/i.test(identity.groupAddress)) throw new Error("invalid mesh group address");
  const address = Number.parseInt(identity.groupAddress.slice(2), 16);
  if (address < 0xc000 || address > 0xfeff) throw new Error("invalid mesh group address");
  if (!isPositiveInteger(identity.version)) throw new Error("invalid mesh group version");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
