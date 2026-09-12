import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

// Own the detached POSIX process group, not just its launcher or stdio pipes.
// A dead launcher can leave live descendants; 'close' alone may never arrive.
export function runBoundedProcess(command, args, {
  cwd, env, signal, timeoutMs = 30 * 60_000, drainGraceMs = 3000,
  termGraceMs = 2000, killGraceMs = 2000, onStdout, onStderr,
} = {}) {
  for (const duration of [timeoutMs, drainGraceMs, termGraceMs, killGraceMs]) {
    if (!Number.isSafeInteger(duration) || duration <= 0) throw Error("positive process deadline required");
  }
  if (signal?.aborted) return Promise.resolve({ status: 1, reason: "interrupted", stdout: "", stderr: "" });
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const start = performance.now();
    let stdout = "", stderr = "", exit, closed = false, exitedAt, termAt, killedAt, reason, done = false;
    const groupAlive = () => {
      if (!child.pid) return false;
      try { process.kill(-child.pid, 0); return true; }
      catch (error) { if (error.code === "ESRCH") return false; return true; }
    };
    const send = value => {
      try { process.kill(-child.pid, value); }
      catch (error) { if (error.code !== "ESRCH") reason = "owned process signal failed"; }
    };
    const finish = unsafeCleanup => {
      if (done) return;
      done = true; clearInterval(poll); signal?.removeEventListener("abort", abort);
      // Do not let inherited pipes defeat the hard wall deadline. A still-live
      // group is an explicit cleanup failure, never permission to erase staging.
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      resolve({ status: unsafeCleanup || reason ? 1 : exit ?? 1, reason, stdout, stderr, pid: child.pid, unsafeCleanup });
    };
    const terminate = message => {
      if (termAt !== undefined) return;
      reason = message; termAt = performance.now();
      if (groupAlive()) send("SIGTERM");
    };
    const abort = () => terminate("interrupted");
    const check = () => {
      const now = performance.now(), alive = groupAlive();
      if (!alive && closed) return finish(false);
      if (termAt === undefined) {
        if (now - start >= timeoutMs) terminate("deadline exceeded");
        else if (exitedAt !== undefined && now - exitedAt >= drainGraceMs) terminate("descendant drain exceeded");
      }
      if (termAt !== undefined && now - termAt >= termGraceMs && killedAt === undefined) {
        killedAt = now; if (alive) send("SIGKILL");
      }
      if (killedAt !== undefined && now - killedAt >= killGraceMs) finish(alive);
    };
    const poll = setInterval(check, 20);
    child.stdout.on("data", bytes => { stdout = (stdout + bytes).slice(-4 * 1024 * 1024); onStdout?.(bytes); });
    child.stderr.on("data", bytes => { stderr = (stderr + bytes).slice(-4 * 1024 * 1024); onStderr?.(bytes); });
    child.on("exit", status => { exit = status ?? 1; exitedAt = performance.now(); });
    child.on("close", () => { closed = true; check(); });
    child.on("error", () => { reason = "process spawn failed"; closed = true; check(); });
    signal?.addEventListener("abort", abort, { once: true });
  });
}
