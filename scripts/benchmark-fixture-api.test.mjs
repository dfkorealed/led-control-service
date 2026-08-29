import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(projectRoot, "scripts/benchmark-fixture-api.mjs");

function runBenchmark(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: projectRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("site ID가 없으면 벤치마크 실행 전에 필수 입력 오류를 반환한다", async () => {
  const result = await runBenchmark({
    API_BENCH_SITE_ID: "",
    API_BENCH_FLOOR_ID: "floor-1",
    API_BENCH_SESSION_COOKIE: "session=test",
    API_BENCH_SAMPLES: "20"
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /API_BENCH_SITE_ID/);
});

test("site와 floor ID를 인코딩한 실제 조명 조회 경로로 요청한다", async (t) => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { "content-type": "application/json" });
    response.end("[]");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const result = await runBenchmark({
    API_BENCH_URL: `http://127.0.0.1:${address.port}`,
    API_BENCH_SITE_ID: "site/서울 1",
    API_BENCH_FLOOR_ID: "floor/B1 2",
    API_BENCH_SESSION_COOKIE: "session=test",
    API_BENCH_SAMPLES: "20"
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 20);
  assert.deepEqual(
    [...new Set(requests)],
    ["/sites/site%2F%EC%84%9C%EC%9A%B8%201/floors/floor%2FB1%202/fixtures?limit=200"]
  );
});
