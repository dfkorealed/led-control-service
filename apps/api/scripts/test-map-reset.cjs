// U5-only disposable PostgreSQL. Never reads DATABASE_URL or touches app services.
const { execFileSync, spawnSync } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { resolve, join } = require("node:path");
const { PrismaClient } = require("@prisma/client");
const api = resolve(__dirname, "..");
const container = `led-u5-postgres-${process.pid}-${Date.now()}`;
const database = `led_u5_test_${process.pid}_${Date.now()}`;
const credentials = { POSTGRES_USER: `u5_${randomBytes(8).toString("hex")}`,
  POSTGRES_PASSWORD: randomBytes(32).toString("hex"), POSTGRES_DB: "postgres" };
let containerId;
function sql(db, query) {
  return execFileSync("docker", ["exec", "-i", containerId, "sh", "-c",
    'export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$1" -XAt -v ON_ERROR_STOP=1', "u5-psql", db],
  { input: query, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}
const redact = text => text.replace(/postgres(?:ql)?:\/\/[^\s"']+/g, "[database URL redacted]");
function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: api, env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  process.stdout.write(redact(`${result.stdout ?? ""}${result.stderr ?? ""}`));
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}
async function main() {
  containerId = execFileSync("docker", ["run", "-d", "--name", container, "-p", "127.0.0.1::5432",
    "-e", "POSTGRES_USER", "-e", "POSTGRES_PASSWORD", "-e", "POSTGRES_DB", "postgres:16-alpine"],
  { env: { ...process.env, ...credentials }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const info = JSON.parse(execFileSync("docker", ["inspect", containerId], { encoding: "utf8" }))[0];
  if (info.Id !== containerId || info.Name !== `/${container}` || !info.State.Running || info.Config.Image !== "postgres:16-alpine") throw new Error("wrong owned container identity");
  const port = info.NetworkSettings.Ports["5432/tcp"][0];
  if (port.HostIp !== "127.0.0.1") throw new Error("expected loopback-only binding");
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { if (sql("postgres", "SELECT 1") === "1") { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error("owned PostgreSQL unavailable");
  sql("postgres", `CREATE DATABASE "${database}"`);
  const target = new URL(`postgresql://127.0.0.1:${port.HostPort}/${database}`);
  target.username = credentials.POSTGRES_USER; target.password = credentials.POSTGRES_PASSWORD;
  const url = target.toString();
  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    const [identity] = await prisma.$queryRaw`SELECT current_database() AS database, inet_server_port() AS port`;
    if (identity.database !== database || identity.port !== 5432 || sql(database, "SELECT current_database()") !== database) throw new Error("owned DB identity mismatch");
    console.log(`Verified owned U5 database ${database}`);
    run(process.execPath, [require.resolve("prisma/build/index.js"), "migrate", "deploy", "--schema", join(api, "prisma/schema.prisma")], { DATABASE_URL: url });
    run("pnpm", ["exec", "jest", "src/floor-editor/map-document-reset.service.spec.ts",
      "src/floor-editor/map-document-reset.integration.spec.ts", "--runInBand"], { MAP_RESET_TEST_DATABASE_URL: url, DATABASE_URL: url });
  } finally { await prisma.$disconnect(); }
}
main().catch(error => { console.error(redact(error.message)); process.exitCode = 1; }).finally(() => {
  // Exact random container ID owns the complete throwaway cluster and volumes.
  if (containerId) {
    execFileSync("docker", ["rm", "-fv", containerId], { stdio: "pipe" });
    console.log("Removed owned U5 PostgreSQL container and volumes");
  }
});
