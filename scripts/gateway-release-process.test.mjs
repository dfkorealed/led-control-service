import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

test("owned process hard deadline kills a real TERM-ignoring child", async () => {
  const { runBoundedProcess } = await import("./gateway-release-process.mjs");
  const start = performance.now();
  const result = await runBoundedProcess(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {
    timeoutMs: 500, termGraceMs: 100, killGraceMs: 500,
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.reason, "deadline exceeded");
  assert.ok(performance.now() - start < 2000);
  assert.throws(() => process.kill(-result.pid, 0), { code: "ESRCH" });
});

test("abort escalates even when a real child ignores TERM and inherits open pipes", async () => {
  const { runBoundedProcess } = await import("./gateway-release-process.mjs");
  const abort = new AbortController(), start = performance.now();
  const result = await runBoundedProcess(process.execPath, ["-e", "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"], {
    signal: abort.signal, timeoutMs: 3000, termGraceMs: 100, killGraceMs: 500,
    onStdout: bytes => { if (bytes.toString().includes("ready")) abort.abort(); },
  });
  assert.notEqual(result.status, 0); assert.equal(result.reason, "interrupted");
  assert.ok(performance.now() - start < 2000);
  assert.throws(() => process.kill(-result.pid, 0), { code: "ESRCH" });
});

test("owned process preserves conclusive status and output without leaving its group", async () => {
  const { runBoundedProcess } = await import("./gateway-release-process.mjs");
  const result = await runBoundedProcess(process.execPath, ["-e", "console.log('complete');process.exitCode=17"], { timeoutMs: 1000 });
  assert.equal(result.status, 17); assert.equal(result.reason, undefined); assert.equal(result.stdout, "complete\n");
  assert.throws(() => process.kill(-result.pid, 0), { code: "ESRCH" });
});
