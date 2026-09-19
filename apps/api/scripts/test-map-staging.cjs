const { execFileSync, spawnSync } = require("node:child_process");
const { cpSync, mkdtempSync, readdirSync, rmSync } = require("node:fs");
const { randomBytes } = require("node:crypto");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const { PrismaClient } = require("@prisma/client");
const api = resolve(__dirname, ".."), migration = "20260919210000_map_stage_execution";
const id = `${process.pid}_${Date.now()}`, owned = [];
const user = `u6b_${randomBytes(8).toString("hex")}`, password = randomBytes(32).toString("hex");
const temporary = mkdtempSync(join(tmpdir(), "led-u6b-migrations-"));
const docker = args => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const redact = s => s.replace(/postgres(?:ql)?:\/\/[^\s"']+/g, "[isolated database]");
function start(name, image, port, vars, command = []) {
  const cid = execFileSync("docker", ["run", "-d", "--name", name, "-p", `127.0.0.1::${port}`,
    ...Object.keys(vars).flatMap(k => ["-e", k]), image, ...command],
    { env: { ...process.env, ...vars }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  owned.push(cid);
  const info = JSON.parse(docker(["inspect", cid]))[0], binding = info.NetworkSettings.Ports[`${port}/tcp`][0];
  if (info.Id !== cid || info.Name !== `/${name}` || info.Config.Image !== image || binding.HostIp !== "127.0.0.1") throw Error("container identity mismatch");
  return { cid, port: binding.HostPort };
}
function sql(cid, database, query) {
  return execFileSync("docker", ["exec", "-i", cid, "sh", "-c",
    'export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$1" -XAt -v ON_ERROR_STOP=1', "u6b-psql", database],
    { input: query, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}
function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: api, env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  process.stdout.write(redact((result.stdout || "") + (result.stderr || "")));
  if (result.status !== 0) throw Error(`${command} exited ${result.status}`);
}
async function main() {
  const pg = start(`led-u6b-pg-${id}`, "postgres:16-alpine", 5432, { POSTGRES_USER: user, POSTGRES_PASSWORD: password, POSTGRES_DB: "postgres" });
  const minio = start(`led-u6b-minio-${id}`, "minio/minio:RELEASE.2025-04-22T22-12-26Z", 9000,
    { MINIO_ROOT_USER: user, MINIO_ROOT_PASSWORD: password }, ["server", "/data"]);
  const endpoint = `http://127.0.0.1:${minio.port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if (sql(pg.cid, "postgres", "SELECT 1") === "1" && (await fetch(`${endpoint}/minio/health/ready`)).ok) { ready = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  if (!ready) throw Error("isolated services not ready");
  const previous = join(temporary, "prisma"); cpSync(join(api, "prisma"), previous, { recursive: true });
  for (const name of readdirSync(join(previous, "migrations"))) if (/^\d/.test(name) && name >= migration) rmSync(join(previous, "migrations", name), { recursive: true });
  for (const mode of (process.env.U6B_MODES || "clean,upgrade").split(",")) {
    if (!["clean", "upgrade"].includes(mode)) throw Error("invalid mode");
    const database = `led_u6b_test_${id}_${mode}`;
    sql(pg.cid, "postgres", `CREATE DATABASE "${database}"`);
    const url = `postgresql://${user}:${password}@127.0.0.1:${pg.port}/${database}`;
    const prisma = new PrismaClient({ datasourceUrl: url });
    try {
      const [identity] = await prisma.$queryRaw`SELECT current_database() AS name, inet_server_port() AS port`;
      if (identity.name !== database || identity.port !== 5432 || sql(pg.cid, database, "SELECT current_database()") !== database) throw Error("DB identity mismatch");
      const env = { DATABASE_URL: url, U6B_TEST_DATABASE_URL: url, U6B_TEST_MODE: mode,
        U6B_MINIO_ENDPOINT: endpoint, U6B_MINIO_USER: user, U6B_MINIO_PASSWORD: password };
      const migrate = schema => run(process.execPath, [require.resolve("prisma/build/index.js"), "migrate", "deploy", "--schema", schema], env);
      if (mode === "upgrade") {
        migrate(join(previous, "schema.prisma"));
        sql(pg.cid, database, `INSERT INTO "Organization" (id,name,"updatedAt") VALUES ('u6b-legacy-org','retained',CURRENT_TIMESTAMP);
          INSERT INTO "User" (id,"organizationId","loginId",name,"passwordHash",role,"updatedAt")
            VALUES ('u6b-legacy-user','u6b-legacy-org','u6b-legacy','retained','unused','admin',CURRENT_TIMESTAMP);
          INSERT INTO "Site" (id,"organizationId",name,"updatedAt") VALUES ('u6b-legacy-site','u6b-legacy-org','retained',CURRENT_TIMESTAMP);
          INSERT INTO "Floor" (id,"siteId",name,level,"mapRevision","updatedAt") VALUES ('u6b-legacy-floor','u6b-legacy-site','retained',1,7,CURRENT_TIMESTAMP);
          INSERT INTO "FloorMapGeneration" (id,"floorId","baseRevision",width,height,"gridSize","expiresAt","updatedAt")
            VALUES ('u6b-legacy-generation','u6b-legacy-floor',7,1024,1024,10,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
          INSERT INTO "FloorMapRevision" (id,"floorId",revision,snapshot,"snapshotSha256","changeSummary","changedBy")
            VALUES ('u6b-legacy-revision','u6b-legacy-floor',7,'{}',repeat('a',64),'{}','u6b-legacy-user');
          INSERT INTO "FloorAsset" (id,"floorId",kind,"objectKey","mimeType","sizeBytes",sha256,"updatedAt")
            SELECT 'u6b-asset-'||s,'u6b-legacy-floor','map_stage_part','u6b/'||s,'application/octet-stream',1,repeat('a',64),CURRENT_TIMESTAMP FROM unnest(ARRAY['preparing','ready','committed','failed']) s;
          INSERT INTO "FloorMapStage" (id,"floorId","generationId","requestId","userId","leaseTokenHash","baseRevision",status,"expiresAt","updatedAt")
            SELECT 'u6b-'||s,'u6b-legacy-floor','u6b-legacy-generation','u6b-'||s,'legacy',repeat('a',64),7,s::"FloorMapStageStatus",CURRENT_TIMESTAMP,CURRENT_TIMESTAMP FROM unnest(ARRAY['preparing','ready','committed','failed']) s;
          INSERT INTO "FloorMapStagePart" ("stageId","floorId",part,"assetId",sha256,"decodedBytes")
            SELECT 'u6b-'||s,'u6b-legacy-floor',0,'u6b-asset-'||s,repeat('a',64),1 FROM unnest(ARRAY['preparing','ready','committed','failed']) s;
          INSERT INTO "FloorMapRevisionAsset" ("revisionId","floorId","generationId","assetId") VALUES ('u6b-legacy-revision','u6b-legacy-floor','u6b-legacy-generation','u6b-asset-committed');`);
      }
      migrate(join(api, "prisma/schema.prisma"));
      const specs = (process.env.U6B_TEST_FILES || "src/floor-editor/map-document-stage-schema.integration.spec.ts").split(",");
      run("pnpm", ["exec", "jest", ...specs, "--runInBand"], env);
    } finally { await prisma.$disconnect(); }
  }
}
main().catch(error => { console.error(redact(error.message)); process.exitCode = 1; }).finally(() => {
  for (const cid of owned.reverse()) docker(["rm", "-fv", cid]);
  rmSync(temporary, { recursive: true, force: true });
  console.log("Exact owned U6b containers, volumes and migration copies removed");
});
