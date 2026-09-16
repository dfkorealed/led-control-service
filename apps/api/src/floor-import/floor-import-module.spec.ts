import { copyFile } from "node:fs/promises";
import { Test } from "@nestjs/testing";
import { tmpdir } from "node:os";
import { PrismaService } from "../prisma/prisma.service";
import { RedisProvider } from "../redis/redis.provider";
import { ObjectStorageService } from "../storage/object-storage.service";
import { createCadImportConverter, FloorImportModule } from "./floor-import.module";
import { CAD_IMPORT_WORKER_OPTIONS, FloorImportWorkerService } from "./floor-import-worker.service";

describe("CAD import converter module configuration", () => {
  it("fails closed when production Linux converter configuration is absent", () => {
    expect(() => createCadImportConverter({ NODE_ENV: "production", CAD_IMPORT_CONVERTER_MODE: "linux" }, "linux"))
      .toThrow(/executable/i);
  });

  it("rejects the local adapter in production and requires an explicit local mode elsewhere", async () => {
    expect(() => createCadImportConverter({ NODE_ENV: "production", CAD_IMPORT_CONVERTER_MODE: "local-dxf-copy" }, "linux"))
      .toThrow(/local.*production/i);
    expect(() => createCadImportConverter({ NODE_ENV: "test" }, "darwin")).toThrow(/mode/i);
    const local = createCadImportConverter({ NODE_ENV: "test", CAD_IMPORT_CONVERTER_MODE: "local-dxf-copy" }, "darwin", { copyFile });
    expect(local).toBeDefined();
  });

  it("boots and closes the Nest module graph with the worker explicitly disabled", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [FloorImportModule] })
      .overrideProvider(PrismaService).useValue({})
      .overrideProvider(RedisProvider).useValue({ onModuleInit: () => undefined, onModuleDestroy: () => undefined })
      .overrideProvider(ObjectStorageService).useValue({})
      .overrideProvider(CAD_IMPORT_WORKER_OPTIONS).useValue({ tempRoot: tmpdir(), pollIntervalMs: 1000, enabled: false })
      .compile();
    const app = moduleRef.createNestApplication();
    await expect(app.init()).resolves.toBeDefined();
    expect(app.get(FloorImportWorkerService)).toBeInstanceOf(FloorImportWorkerService);
    await app.close();
  });
});
