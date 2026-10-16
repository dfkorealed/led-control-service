import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { SiteAccessService } from "../access/site-access.service";
import { AuditService } from "../audit/audit.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { lockFixtureRegistrationRemovalDomain } from "../fixtures/fixture-registration-removal-policy";
import { FloorImportService } from "../floor-import/floor-import.service";
import { hashEditorLeaseToken } from "./editor-lease-token";
import { MapDocumentResetService } from "./map-document-reset.service";
import { MapDocumentStore } from "./map-document-store";

const enabled = process.env.MAP_REMOVAL_LOCK_ORDER_DISPOSABLE_POSTGRES === "1";

(enabled ? describe : describe.skip)("map/removal serializer order on own PostgreSQL", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>> | undefined;
  let url: string;
  let db: PrismaClient;
  beforeAll(async () => {
    cluster = await disposablePostgres();
    url = cluster.database();
    const deployed = cluster.deploy(url);
    if (deployed.status !== 0) throw new Error(`${deployed.stdout}\n${deployed.stderr}`);
    db = new PrismaClient({ datasourceUrl: url });
    console.info("I5_OWN_PG", new URL(url).port, "migrations", cluster.sql(url,
      'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL'));
  }, 60_000);
  afterAll(async () => {
    await db?.$disconnect();
    cluster?.stop();
    console.info("I5_OWN_PG_STOPPED_AND_REMOVED");
  });

  it.each((["reset", "clear", "legacy_cad", "common_cad"] as const).flatMap(write =>
    (["map", "removal"] as const).map(first => ({ write, first }))))(
    "$write completes with $first holding the first lock", async ({ write, first }) => {
      const organization = await db.organization.create({ data: { name: "I5", type: "customer" } });
      const actor = await db.user.create({ data: { organizationId: organization.id, loginId: randomUUID(),
        name: "I5 admin", passwordHash: "unused", role: "admin" } });
      const user: AuthenticatedUser = { ...actor, role: "admin", status: "active", organizationType: "customer" };
      const site = await db.site.create({ data: { organizationId: organization.id, adminUserId: actor.id, name: "I5" } });
      const floor = await db.floor.create({ data: { siteId: site.id, name: "I5", level: 1,
        editorLeaseHolderId: actor.id, editorLeaseFence: 1, editorLeaseTokenHash: hashEditorLeaseToken("owned"),
        editorLeaseExpiresAt: new Date(Date.now() + 600_000) } });
      const gateway = await db.gateway.create({ data: { siteId: site.id, name: "I5", serialNumber: randomUUID(), firmwareVersion: "test" } });
      const deviceUuid = `bio:${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const node = await db.meshNode.create({ data: { gatewayId: gateway.id, deviceUuid, meshAddress: "0x0100", firmwareVersion: "test" } });
      const fixture = await db.fixture.create({ data: { floorId: floor.id, meshNodeId: node.id,
        name: "I5", ratedWatt: 20, x: 12, y: 20, placementStatus: "placed" } });
      const scope = { siteId: site.id, floorId: floor.id, gatewayId: gateway.id,
        fixtureId: fixture.id, meshNodeId: node.id, deviceUuid };
      const mapLabel = `i5_map_${randomUUID()}`;
      const removalLabel = `i5_removal_${randomUUID()}`;
      const mapDb = new PrismaClient({ datasourceUrl: `${url}?application_name=${mapLabel}` });
      const removalDb = new PrismaClient({ datasourceUrl: `${url}?application_name=${removalLabel}` });
      const objects = new Map<string, Buffer>();
      const storage = {
        putCadSceneObjectFile: async (key: string, path: string) => { objects.set(key, await readFile(path)); },
        verifyCadSceneObject: async (key: string) => { if (!objects.has(key)) throw new Error("missing object"); },
        downloadFloorAssetToFile: async (key: string, path: string) => {
          const bytes = objects.get(key); if (!bytes) throw new Error("missing object");
          await writeFile(path, bytes, { flag: "wx" });
        },
        readFloorRenderedMetadata: async () => ({ width: 640, height: 600 })
      };
      const access = new SiteAccessService(mapDb as never);
      const audit = new AuditService(mapDb as never);
      const store = new MapDocumentStore(mapDb as never, storage as never);
      const reset = new MapDocumentResetService(mapDb as never, access, audit, store);
      const authority = { requestId: randomUUID(), baseRevision: 0, leaseToken: "owned", leaseFence: 1 };
      const held = deferred<number>();
      const release = deferred<void>();
      const outcomes: Array<Promise<unknown>> = [];
      let authorization: jest.SpyInstance | undefined;
      try {
        let mapWrite: () => Promise<unknown>;
        if (write === "reset") mapWrite = () => reset.reset(floor.id, user, authority);
        else if (write === "clear") {
          await reset.reset(floor.id, user, authority);
          mapWrite = () => reset.clear(floor.id, user, { ...authority, requestId: randomUUID(), baseRevision: 1, mode: "elements_and_placement" });
        } else {
          const source = await db.floorAsset.create({ data: { floorId: floor.id, kind: "original", status: "ready",
            objectKey: `i5/${randomUUID()}.dxf`, mimeType: "application/dxf", sizeBytes: 256n,
            sha256: "a".repeat(64), readyAt: new Date() } });
          const rendered = await db.floorAsset.create({ data: { floorId: floor.id, kind: "rendered", status: "ready",
            objectKey: `i5/${randomUUID()}.svg`, mimeType: "image/svg+xml", contentEncoding: null,
            sizeBytes: 256n, sha256: "b".repeat(64), readyAt: new Date() } });
          async function* empty() { /* The regression concerns publication locks, not CAD geometry. */ }
          const ref = write === "common_cad" ? await store.prepareGeneration(floor.id, empty(), {
            width: 640, height: 600, gridSize: 10, groups: [], layers: [{ id: "map", name: "Map", order: 0, visible: true, locked: false }]
          }) : undefined;
          const job = await db.floorImportJob.create({ data: { floorId: floor.id, sourceAssetId: source.id,
            renderedAssetId: rendered.id, sourceFormat: "dxf", status: "review_required", stage: "review_required",
            attemptCount: 1, startedAt: new Date(), reviewRequiredAt: new Date(), progressPercent: 100,
            excludedRegionPrimitiveCount: 0, preparedMapGenerationId: ref?.generationId,
            detectorProfileId: "generic-lighting-v1", detectorProfileVersion: "legacy-unknown", detectorProfileDigest: "0".repeat(64) } });
          const preparation = ref ? { readPrepared: async () => ref, readDisplayManifest: async () => ({}) } : undefined;
          const imports = new FloorImportService(mapDb as never, access, audit, storage as never,
            undefined, undefined, preparation as never, ref ? store : undefined);
          mapWrite = () => imports.apply(user, floor.id, job.id, { expectedRevision: 0,
            leaseToken: "owned", leaseFence: 1, confirmMapReset: true, candidateIds: [] });
        }
        // Gate only the publication transaction, not reset/clear's separate
        // preflight. The real access service still locks and reauthorizes Site.
        if (first === "map") {
          const authorize = access.assertManageInTransaction.bind(access);
          let calls = 0;
          authorization = jest.spyOn(access, "assertManageInTransaction").mockImplementation(async (tx, actor, siteId) => {
            const result = await authorize(tx, actor, siteId);
            if (++calls === (write === "reset" || write === "clear" ? 2 : 1)) {
              const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
              held.resolve(pid);
              await release.promise;
            }
            return result;
          });
        }
        const removal = () => removalDb.$transaction(async tx => {
          await lockFixtureRegistrationRemovalDomain(tx, scope);
          if (first === "removal") {
            const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
            held.resolve(pid);
            await release.promise;
          }
          // Exercise the same statement trigger even when no slots exist.
          await tx.floorLightSlot.deleteMany({ where: { floorId: floor.id } });
        }, { timeout: 15_000, maxWait: 15_000 });
        const settle = (run: () => Promise<unknown>) => run().then(() => ({ ok: true }), error => ({ ok: false, message: String(error) }));
        const leader = settle(first === "map" ? mapWrite : removal);
        outcomes.push(leader);
        const holder = await Promise.race([held.promise, leader.then(result => {
          throw new Error(`leader finished before the lock gate: ${JSON.stringify(result)}`);
        })]);
        const follower = settle(first === "map" ? removal : mapWrite);
        outcomes.push(follower);
        const followerLabel = first === "map" ? removalLabel : mapLabel;
        let waiter: { pid: number; query: string } | undefined;
        const deadline = Date.now() + 5_000;
        while (!waiter && Date.now() < deadline) {
          [waiter] = await db.$queryRaw<Array<{ pid: number; query: string }>>`
            SELECT pid::int, query FROM pg_stat_activity WHERE application_name = ${followerLabel}
              AND ${holder}::int = ANY(pg_blocking_pids(pid))`;
          if (!waiter) await new Promise(resolve => setTimeout(resolve, 10));
        }
        release.resolve();
        const results = await Promise.all([leader, follower]);
        console.info("I5_WAIT_GRAPH", JSON.stringify({ write, first, holder, waiter, results }));
        expect(waiter).toBeDefined();
        expect(results).toEqual([{ ok: true }, { ok: true }]);
        expect(await db.fixture.findUniqueOrThrow({ where: { id: fixture.id } }))
          .toMatchObject({ x: 0, y: 0, placementStatus: "unplaced" });
      } finally {
        release.resolve();
        await Promise.allSettled(outcomes);
        authorization?.mockRestore();
        await mapDb.$disconnect();
        await removalDb.$disconnect();
      }
    }, 30_000);
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
