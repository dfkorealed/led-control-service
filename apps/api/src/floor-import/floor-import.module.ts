import { Module } from "@nestjs/common";
import { copyFile, lstat, unlink } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { AccessModule } from "../access/access.module";
import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { StorageModule } from "../storage/storage.module";
import { FloorEditorModule } from "../floor-editor/floor-editor.module";
import { CadMapPreparationService } from "./cad-map-preparation.service";
import { ArgvCadConverter, type CadConversionRequest, type CadConverter } from "./cad-converter";
import { CAD_IMPORT_MAX_DXF_BYTES } from "./cad-resource-limits";
import { SpoolCadConverter } from "./cad-converter-spool";
import { CadSidecarReadinessService } from "./cad-sidecar-readiness.service";
import { ChildProcessCadCoreExecutor } from "./cad-core-executor";
import { assertCadProductionRuntime } from "./cad-runtime-contract";
import { FixedLightingDetectorRegistry } from "./lighting-detector-registry";
import { FloorImportAttemptCleanupService } from "./floor-import-attempt-cleanup.service";
import { FloorImportController } from "./floor-import.controller";
import { FloorImportService } from "./floor-import.service";
import {
  CAD_IMPORT_CONVERTER,
  CAD_IMPORT_CORE_EXECUTOR,
  CAD_IMPORT_RULE_DETECTOR,
  CAD_IMPORT_WORKER_OPTIONS,
  FloorImportWorkerService,
  type FloorImportWorkerOptions
} from "./floor-import-worker.service";

interface LocalCopyDependencies {
  copyFile: typeof copyFile;
}

class LocalDxfCopyCadConverter implements CadConverter {
  constructor(private readonly dependencies: LocalCopyDependencies) {}

  async convert(request: CadConversionRequest) {
    if (!isAbsolute(request.inputPath) || !isAbsolute(request.outputPath) || resolve(request.inputPath) === resolve(request.outputPath)) {
      throw new Error("local CAD converter requires distinct absolute paths");
    }
    if (request.abortSignal?.aborted) throw new Error("CAD conversion aborted");
    await unlink(request.outputPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    await this.dependencies.copyFile(request.inputPath, request.outputPath);
    const output = await lstat(request.outputPath);
    if (!output.isFile() || output.isSymbolicLink()) throw new Error("local CAD converter output must be a regular file");
    return { outputPath: request.outputPath, outputBytes: output.size };
  }
}

class UnconfiguredCadConverter implements CadConverter {
  async convert(): Promise<never> {
    throw new Error("CAD import converter mode is not configured");
  }
}

export function createCadImportConverter(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  dependencies: LocalCopyDependencies = { copyFile }
): CadConverter {
  const mode = env.CAD_IMPORT_CONVERTER_MODE?.trim();
  if (!mode) throw new Error("CAD_IMPORT_CONVERTER_MODE is required");
  if (mode === "local-dxf-copy") {
    if (env.NODE_ENV === "production") throw new Error("local CAD adapter is forbidden in production");
    return new LocalDxfCopyCadConverter(dependencies);
  }
  if (mode === "development-argv") {
    if (env.NODE_ENV === "production") throw new Error("development CAD adapter is forbidden in production");
    const executable = env.CAD_IMPORT_CONVERTER_EXECUTABLE?.trim();
    if (!executable) throw new Error("CAD_IMPORT_CONVERTER_EXECUTABLE is required");
    return new ArgvCadConverter({
      executable,
      argv: parseConverterArgv(env.CAD_IMPORT_CONVERTER_ARGV_JSON),
      timeoutMs: positiveInteger(env.CAD_IMPORT_CONVERTER_TIMEOUT_MS, 60_000, "CAD_IMPORT_CONVERTER_TIMEOUT_MS"),
      maxOutputBytes: positiveInteger(env.CAD_IMPORT_MAX_DXF_BYTES, CAD_IMPORT_MAX_DXF_BYTES, "CAD_IMPORT_MAX_DXF_BYTES"),
      execution: platform === "linux"
        ? { mode: "linux-resource-limited" }
        : { mode: "macos-development-polling", acknowledgeNonProductionRisk: true }
    });
  }
  if (mode !== "sidecar") throw new Error("unsupported CAD_IMPORT_CONVERTER_MODE");
  if (platform !== "linux") throw new Error("production CAD converter requires Linux");
  const spoolRoot = env.CAD_IMPORT_CONVERTER_SPOOL_ROOT?.trim();
  const approvedDigest = env.CAD_IMPORT_CONVERTER_SHA256?.trim();
  if (!spoolRoot) throw new Error("CAD_IMPORT_CONVERTER_SPOOL_ROOT is required");
  if (!approvedDigest) throw new Error("CAD_IMPORT_CONVERTER_SHA256 is required");
  return new SpoolCadConverter({
    spoolRoot,
    approvedDigest,
    timeoutMs: positiveInteger(env.CAD_IMPORT_CONVERTER_CLIENT_TIMEOUT_MS, 65_000, "CAD_IMPORT_CONVERTER_CLIENT_TIMEOUT_MS"),
    maxOutputBytes: positiveInteger(env.CAD_IMPORT_MAX_DXF_BYTES, 256 * 1024 * 1024, "CAD_IMPORT_MAX_DXF_BYTES")
  });
}

function parseConverterArgv(raw: string | undefined): string[] {
  if (!raw) throw new Error("CAD_IMPORT_CONVERTER_ARGV_JSON is required");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("CAD_IMPORT_CONVERTER_ARGV_JSON must be valid JSON"); }
  if (!Array.isArray(parsed) || !parsed.length || parsed.some(value => typeof value !== "string")) {
    throw new Error("CAD_IMPORT_CONVERTER_ARGV_JSON must be a non-empty string array");
  }
  return parsed as string[];
}

