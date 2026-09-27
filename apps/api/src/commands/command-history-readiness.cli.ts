import { PrismaClient } from "@prisma/client";
import { inspectCommandHistoryReadiness } from "./command-history-rollout";

async function main() {
  const db = new PrismaClient();
  try {
    const result = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      return inspectCommandHistoryReadiness(tx);
    }, { isolationLevel: "RepeatableRead" });
    process.stdout.write(`${JSON.stringify({ generatedAt: result.generatedAt.toISOString(),
      retainedFrom: result.retainedFrom.toISOString(), unheldCount: result.unheldCount })}\n`);
  } finally {
    await db.$disconnect();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`command history readiness rejected: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
