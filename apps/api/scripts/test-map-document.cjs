// Opt-in integration runner. The existing Docker service is only a host for
// freshly created databases; no migration/reset is ever run against the app DB.
const { execFileSync, spawnSync } = require("node:child_process");
const { mkdtempSync, cpSync, readdirSync, rmSync } = require("node:fs");
const { randomBytes } = require("node:crypto");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const { PrismaClient } = require("@prisma/client");
const api = resolve(__dirname, "..");
const migration = "20260919180000_map_document";
const container = `led-u3-postgres-${process.pid}-${Date.now()}`;
let containerId;
const created = [];
const temporary = mkdtempSync(join(tmpdir(), "led-u3-migrations-"));
const env = { ...process.env };
const credentials = { POSTGRES_USER: `u3_${randomBytes(8).toString("hex")}`, POSTGRES_PASSWORD: randomBytes(32).toString("hex"), POSTGRES_DB: "postgres" };

function dockerSql(database, sql) {
  // Credentials remain in the existing container environment, never in argv/logs.
  return execFileSync("docker", ["exec", "-i", container, "sh", "-c",
    'export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$1" -XAt -v ON_ERROR_STOP=1', "u3-psql", database],
  { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}
function run(command, args, extraEnv) {
  const result = spawnSync(command, args, { cwd: api, env: { ...env, ...extraEnv }, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  // Prisma displays the datasource host/name, never the password. Redact even an
  // unexpected library error containing a connection URL before showing output.
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.replace(/postgres(?:ql)?:\/\/[^\s"']+/g, "[database URL redacted]");
  process.stdout.write(output);
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}
async function main() {
  containerId = execFileSync("docker", ["run", "-d", "--name", container, "-p", "127.0.0.1::5432",
    "-e", "POSTGRES_USER", "-e", "POSTGRES_PASSWORD", "-e", "POSTGRES_DB", "postgres:16-alpine"],
  { env: { ...env, ...credentials }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const info = JSON.parse(execFileSync("docker", ["inspect", containerId], { encoding: "utf8" }))[0];
  if (info.Id !== containerId || !info.State.Running || info.Config.Image !== "postgres:16-alpine" || info.Name !== `/${container}`) throw new Error("unexpected isolated Docker identity");
  const port = info.NetworkSettings.Ports["5432/tcp"][0];
  if (port.HostIp !== "127.0.0.1") throw new Error("expected loopback-only isolated PostgreSQL");
  const app = new URL(`postgresql://127.0.0.1:${port.HostPort}/postgres`);
  app.username = credentials.POSTGRES_USER; app.password = credentials.POSTGRES_PASSWORD;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { ready = dockerSql("postgres", "SELECT 1;") === "1"; if (ready) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error("isolated PostgreSQL did not become ready");
  const base = join(temporary, "prisma"); cpSync(join(api, "prisma"), base, { recursive: true });
  for (const name of readdirSync(join(base, "migrations"))) {
    if (/^\d/.test(name) && name >= migration) rmSync(join(base, "migrations", name), { recursive: true });
  }
  for (const mode of ["upgrade", "clean"]) {
    const name = `led_u3_test_${Date.now()}_${process.pid}_${mode}`;
    if (!/^led_u3_test_[a-z0-9_]+$/.test(name) || app.pathname === `/${name}`) throw new Error("unsafe DB identity");
    dockerSql("postgres", `CREATE DATABASE "${name}";`); created.push(name);
    const target = new URL(app); target.pathname = `/${name}`; target.search = "";
    const url = target.toString();
    const client = new PrismaClient({ datasources: { db: { url } } });
    try {
      const [identity] = await client.$queryRaw`SELECT current_database() AS database, inet_server_port() AS port`;
      if (identity.database !== name || identity.port !== 5432 || dockerSql(name, "SELECT current_database();") !== name) throw new Error("isolated DB identity mismatch");
      console.log(`Verified isolated DB: ${name}; Docker postgres:16-alpine; mode=${mode}`);
      if (mode === "upgrade") {
        run(process.execPath, [require.resolve("prisma/build/index.js"), "migrate", "deploy", "--schema", join(base, "schema.prisma")], { DATABASE_URL: url });
        dockerSql(name, `INSERT INTO "Organization" (id,name,"updatedAt") VALUES ('u3-legacy-org','retained',CURRENT_TIMESTAMP);
          INSERT INTO "Site" (id,"organizationId",name,"updatedAt") VALUES ('u3-legacy-site','u3-legacy-org','retained',CURRENT_TIMESTAMP);
          INSERT INTO "Floor" (id,"siteId",name,level,"mapRevision","updatedAt") VALUES ('u3-legacy-floor','u3-legacy-site','retained',1,7,CURRENT_TIMESTAMP);
          INSERT INTO "FloorMapObject" (id,"floorId",type,x,y,"updatedAt") VALUES ('u3-legacy-object','u3-legacy-floor','rectangle',20,30,CURRENT_TIMESTAMP);`);
        // Old cleanup must work before the new tables exist. No live app is used.
        run("pnpm", ["exec", "jest", "src/floor-editor/map-document-rollout.integration.spec.ts", "--runInBand"], { FLOOR_EDITOR_TEST_DATABASE_URL: url });
      }
      run(process.execPath, [require.resolve("prisma/build/index.js"), "migrate", "deploy", "--schema", join(api, "prisma/schema.prisma")], { DATABASE_URL: url });
      if (mode === "upgrade") {
        const kept = dockerSql(name, `SELECT "mapRevision" FROM "Floor" WHERE id='u3-legacy-floor'; SELECT count(*) FROM "FloorMapObject" WHERE id='u3-legacy-object';`);
        if (kept !== "7\n1") throw new Error("additive migration changed old map data");
      }
      run("pnpm", ["exec", "jest", "src/floor-editor/map-document-codec.spec.ts", "src/floor-editor/map-document-store.integration.spec.ts",
        "src/floor-editor/map-document-snapshot.spec.ts", "src/floor-editor/floor-asset-cleanup.service.spec.ts", "--runInBand"], { FLOOR_EDITOR_TEST_DATABASE_URL: url });
    } finally { await client.$disconnect(); }
  }
}
main().catch(error => { console.error(error.message.replace(/postgres(?:ql)?:\/\/[^\s"']+/g, "[database URL redacted]")); process.exitCode = 1; })
  .finally(() => {
    try {
      for (const name of created) {
        if (dockerSql(name, "SELECT current_database();") !== name) throw new Error("refusing to drop unverified DB");
        dockerSql("postgres", `DROP DATABASE "${name}";`);
        console.log(`Removed owned isolated DB: ${name}`);
      }
    } finally {
      if (containerId) execFileSync("docker", ["rm", "-fv", containerId], { stdio: "pipe" });
      rmSync(temporary, { recursive: true, force: true });
    }
  });
