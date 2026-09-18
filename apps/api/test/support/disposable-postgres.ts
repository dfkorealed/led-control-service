import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

/** A self-owned Unix test cluster. Never reads an ambient database URL or TMPDIR. */
export async function disposablePostgres() {
  const directory = mkdtempSync(join(realpathSync("/tmp"), "gateway-watermark-"));
  if (!/^\/[A-Za-z0-9/_-]+$/.test(directory)) throw new Error("unsafe pg_ctl fixture path");
  let started = false;
  let sequence = 0;
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("missing ephemeral port"));
      server.close(() => resolve(address.port));
    });
  });
  const url = (database: string) => `postgresql://postgres@127.0.0.1:${port}/${database}`;
  const sql = (databaseUrl: string, statement: string) => checked("psql", [databaseUrl, "-XAt", "-v", "ON_ERROR_STOP=1", "-c", statement]);
  const stop = () => {
    if (started) checked("pg_ctl", ["-D", join(directory, "data"), "-m", "immediate", "-w", "stop"]);
    started = false;
    // Only remove our generated directory after its server has stopped.
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    checked("initdb", ["-D", join(directory, "data"), "-U", "postgres", "--auth=trust", "--no-locale", "--encoding=UTF8"]);
    checked("pg_ctl", ["-D", join(directory, "data"), "-l", join(directory, "postgres.log"), "-o", `-h 127.0.0.1 -p ${port} -k ${directory}`, "-w", "start"]);
    started = true;
  } catch (error) {
    stop();
    throw error;
  }
  return {
    stop, sql,
    database() {
      const name = `watermark_${sequence++}`;
      sql(url("postgres"), `CREATE DATABASE "${name}"`);
      return url(name);
    },
    deploy(databaseUrl: string, through = "99999999", options: { exclude?: string[] } = {}) {
      const copy = mkdtempSync(join(directory, "schema-"));
      cpSync(join(__dirname, "../../prisma"), copy, { recursive: true });
      for (const name of readdirSync(join(copy, "migrations"))) {
        if (/^\d/.test(name) && (name > through || options.exclude?.includes(name))) {
          rmSync(join(copy, "migrations", name), { recursive: true });
        }
      }
      return spawnSync(process.execPath, [require.resolve("prisma/build/index.js"), "migrate", "deploy", "--schema", join(copy, "schema.prisma")], {
        cwd: directory, env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: "utf8", timeout: 30_000
      });
    },
    resolveRolledBack(databaseUrl: string, migrationName: string) {
      return spawnSync(process.execPath, [
        require.resolve("prisma/build/index.js"), "migrate", "resolve", "--rolled-back", migrationName,
        "--schema", join(__dirname, "../../prisma/schema.prisma")
      ], {
        cwd: directory, env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: "utf8", timeout: 30_000
      });
    }
  };
}

function checked(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}