function converterProvider(env: NodeJS.ProcessEnv) {
  if (!env.CAD_IMPORT_CONVERTER_MODE && env.NODE_ENV !== "production") return new UnconfiguredCadConverter();
  return createCadImportConverter(env);
}

function workerOptions(env: NodeJS.ProcessEnv): FloorImportWorkerOptions {
  const enabled = Boolean(env.CAD_IMPORT_CONVERTER_MODE);
  const tempRoot = env.CAD_IMPORT_TEMP_ROOT?.trim() || "/tmp";
  if (!isAbsolute(tempRoot)) throw new Error("CAD_IMPORT_TEMP_ROOT must be absolute");
  if (env.NODE_ENV === "production" && enabled && !env.CAD_IMPORT_TEMP_ROOT?.trim()) {
    throw new Error("CAD_IMPORT_TEMP_ROOT is required when the production CAD worker is enabled");
  }
  if (enabled) assertCadProductionRuntime(env);
  return {
    tempRoot,
    pollIntervalMs: positiveInteger(env.CAD_IMPORT_POLL_INTERVAL_MS, 1000, "CAD_IMPORT_POLL_INTERVAL_MS"),
    enabled
  };
}

function positiveInteger(value: string | undefined, fallback: number, name: string) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

@Module({
  imports: [PrismaModule, StorageModule, AccessModule, AuditModule, AuthModule, FloorEditorModule],
  controllers: [FloorImportController],
  providers: [
    FloorImportService,
    FloorImportAttemptCleanupService,
    FloorImportWorkerService,
    CadMapPreparationService,
    CadSidecarReadinessService,
    { provide: CAD_IMPORT_CONVERTER, useFactory: () => converterProvider(process.env) },
    {
      provide: CAD_IMPORT_RULE_DETECTOR,
      useFactory: () => new FixedLightingDetectorRegistry()
    },
    { provide: CAD_IMPORT_CORE_EXECUTOR, useFactory: () => new ChildProcessCadCoreExecutor() },
    { provide: CAD_IMPORT_WORKER_OPTIONS, useFactory: () => workerOptions(process.env) }
  ],
  exports: [CadSidecarReadinessService, CadMapPreparationService]
})
export class FloorImportModule {}
