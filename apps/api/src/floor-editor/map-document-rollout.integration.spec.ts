import { PrismaClient } from "@prisma/client";
import { FloorAssetCleanupService } from "./floor-asset-cleanup.service";
import { MapDocumentAssetReferences } from "./map-document-asset-references";

const url = process.env.FLOOR_EDITOR_TEST_DATABASE_URL;
(url ? describe : describe.skip)("map document pre-migration rollout", () => {
  it("does not query absent new tables from existing cleanup paths", async () => {
    const target = new URL(url!);
    if (!/^\/led_u3_test_[a-z0-9_]+_upgrade$/.test(target.pathname) || !["localhost", "127.0.0.1"].includes(target.hostname)) throw new Error("unsafe rollout DB");
    const prisma = new PrismaClient({ datasources: { db: { url } } });
    try {
      const [identity] = await prisma.$queryRaw<Array<{ database: string }>>`SELECT current_database() AS database`;
      if (`/${identity.database}` !== target.pathname) throw new Error("rollout DB mismatch");
      const references = new MapDocumentAssetReferences(prisma as never);
      expect(await references.available()).toBe(false);
      const cleanup = new FloorAssetCleanupService(prisma as never, { deleteObject: jest.fn() } as never, references);
      expect(await cleanup.processPending()).toEqual({ processed: 0, deleted: 0 });
    } finally { await prisma.$disconnect(); }
  });
});
