import { createHash } from "node:crypto";
import type { FloorMapStage } from "@prisma/client";
import type { MapDocumentRef, SaveEditorStateInput } from "@led-control/shared";
import { MapDocumentStagingService } from "./map-document-staging.service";
import { hashEditorLeaseToken } from "./editor-lease-token";

/** Tiny transactional ledger double for the real stage worker. Only external
 * persistence/checkpoint IO is substituted; rollback restores all ledger writes.
 * Web regression consumes the actual worker's receipts, not invented G1/G2 DTOs. */
export function createStageActivationFixture() {
  const lease = { leaseToken: "lease", leaseFence: 1 };
  const ref: MapDocumentRef = { formatVersion: 1, generationId: "base", revision: 3, width: 1200, height: 800, gridSize: 10, elementCount: 1,
    manifest: { assetId: "manifest", sha256: "a".repeat(64), byteSize: 1, decodedByteSize: 1 } };
  const initial = { floor: { id: "floor", siteId: "site", name: "F", level: 1, mapRevision: 3, floorPlan: null, mapDocument: ref },
    fixtures: [{ id: "fixture", name: "before", x: 400, y: 400, ratedWatt: 40, brightness: 100, status: "online" }], objects: [], lightSlots: [] };
  const user = { id: "user", status: "active", role: "admin", mustChangePassword: false, organization: { type: "customer" } };
  let db = { stage: null as FloorMapStage | null, floor: { ...initial.floor, status: "active", editorLeaseHolderId: user.id,
    editorLeaseTokenHash: hashEditorLeaseToken(lease.leaseToken), editorLeaseFence: 1, editorLeaseExpiresAt: new Date(Date.now() + 600000) },
    head: { activeGenerationId: ref.generationId, revision: ref.revision }, saved: structuredClone(initial),
    generations: new Map<string, any>(), revisions: 0, audits: 0 };
  let preparations = 0, failActivation = true;
  const discarded: string[] = [];
  const stageWrite = (data: any) => {
    // Prisma accepts safe numbers for BigInt writes and returns bigint on reads.
    for (const key of ["decodedBytes", "expectedDecodedBytes"]) if (typeof data[key] === "number") data = { ...data, [key]: BigInt(data[key]) };
    Object.assign(db.stage!, data);
    return structuredClone(db.stage!);
  };
  const matches = (row: any, where: any): boolean => Object.entries(where).every(([key, value]: [string, any]) => {
    if (key === "OR") return value.some((clause: any) => matches(row, clause));
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if ("in" in value) return value.in.includes(row[key]);
      if ("lte" in value) return row[key] !== null && row[key] <= value.lte;
      if ("not" in value) return row[key] !== value.not;
    }
    return row[key] === value;
  });
  const prisma = {
    $transaction: async <T>(work: (tx: any) => Promise<T>) => {
      const before = structuredClone(db);
      try { return await work(prisma); } catch (error) { db = before; throw error; }
    },
    $queryRaw: async (parts: TemplateStringsArray) => parts.join("").includes("clock_timestamp") ? [{ now: new Date() }] : [{ id: "floor" }],
    floor: { findUnique: async () => ({ siteId: "site" }), findUniqueOrThrow: async () => structuredClone(db.floor) },
    user: { findUnique: async () => user },
    floorMapDocument: { findUnique: async () => structuredClone(db.head) },
    floorMapStage: {
      findFirst: async ({ where }: any) => db.stage && matches(db.stage, where) ? structuredClone(db.stage) : null,
      findUnique: async () => structuredClone(db.stage),
      findMany: async ({ where }: any) => db.stage && matches(db.stage, where) ? [structuredClone(db.stage)] : [],
      update: async ({ data }: any) => stageWrite(data),
      updateMany: async ({ where, data }: any) => {
        if (!db.stage || !matches(db.stage, where)) return { count: 0 };
        stageWrite(data); return { count: 1 };
      }
    },
    floorMapGeneration: { findFirst: async ({ where }: any) => structuredClone(db.generations.get(where.id) ?? null) },
    floorMapStagePart: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
    floorMapRevision: { create: async () => ({ id: `revision-${++db.revisions}` }) },
    floorMapRevisionAsset: { createMany: async () => ({ count: 0 }) }
  };
  const checkpoints = {
    prepare: async (_floor: string, current: MapDocumentRef) => {
      const prepared = { ...current, generationId: `G${++preparations}`, revision: current.revision + 1 };
      db.generations.set(prepared.generationId, { id: prepared.generationId, floorId: "floor", status: "prepared", baseRevision: prepared.revision,
        ...prepared, manifestDecodedBytes: 1, manifest: { id: "manifest", floorId: "floor", status: "ready", kind: "map_manifest", cleanupStartedAt: null,
          sha256: "a".repeat(64), sizeBytes: 1n } });
      return prepared;
    },
    activate: async (_tx: unknown, _floor: string, _current: MapDocumentRef, prepared: MapDocumentRef) => {
      db.generations.get(prepared.generationId).status = "active";
      db.head = { activeGenerationId: prepared.generationId, revision: prepared.revision };
    }
  };
  const service = new MapDocumentStagingService(prisma as never,
    { assertManageInTransaction: async () => ({ id: "site", organizationId: "org" }) } as never,
    { record: async () => { if (failActivation) { failActivation = false; throw new Error("injected audit rollback"); } db.audits++; } } as never,
    {} as never, { pinRevision: async () => undefined, discardPreparedGeneration: async (_floor: string, id: string) => {
      discarded.push(id); db.generations.delete(id);
    } } as never, { currentRef: async () => db.saved.floor.mapDocument } as never, checkpoints as never,
    { applyDocumentSave: async (_tx: unknown, _floor: string, payload: SaveEditorStateInput, _now: Date, prepared: MapDocumentRef) => {
      db.floor.mapRevision = prepared.revision;
      db.saved = { ...db.saved, floor: { ...db.saved.floor, mapRevision: prepared.revision, mapDocument: prepared },
        fixtures: db.saved.fixtures.map(f => ({ ...f, ...payload.fixtureUpdates.find(p => p.id === f.id) })) };
      return { result: structuredClone(db.saved), snapshot: structuredClone(db.saved) };
    } } as never);
  const intent = { ...lease, partCount: 1, decodedBytes: 2, sha256: createHash("sha256").update("[]").digest("hex") };
  const seed = (payload: SaveEditorStateInput, commitRequested = false) => {
    const { leaseToken: _token, ...save } = payload;
    db.stage = { id: "stage", floorId: "floor", userId: user.id, generationId: ref.generationId, baseRevision: ref.revision,
      requestId: payload.documentChanges!.requestId, requestHash: "hash", leaseTokenHash: hashEditorLeaseToken(lease.leaseToken), leaseFence: 1,
      metadata: { save }, partCount: 1, decodedBytes: 2n, expectedPartCount: 1, expectedDecodedBytes: 2n, payloadHash: intent.sha256,
      status: "queued", commitRequested, preparedGenerationId: null, workerToken: null, workerExpiresAt: null, errorCode: null,
      expiresAt: new Date(Date.now() + 600000), result: null, createdAt: new Date(), updatedAt: new Date() } as unknown as FloorMapStage;
  };
  return { service, user: user as never, lease, initial, intent, seed, snapshot: () => structuredClone(db),
    preparations: () => preparations, discarded, failNextActivation: () => { failActivation = true; } };
}
