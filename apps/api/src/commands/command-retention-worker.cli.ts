import { PrismaClient } from "@prisma/client";
import { CommandSafetyDigest } from "./command-safety-digest";
import { runDisposableProtectedCommandRetentionBatch } from "./command-retention-worker";

/** Test-only entry point; no production scheduler or credential fallback exists. */
export async function runDisposableRetentionCli(): Promise<void> {
  if (process.env.NODE_ENV !== "test" || process.env.COMMAND_RETENTION_TEST !== "1"
    || process.env.COMMAND_RETENTION_PURGE_ENABLED === "1") {
    throw new Error("disposable protected retention only");
  }
  const url = process.env.COMMAND_PURGE_WORKER_DATABASE_URL;
  const disposableToken = process.env.COMMAND_RETENTION_DISPOSABLE_TOKEN;
  const maxCandidates = Number(process.env.COMMAND_RETENTION_MAX_CANDIDATES ?? "25");
  if (!url || !disposableToken || !Number.isInteger(maxCandidates)) {
    throw new Error("disposable protected retention unavailable");
  }
  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    const result = await runDisposableProtectedCommandRetentionBatch(prisma,
      new CommandSafetyDigest(), { maxCandidates, disposableToken });
    // Aggregates and allowlisted reasons only; never log Command IDs or payloads.
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void runDisposableRetentionCli().catch(() => {
    // The caller must not receive DB URLs, keys, raw IDs, or SQL error details.
    process.stderr.write("disposable protected retention unavailable\n");
    process.exitCode = 1;
  });
}
