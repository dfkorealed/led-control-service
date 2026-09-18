import "../app.module";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { ChildProcessCadCoreExecutor } from "./cad-core-executor";
import { assertCadProductionRuntime } from "./cad-runtime-contract";

async function main() {
  const dxfPath = process.env.CAD_CGROUP_HIL_DXF_PATH;
  if (!dxfPath) throw new Error("CAD_CGROUP_HIL_DXF_PATH is required");
  assertCadProductionRuntime(process.env);
  const parentBaselineRssBytes = process.memoryUsage().rss;
  const executor = new ChildProcessCadCoreExecutor();
  const renderedPath = join("/tmp", `cad-cgroup-${process.pid}.svg`);
  if (process.env.CAD_CGROUP_HIL_EXPECT_FAILURE === "1") {
    await executor.execute({ dxfPath, renderedPath, profileId: "generic-lighting-v1" })
      .then(() => { throw new Error("adversarial CAD unexpectedly succeeded"); })
      .catch(error => {
        if (error instanceof Error && error.message === "adversarial CAD unexpectedly succeeded") throw error;
      });
    process.stdout.write(`${JSON.stringify({
      parentSurvived: true, parentBaselineRssBytes, parentPeakRssBytes: process.resourceUsage().maxRSS * 1024
    })}\n`);
    return;
  }
  const result = await executor.execute({ dxfPath, renderedPath, profileId: "site-drawing-20260803-v1" });
  const stored = await stat(renderedPath);
  if (result.candidates.length !== 1_308 || stored.size !== result.rendered.sizeBytes) {
    throw new Error("CAD cgroup HIL output contract mismatch");
  }
  process.stdout.write(`${JSON.stringify({
    parentBaselineRssBytes,
    parentPeakRssBytes: process.resourceUsage().maxRSS * 1024,
    childPeakRssBytes: result.observedMaxRssBytes,
    candidates: result.candidates.length,
    storedSvgBytes: stored.size
  })}\n`);
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : "CAD cgroup HIL failed"}\n`);
  process.exitCode = 1;
});
