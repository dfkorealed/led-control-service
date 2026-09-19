// Only self-owned disposable containers and random loopback ports. Never loads .env.
const { execFileSync, spawnSync } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { mkdtempSync, cpSync, readdirSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { PrismaClient } = require("@prisma/client");
const api = resolve(__dirname, "../..");
const migration = "20260919200000_floor_import_prepared_map_generation";
const token = `${process.pid}-${Date.now()}`;
const owned = [];
const temporary = mkdtempSync(join(tmpdir(), "u4b-migrations-"));
const user = `u4b_${randomBytes(6).toString("hex")}`, password = randomBytes(32).toString("hex");
function docker(args, options = {}) { return execFileSync("docker", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...options }).trim(); }
function launch(name, image, port, env, args = []) {
  const id = docker(["run", "-d", "--name", name, "-p", `127.0.0.1::${port}`, ...Object.keys(env).flatMap(key => ["-e", key]), image, ...args], { env: { ...process.env, ...env } });
  owned.push(id);
  const info = JSON.parse(docker(["inspect", id]))[0], mapping = info.NetworkSettings.Ports[`${port}/tcp`][0];
  if (info.Id !== id || info.Name !== `/${name}` || info.Config.Image !== image || mapping.HostIp !== "127.0.0.1") throw new Error("container identity mismatch");
  return { id, port: mapping.HostPort };
}
function sql(id, db, statement) {
  return docker(["exec", "-i", id, "sh", "-c", 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$1" -XAt -v ON_ERROR_STOP=1', "u4b", db], { input: statement });
}
function run(args, env) {
  const result = spawnSync("pnpm", args, { cwd: api, env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  process.stdout.write(`${result.stdout ?? ""}${result.stderr ?? ""}`.replace(/postgres(?:ql)?:\/\/[^\s"']+/g, "[DB URL redacted]"));
  if (result.status !== 0) throw new Error(`focused command failed (${result.status})`);
}
async function main() {
  const pg = launch(`led-u4b-pg-${token}`, "postgres:16-alpine", 5432,
    { POSTGRES_USER: user, POSTGRES_PASSWORD: password, POSTGRES_DB: "postgres" });
  const minio = launch(`led-u4b-minio-${token}`, "minio/minio:RELEASE.2025-04-22T22-12-26Z", 9000,
    { MINIO_ROOT_USER: user, MINIO_ROOT_PASSWORD: password }, ["server", "/data"]);
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try { ready = sql(pg.id, "postgres", "SELECT 1") === "1" && (await fetch(`http://127.0.0.1:${minio.port}/minio/health/ready`)).ok; } catch {}
    if (ready) break; await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error("isolated services unavailable");
  const previous = join(temporary, "prisma"); cpSync(join(api, "prisma"), previous, { recursive: true });
  for (const name of readdirSync(join(previous, "migrations"))) if (/^\d/.test(name) && name >= migration) rmSync(join(previous, "migrations", name), { recursive: true });
  for (const mode of ["upgrade", "clean"]) {
    const db = `led_u4b_test_${process.pid}_${Date.now()}_${mode}`;
    sql(pg.id, "postgres", `CREATE DATABASE "${db}"`);
    const url = new URL(`postgresql://127.0.0.1:${pg.port}/${db}`); url.username = user; url.password = password;
    const client = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    try {
      const [identity] = await client.$queryRaw`SELECT current_database() AS name, inet_server_port() AS port`;
      if (identity.name !== db || identity.port !== 5432 || sql(pg.id, db, "SELECT current_database()") !== db) throw new Error("isolated database identity mismatch");
      console.log(`Verified owned PostgreSQL and real MinIO: ${mode}`);
      const env = { DATABASE_URL: url.toString(), U4B_TEST_DATABASE_URL: url.toString(),
        U4B_MINIO_ENDPOINT: `http://127.0.0.1:${minio.port}`, U4B_MINIO_USER: user, U4B_MINIO_PASSWORD: password };
      if (mode === "upgrade") {
        run(["exec", "prisma", "migrate", "deploy", "--schema", join(previous, "schema.prisma")], env);
        sql(pg.id, db, `INSERT INTO "Organization" (id,name,"updatedAt") VALUES ('u4b-old-org','old',now());
          INSERT INTO "Site" (id,"organizationId",name,"updatedAt") VALUES ('u4b-old-site','u4b-old-org','old',now());
          INSERT INTO "Floor" (id,"siteId",name,level,"mapRevision","updatedAt") VALUES ('u4b-old-floor','u4b-old-site','old',1,7,now());`);
      }
      run(["exec", "prisma", "migrate", "deploy"], env);
      if (mode === "upgrade" && sql(pg.id, db, `SELECT "mapRevision" FROM "Floor" WHERE id='u4b-old-floor'`) !== "7") throw new Error("legacy floor changed");
      run(["exec", "jest", "cad-map-preparation.integration.spec.ts", "--runInBand"], env);
    } finally { await client.$disconnect(); }
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => {
  for (const id of owned.reverse()) docker(["rm", "-fv", id]);
  rmSync(temporary, { recursive: true, force: true });
  console.log("Removed only self-owned disposable PostgreSQL/MinIO containers.");
});
