// 승인 문자열/full source/run id 없이는 server 시작 전 fail-closed한다.
import { defineConfig, devices } from "../../../apps/web/node_modules/@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../../..");
const source = process.env.UX_SOURCE_SHA, run = process.env.UX_RUN_ID;
if (process.env.UX_EXECUTION_APPROVED !== "map-workspace-comments-20261012") throw new Error("Root final-source handoff/execution approval is required");
if (!source || !/^[a-f0-9]{40}$/.test(source)) throw new Error("UX_SOURCE_SHA must be the final full source SHA");
if (!run || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(run)) throw new Error("A fresh explicit UX_RUN_ID is required");
if (process.env.E2E_REAL_BACKEND_LAB === "1") throw new Error("This harness is fake-API-only");
if (execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim() !== source) throw new Error("HEAD differs from approved source cohort");
execFileSync("git", ["diff", "--exit-code", source, "--", "apps/web", "packages/shared"], { cwd: root, stdio: "pipe" });
const runDir = resolve(__dirname, "runs", run);
const outputDir = resolve(runDir, "results");
if (!existsSync(resolve(__dirname, "page-session-ux.spec.ts"))) throw new Error("The actual six-case spec must exist before execution");
// Playwright 1.61 sets both worker indices before deserializeConfig(). Workers
// inherit the coordinator marker and have its PID as their parent. They reload
// this file after the coordinator has created results and started its server;
// reapplying pre-start checks there mistakes this run for old evidence.
const workerReload = /^\d+$/.test(process.env.TEST_WORKER_INDEX ?? "")
  && /^\d+$/.test(process.env.TEST_PARALLEL_INDEX ?? "")
  && process.env.UX_QA_COORDINATOR_PID === String(process.ppid);
if (workerReload) {
  if (!existsSync(runDir)) throw new Error("Worker reload requires this coordinator's evidence directory");
} else {
  if (existsSync(runDir)) throw new Error("Evidence run directory already exists; originals must not be overwritten");
  // Check only the assigned port. A missing/failed lsof is not a free port.
  try {
    execFileSync("lsof", ["-nP", "-iTCP:15188", "-sTCP:LISTEN"], { encoding: "utf8", stdio: "pipe" });
    throw new Error("Port 15188 is occupied; do not terminate or reuse its listener");
  } catch (error) {
    const failure = error as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    if (failure.status !== 1 || String(failure.stdout ?? "").trim() || String(failure.stderr ?? "").trim()) throw error;
  }
  process.env.UX_QA_COORDINATOR_PID = String(process.pid);
}

export default defineConfig({
  testDir: __dirname, testMatch: "page-session-ux.spec.ts", outputDir,
  workers: 1, fullyParallel: false, retries: 0, forbidOnly: true,
  timeout: 30_000, expect: { timeout: 5_000 },
  reporter: [["line"], ["json", { outputFile: resolve(__dirname, "runs", run, "results.json") }]],
  use: { baseURL: "http://127.0.0.1:15188", trace: "off", screenshot: "only-on-failure" },
  projects: [{ name: "chromium-ux-six-cases", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    cwd: root,
    command: "VITE_TEST_DATA_TOOLS_ENABLED=false WEB_PORT=15188 pnpm --filter @led-control/web dev",
    url: "http://127.0.0.1:15188", reuseExistingServer: false, timeout: 120_000
  }
});

