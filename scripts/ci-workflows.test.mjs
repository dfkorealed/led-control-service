import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";
import "./gateway-release-ci.test.mjs";
import "./gateway-release-process.test.mjs";

const root = path.resolve(import.meta.dirname, "..");
const softwareJobNames = [
  "quality",
  "unit",
  "postgres-redis-integration",
  "playwright-real-core",
  "build",
  "production-audit"
];
const integrationSuites = [
  "src/auth/auth.integration.spec.ts",
  "src/access/site-access.integration.spec.ts",
  "src/site-users/site-users.integration.spec.ts",
  "src/prisma/site-user-access-migration.integration.spec.ts",
  "src/floor-editor/editor-lease.redis.integration.spec.ts",
  "src/floor-editor/editor-lease.integration.spec.ts",
  "src/floor-editor/floor-editor.integration.spec.ts",
  "src/fixture-identify/fixture-identify.integration.spec.ts",
  "src/gateway-onboarding/gateway-onboarding-registration.integration.spec.ts",
  "src/pki/certificate-concurrency.integration.spec.ts",
  "test/gateway-pki.e2e-spec.ts",
  "test/automation-schedules.e2e-spec.ts",
  "test/vehicle-event-rules.e2e-spec.ts"
];
const hilCommandVariables = [
  "HIL_CLAIM_COMMAND_JSON",
  "HIL_BOOTSTRAP_COMMAND_JSON",
  "HIL_SECURE_MQTT_COMMAND_JSON",
  "HIL_SCAN_COMMAND_JSON",
  "HIL_PROVISION_COMMAND_JSON",
  "HIL_BIND_COMMAND_JSON",
  "HIL_INDIVIDUAL_CONTROL_COMMAND_JSON",
  "HIL_GROUP_CONTROL_COMMAND_JSON",
  "HIL_STALE_EVENT_COMMAND_JSON",
  "HIL_OFFLINE_COMMAND_JSON",
  "HIL_RESTART_RECOVERY_COMMAND_JSON",
  "HIL_ACL_NEGATIVE_COMMAND_JSON",
  "PKI_HIL_MANUFACTURING_COMMAND_JSON",
  "PKI_HIL_TOKEN_REUSE_COMMAND_JSON",
  "PKI_HIL_CSR_TAMPER_COMMAND_JSON",
  "PKI_HIL_SERIAL_MISMATCH_COMMAND_JSON",
  "PKI_HIL_WRONG_CA_COMMAND_JSON",
  "PKI_HIL_CLAIM_BOOTSTRAP_MQTT_COMMAND_JSON",
  "PKI_HIL_RESTART_RECOVERY_COMMAND_JSON",
  "PKI_HIL_MQTT_ROTATION_COMMAND_JSON",
  "PKI_HIL_TWO_GATEWAY_FINGERPRINT_COMMAND_JSON",
  "PKI_HIL_SECRET_SCAN_COMMAND_JSON"
];

test("software CI is a strict frozen-install chain through production audit", async () => {
  const workflow = await parseWorkflow("ci.yml");
  assert.deepEqual(Object.keys(workflow.on).sort(), ["pull_request", "push"]);
  assert.deepEqual(Object.keys(workflow.jobs), softwareJobNames);
  assert.equal(workflow.jobs.quality.needs, undefined);
  for (let index = 1; index < softwareJobNames.length; index += 1) {
    assert.equal(workflow.jobs[softwareJobNames[index]].needs, softwareJobNames[index - 1]);
  }
  for (const name of softwareJobNames) assertSoftwareJobSetup(workflow.jobs[name], name);

  assertCannotBeSkipped(workflow.jobs["production-audit"], "production-audit job");
  assertCannotBeSkipped(findRunStep(workflow.jobs["production-audit"], "pnpm ci:production-audit"), "production-audit step");

  assertStepRuns(workflow.jobs.quality, "pnpm lint");
  assertStepRuns(workflow.jobs.quality, "pnpm typecheck");
  assertStepRuns(workflow.jobs.unit, "pnpm test");
  assertStepRuns(workflow.jobs.build, "pnpm build");
  assertStepRuns(workflow.jobs["production-audit"], "pnpm ci:production-audit");

  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(
    packageJson.scripts["test:unit"].split("tests/mqtt-production-config.node.mjs").length - 1,
    1,
    "the MQTT production contract must run exactly once in the unit gate"
  );
});

test("canonical unit gate runs UI policy fail-closed with its reviewed Git history", async () => {
  const workflow = await parseWorkflow("ci.yml");
  const unit = workflow.jobs.unit;
  const checkout = unit.steps.find((step) => step.uses === "actions/checkout@v4");
  assert.equal(checkout?.with?.["fetch-depth"], 0, "unit checkout must contain the reviewed UI policy source commit");

  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const command = packageJson.scripts["test:unit"];
  const webTests = "pnpm --filter @led-control/web test:ui-policy";
  const webCheck = "pnpm --filter @led-control/web ui:check";
  assert.equal(command.match(new RegExp(escapeRegExp(webTests), "g"))?.length, 1);
  assert.equal(command.match(new RegExp(escapeRegExp(webCheck), "g"))?.length, 1);
  assert.ok(command.indexOf("pnpm -r test") < command.indexOf(webTests));
  assert.ok(command.indexOf(webTests) < command.indexOf(webCheck));
  assertCannotBeSkipped(findRunStep(unit, "pnpm test"), "canonical unit gate");
});

test("unit CI isolates only the full API Jest suite without altering canonical gates", async () => {
  const workflow = await parseWorkflow("ci.yml");
  const step = findRunStep(workflow.jobs.unit, "pnpm test");
  assert.equal(step.env?.LED_API_UNIT_PROFILE, "isolated-linux-ci");
  assertCannotBeSkipped(step, "isolated API unit gate");
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name !== "unit") assert.ok(!JSON.stringify(job).includes("LED_API_UNIT_PROFILE"));
  }
  const pkg = JSON.parse(await readFile(path.join(root, "apps/api/package.json"), "utf8"));
  assert.equal(pkg.scripts.test, "node scripts/run-unit-tests.mjs");
});

test("API Jest launcher preserves default argv and validates the complete CI profile", async () => {
  const file = path.join(root, "apps/api/scripts/run-unit-tests.mjs");
  assert.ok(await readFile(file, "utf8").catch(() => ""), "API Jest launcher must exist");
  const { createJestInvocation } = await import(file);
  const apiRoot = path.join(root, "apps/api");
  const args = ["src/floor-import/cad-converter.spec.ts", "--runInBand"];
  const normal = createJestInvocation({ args, env: {}, platform: "linux", nodeExecutable: process.execPath, apiRoot });
  assert.equal(normal.executable, process.execPath);
  assert.deepEqual(normal.args.slice(1), args);
  assert.equal(normal.args[0], path.join(apiRoot, "node_modules/jest/bin/jest.js"));
  assert.equal(normal.detached, false);
  const env = { CI: "true", GITHUB_ACTIONS: "true", GITHUB_JOB: "unit", RUNNER_OS: "Linux", GITHUB_WORKSPACE: root, LED_API_UNIT_PROFILE: "isolated-linux-ci" };
  const isolated = createJestInvocation({ args: [], env, platform: "linux", nodeExecutable: process.execPath, apiRoot });
  assert.equal(isolated.executable, "/usr/bin/sudo");
  assert.equal(isolated.detached, true);
  assert.deepEqual(isolated.args, ["--non-interactive", "--", "/usr/bin/python3", path.join(apiRoot, "scripts/ci-unit-supervisor.py"), "--node", process.execPath]);
  for (const key of ["CI", "GITHUB_ACTIONS", "GITHUB_JOB", "RUNNER_OS", "GITHUB_WORKSPACE"]) {
    assert.throws(() => createJestInvocation({ args: [], env: { ...env, [key]: "invalid" }, platform: "linux", nodeExecutable: process.execPath, apiRoot }), /profile|workspace/i);
  }
  assert.throws(() => createJestInvocation({ args: [], env, platform: "darwin", nodeExecutable: process.execPath, apiRoot }), /Linux/);
  assert.throws(() => createJestInvocation({ args, env, platform: "linux", nodeExecutable: process.execPath, apiRoot }), /full suite/);
  assert.throws(() => createJestInvocation({ args: [], env: { LED_API_UNIT_PROFILE: "typo" }, platform: "linux", nodeExecutable: process.execPath, apiRoot }), /profile/);
});

test("API default launcher executes the same Jest argv and preserves failure status", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "api-unit-launcher-"));
  try {
    const scripts = path.join(directory, "scripts");
    const cli = path.join(directory, "node_modules/jest/bin");
    await mkdir(scripts, { recursive: true }); await mkdir(cli, { recursive: true });
    const launcher = path.join(scripts, "run-unit-tests.mjs");
    await writeFile(launcher, await readFile(path.join(root, "apps/api/scripts/run-unit-tests.mjs")));
    await writeFile(path.join(cli, "jest.js"), "console.log(JSON.stringify({args:process.argv.slice(2),checkpoint:process.env.CHECKPOINT_DISABLE})); process.exit(17);");
    const args = ["file with spaces.spec.ts", "--runInBand"];
    for (const value of [undefined, "local-kept"]) {
      const env = { PATH: process.env.PATH, ...(value === undefined ? {} : { CHECKPOINT_DISABLE: value }) };
      const result = spawnSync(process.execPath, [launcher, ...args], { encoding: "utf8", env });
      assert.equal(result.status, 17, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { args, ...(value === undefined ? {} : { checkpoint: value }) });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("API default launcher forwards SIGTERM and waits for its Jest child", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "api-unit-signal-"));
  let child;
  try {
    const scripts = path.join(directory, "scripts"); const cli = path.join(directory, "node_modules/jest/bin");
    await mkdir(scripts, { recursive: true }); await mkdir(cli, { recursive: true });
    const launcher = path.join(scripts, "run-unit-tests.mjs");
    await writeFile(launcher, await readFile(path.join(root, "apps/api/scripts/run-unit-tests.mjs")));
    await writeFile(path.join(cli, "jest.js"), "console.log('ready:'+process.pid); setInterval(()=>{},60000);");
    child = spawn(process.execPath, [launcher], { env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
    const pid = await new Promise((resolve, reject) => { child.stdout.once("data", chunk => resolve(Number(String(chunk).trim().split(":")[1]))); child.once("error", reject); });
    child.kill("SIGTERM");
    assert.deepEqual(await exited, { code: null, signal: "SIGTERM" });
    assert.throws(() => process.kill(pid, 0), error => error.code === "ESRCH");
  } finally { if (child?.exitCode === null && child?.signalCode === null) child.kill("SIGKILL"); await rm(directory, { recursive: true, force: true }); }
});

test("API supervisor rejects profile/argv changes and cleanup identity substitution", async () => {
  const supervisor = path.join(root, "apps/api/scripts/ci-unit-supervisor.py");
  assert.ok(await readFile(supervisor, "utf8").catch(() => ""), "privileged API supervisor must exist");
  const checked = spawnSync("python3", ["-c", `
import importlib.util, os, pathlib, tempfile
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location("supervisor", ${JSON.stringify(supervisor)})
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
api = pathlib.Path(${JSON.stringify(path.join(root, "apps/api"))})
env = {"CI":"true", "GITHUB_ACTIONS":"true", "GITHUB_JOB":"unit", "RUNNER_OS":"Linux", "GITHUB_WORKSPACE":str(api.parent.parent), "LED_API_UNIT_PROFILE":"isolated-linux-ci"}
module.validate_bootstrap({"version":1,"env":env,"args":[]}, api)
assert hasattr(module,"ci_jest_environment"), "CI-only test-tool checkpoint policy is missing"
parent={**env,"KEEP_CALLER_ENV":"yes","CHECKPOINT_DISABLE":"original"}
actor=SimpleNamespace(home="/owned/home",tmp="/owned/tmp",cache="/owned/cache")
isolated=module.ci_jest_environment(parent,actor)
assert isolated["CHECKPOINT_DISABLE"]=="1" and isolated["KEEP_CALLER_ENV"]=="yes"
assert isolated["GITHUB_WORKSPACE"]==parent["GITHUB_WORKSPACE"] and parent["CHECKPOINT_DISABLE"]=="original"
assert isolated["HOME"]=="/owned/home" and isolated["TMPDIR"]=="/owned/tmp" and isolated["XDG_CACHE_HOME"]=="/owned/cache"
for key in env:
    bad = dict(env); bad[key] = "invalid"
    try: module.validate_bootstrap({"version":1,"env":bad,"args":[]},api)
    except RuntimeError: pass
    else: raise AssertionError("accepted invalid profile "+key)
try: module.validate_bootstrap({"version":1,"env":env,"args":["--listTests"]},api)
except RuntimeError: pass
else: raise AssertionError("accepted filtered CI argv")
with tempfile.TemporaryDirectory() as directory:
    path=pathlib.Path(directory)/"owned"; path.mkdir()
    identity=module.directory_identity(path,os.getuid())
    module.verify_directory(path,identity)
    path.rmdir(); path.symlink_to(directory,target_is_directory=True)
    try: module.verify_directory(path,identity)
    except RuntimeError: pass
    else: raise AssertionError("accepted substituted cleanup path")
account=module.OwnedAccount(); account.uid=12345; account.owns_uid=False
module.signal_tasks=lambda *args: (_ for _ in ()).throw(AssertionError("attempted to signal a non-owned UID"))
assert module.stop_and_reap(account,None)==0
with tempfile.TemporaryDirectory() as directory:
    root=pathlib.Path(directory)
    baseline=root/"gateway-watermark-baseline"; baseline.mkdir()
    ledger=module.FixtureDirectories(root)
    try:
        # Even replacing a baseline inode never transfers that pathname's ownership.
        baseline.rmdir(); baseline.mkdir(); (baseline/"keep").write_text("baseline")
        symlink=root/"gateway-watermark-link"; symlink.symlink_to(baseline,target_is_directory=True)
        owned=root/"gateway-watermark-owned"; owned.mkdir()
        (owned/"nested-link").symlink_to(baseline,target_is_directory=True)
        ledger.observe(os.getuid()); assert set(ledger.captured)=={owned.name}
        original=root/"original"; owned.rename(original); owned.mkdir()
        try: ledger.remove()
        except RuntimeError: pass
        else: raise AssertionError("accepted changed fixture inode")
        assert (baseline/"keep").read_text()=="baseline" and symlink.is_symlink()
        owned.rmdir(); original.rename(owned); ledger.remove()
        assert not owned.exists() and (baseline/"keep").read_text()=="baseline" and symlink.is_symlink()
    finally: ledger.close()
print("profile/argv/directory identity passed")
`], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.match(checked.stdout, /identity passed/);
});

test("API workspace snapshot preserves installed links and rejects source escapes", async () => {
  const supervisor = path.join(root, "apps/api/scripts/ci-unit-supervisor.py");
  const checked = spawnSync("python3", ["-c", `
import importlib.util, os, pathlib, stat, tempfile
spec=importlib.util.spec_from_file_location("supervisor", ${JSON.stringify(supervisor)})
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
assert hasattr(module,"snapshot_workspace"), "owned workspace snapshot is missing"
with tempfile.TemporaryDirectory() as directory:
    root=pathlib.Path(directory); source=root/"source"; source.mkdir(mode=0o700)
    shared=source/"packages/shared/dist"; shared.mkdir(parents=True); (shared/"index.js").write_text("prepared shared")
    automation=source/"packages/automation-engine/dist"; automation.mkdir(parents=True); (automation/"index.js").write_text("prepared automation")
    virtual=source/"node_modules/.pnpm/package/node_modules/package"; virtual.mkdir(parents=True)
    entry=virtual/"index.js"; entry.write_text("installed package"); entry.chmod(0o400)
    modules=source/"apps/api/node_modules"; modules.mkdir(parents=True)
    link=modules/"package"; link.symlink_to("../../../node_modules/.pnpm/package/node_modules/package",target_is_directory=True)
    for name in (".git",".local",".worktrees"):
        (source/name).mkdir(); (source/name/"private").write_text("excluded")
    original={p:(p.lstat().st_ino,p.lstat().st_mode,p.lstat().st_uid) for p in (source,entry,link)}
    mirror=root/"mirror"; module.snapshot_workspace(source,mirror,os.getuid(),os.getgid())
    assert (mirror/"packages/shared/dist/index.js").read_text()=="prepared shared"
    assert (mirror/"packages/automation-engine/dist/index.js").read_text()=="prepared automation"
    assert (mirror/"apps/api/node_modules/package/index.js").read_text()=="installed package"
    assert (mirror/"apps/api/node_modules/package").readlink()==link.readlink()
    copied=mirror/entry.relative_to(source)
    assert copied.lstat().st_ino!=entry.lstat().st_ino, "snapshot must not hardlink the original"
    assert mirror.lstat().st_uid==os.getuid() and stat.S_IMODE(mirror.lstat().st_mode)&0o700==0o700
    assert all(not (mirror/name).exists() for name in (".git",".local",".worktrees"))
    assert original=={p:(p.lstat().st_ino,p.lstat().st_mode,p.lstat().st_uid) for p in original}
    bad=source/"escape"
    for index,target in enumerate(("../outside",str(entry),".local/private","missing")):
        (root/"outside").write_text("outside")
        bad.symlink_to(target)
        try: module.snapshot_workspace(source,root/("rejected-"+str(index)),os.getuid(),os.getgid())
        except (RuntimeError,FileNotFoundError): pass
        else: raise AssertionError("accepted forbidden symlink "+target)
        bad.unlink()
    # The final source target is included, but its intermediate alias is excluded.
    # Validate the copied graph before changing any copied inode's metadata.
    (source/".local/alias").symlink_to("../packages/shared/dist",target_is_directory=True)
    bad.symlink_to(".local/alias",target_is_directory=True)
    assert bad.resolve(strict=True)==shared.resolve(strict=True)
    chown=module.os.chown; metadata_changes=[]
    module.os.chown=lambda *args, **kwargs: metadata_changes.append(args)
    try:
        try: module.snapshot_workspace(source,root/"rejected-intermediate-alias",os.getuid(),os.getgid())
        except (RuntimeError,FileNotFoundError): pass
        else: raise AssertionError("accepted copied link through excluded intermediate alias")
        assert metadata_changes==[], "invalid copied links must fail before metadata changes"
    finally: module.os.chown=chown
    assert original=={p:(p.lstat().st_ino,p.lstat().st_mode,p.lstat().st_uid) for p in original}
    assert entry.read_text()=="installed package" and (shared/"index.js").read_text()=="prepared shared"
print("owned snapshot runtime contracts passed")
`], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.match(checked.stdout, /snapshot runtime contracts passed/);
});

test("unit CI exposes checked PostgreSQL 16 tools before disposable migration tests", async () => {
  const workflow = await parseWorkflow("ci.yml");
  const stepName = "Prepare PostgreSQL tools for disposable unit fixtures";
  function requireSetup(job) {
    const setup = job.steps.findIndex(step => step.name === stepName);
    const generate = job.steps.findIndex(step => step.run === "pnpm --filter @led-control/api prisma:generate");
    const unit = job.steps.findIndex(step => step.run === "pnpm test");
    assert.ok(setup > generate && unit > setup && generate >= 0, "PostgreSQL tools must be prepared after Prisma generation and before unit tests");
    assertCannotBeSkipped(job.steps[setup], "unit PostgreSQL tools setup");
    return job.steps[setup].run;
  }
  const command = requireSetup(workflow.jobs.unit);
  const missingSetup = structuredClone(workflow.jobs.unit);
  missingSetup.steps = missingSetup.steps.filter(step => step.name !== stepName);
  assert.throws(() => requireSetup(missingSetup), /must be prepared/);
  const lateSetup = structuredClone(workflow.jobs.unit);
  lateSetup.steps.push(lateSetup.steps.splice(lateSetup.steps.findIndex(step => step.name === stepName), 1)[0]);
  assert.throws(() => requireSetup(lateSetup), /must be prepared/);
  for (const flag of ["if", "continue-on-error"]) {
    const skipped = structuredClone(workflow.jobs.unit);
    skipped.steps.find(step => step.name === stepName)[flag] = true;
    assert.throws(() => requireSetup(skipped), /must not declare/);
  }

  const directory = await mkdtemp(path.join(tmpdir(), "unit-pg-tools-"));
  const lookup = path.join(directory, "lookup");
  const bindir = path.join(directory, "postgres-bin");
  const githubPath = path.join(directory, "github-path");
  try {
    await mkdir(lookup);
    await mkdir(bindir);
    // Only version probes are modeled; this fixture cannot start a DB or read ambient credentials.
    await writeFile(path.join(lookup, "pg_config"), '#!/bin/bash\ncase "$1" in --bindir) printf "%s\\n" "$TEST_PG_BINDIR";; --version) printf "%s\\n" "$TEST_PG_VERSION";; *) exit 1;; esac\n', { mode: 0o755 });
    for (const tool of ["initdb", "pg_ctl", "psql", "postgres"]) {
      await writeFile(path.join(bindir, tool), `#!/bin/bash\n[ "$1" = --version ] || exit 1\nprintf '%s\\n' '${tool} (PostgreSQL) 16.15'\n`, { mode: 0o755 });
    }
    function run(version = "PostgreSQL 16.15") {
      return spawnSync("/bin/bash", ["-e", "-o", "pipefail", "-c", command], {
        encoding: "utf8", env: { PATH: lookup + ":/usr/bin:/bin", TEST_PG_BINDIR: bindir, TEST_PG_VERSION: version, GITHUB_PATH: githubPath }
      });
    }
    const ready = run();
    assert.equal(ready.status, 0, ready.stdout + ready.stderr);
    assert.equal(await readFile(githubPath, "utf8"), bindir + "\n");
    for (const tool of ["initdb", "pg_ctl", "psql", "postgres"]) assert.match(ready.stdout, new RegExp(`${tool} \\(PostgreSQL\\) 16\\.15`));
    assert.match(ready.stdout, /PostgreSQL 16\.15/);
    await rm(githubPath);
    const wrongVersion = run("PostgreSQL 17.7");
    assert.notEqual(wrongVersion.status, 0, "a different major must not silently replace the PostgreSQL 16 test environment");
    await assert.rejects(readFile(githubPath), { code: "ENOENT" });
    await rm(path.join(bindir, "initdb"));
    const unavailable = run();
    assert.notEqual(unavailable.status, 0, "missing server tools must fail before exporting PATH");
    await assert.rejects(readFile(githubPath), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cold-checkout and protected-gate mutations are rejected", async () => {
  const workflow = await parseWorkflow("ci.yml");
  const coldCheckout = structuredClone(workflow.jobs.unit);
  coldCheckout.steps = coldCheckout.steps.filter((step) => step.run !== "pnpm --filter @led-control/api prisma:generate");
  assert.throws(() => assertSoftwareJobSetup(coldCheckout, "cold unit"), /Prisma Client generation/);

  const skippedAudit = structuredClone(workflow.jobs["production-audit"]);
  skippedAudit.if = false;
  assert.throws(() => assertCannotBeSkipped(skippedAudit, "production-audit job"), /must not declare if/);

  const hilWorkflow = await parseWorkflow("hil.yml");
  const continuedHilPreflight = structuredClone(findRunStep(hilWorkflow.jobs["led-hil"], "pnpm ci:hil:preflight"));
  continuedHilPreflight["continue-on-error"] = true;
  assert.throws(() => assertCannotBeSkipped(continuedHilPreflight, "HIL preflight step"), /continue-on-error/);
});

test("integration CI uses healthy PostgreSQL 16 and Redis 7 with explicit isolated gates", async () => {
  const workflow = await parseWorkflow("ci.yml");
  const job = workflow.jobs["postgres-redis-integration"];
  assert.equal(job.services.postgres.image, "postgres:16-alpine");
  assert.match(job.services.postgres.options, /pg_isready/);
  assert.equal(job.services.redis.image, "redis:7-alpine");
  assert.match(job.services.redis.options, /redis-cli ping/);
  assert.match(job.env.DATABASE_URL, /\/led_control\?schema=public$/);
  assert.match(job.env.PKI_CONCURRENCY_TEST_DATABASE_URL, /\/pki_concurrency\?schema=public$/);
  assert.notEqual(job.env.DATABASE_URL, job.env.PKI_CONCURRENCY_TEST_DATABASE_URL);
  assert.equal(job.env.RUN_REDIS_INTEGRATION, "true");
  assert.notEqual(job.env.REDIS_URL, job.env.FIXTURE_IDENTIFY_TEST_REDIS_URL);
  assertStepRuns(job, "CREATE DATABASE pki_concurrency");
  assertStepRuns(job, "pnpm ci:integration");

  const script = await readFile(path.join(root, "scripts/ci-integration.sh"), "utf8");
  assert.equal(script.match(/prisma migrate deploy/g)?.length, 2, "both disposable PostgreSQL databases must migrate");
  assert.match(script, /--runInBand/);
  for (const suite of integrationSuites) assert.match(script, new RegExp(escapeRegExp(suite)));

  const missingEnvironment = spawnSync("bash", [path.join(root, "scripts/ci-integration.sh")], {
    cwd: root,
    env: { PATH: process.env.PATH },
    encoding: "utf8"
  });
  assert.equal(missingEnvironment.status, 1);
  assert.match(missingEnvironment.stderr, /DATABASE_URL is required/);
});

test("real-backend core installs host services and runs one Chromium worker", async () => {
  const workflow = await parseWorkflow("ci.yml");
  const job = workflow.jobs["playwright-real-core"];
  const commands = stepCommands(job);
  for (const dependency of ["postgresql-16", "postgresql-client-16", "redis-server", "redis-tools", "mosquitto", "mosquitto-clients", "openssl", "lsof", "procps"]) {
    assert.match(commands, new RegExp(`\\b${escapeRegExp(dependency)}\\b`));
  }
  assert.match(commands, /pg_config --bindir/);
  assert.match(commands, /playwright install --with-deps chromium/);
  assert.equal(job.env.E2E_REAL_BACKEND_LAB, "1");
  assertStepRuns(job, "DEV_MQTT_ACL_INTEGRATION=1 node --test scripts/dev-mqtt-acl.integration.test.mjs");
  assertStepRuns(job, "pnpm ci:real-backend");

  const script = await readFile(path.join(root, "scripts/ci-real-backend-e2e.sh"), "utf8");
  assert.match(script, /installation-customer-journey\.spec\.ts/);
  assert.match(script, /--project=chromium/);
  assert.match(script, /--workers=1/);

  const missingOptIn = spawnSync("bash", [path.join(root, "scripts/ci-real-backend-e2e.sh")], {
    cwd: root,
    env: { PATH: process.env.PATH },
    encoding: "utf8"
  });
  assert.equal(missingOptIn.status, 1);
  assert.match(missingOptIn.stderr, /E2E_REAL_BACKEND_LAB must equal 1/);
});

test("production UI cascade runs after browser installation, outside browserless unit CI", async () => {
  const workflow = await parseWorkflow("ci.yml");
  const job = workflow.jobs["playwright-real-core"];
  const command = "pnpm --filter @led-control/web e2e:ui-cascade";
  const install = job.steps.findIndex(step => step.run?.includes("playwright install --with-deps chromium"));
  const cascade = job.steps.findIndex(step => step.run === command);
  assert.ok(cascade > install && install >= 0, "production cascade must run after Chromium installation");
  assertCannotBeSkipped(job.steps[cascade], "production UI cascade step");
  assert.ok(!stepCommands(workflow.jobs.unit).includes("e2e:ui-cascade"), "unit CI has no browser installation");

  // Exercise package/config discovery without launching a browser. Deleting
  // the suite or breaking its separate invocation must fail the unit gate.
  const discovered = spawnSync("pnpm", ["--filter", "@led-control/web", "e2e:ui-cascade", "--list"], {
    cwd: root, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(root, ".missing-ui-cascade-browser") }
  });
  assert.equal(discovered.status, 0, discovered.stdout + discovered.stderr);
  assert.match(discovered.stdout, /Total: 37 tests in 4 files/);
  assert.match(discovered.stdout, /ui-cascade\.spec\.ts/);
  assert.match(discovered.stdout, /ui-fields\.spec\.ts/);
  assert.match(discovered.stdout, /ui-dates\.spec\.ts/);
  assert.match(discovered.stdout, /ui-overlays\.spec\.ts/);
});

test("date bundle gate runs serially after unit tests and cannot be skipped", async () => {
  const workflow = await parseWorkflow("ci.yml");
  function assertDateBundleGate(job) {
    const unit = job.steps.findIndex(step => step.run === "pnpm test");
    const bundle = job.steps.findIndex(step => step.run === "pnpm --filter @led-control/web test:date-bundle");
    assert.ok(unit >= 0 && bundle > unit, "date bundle gate must run after ordinary unit tests");
    assertCannotBeSkipped(job, "unit job");
    assertCannotBeSkipped(job.steps[bundle], "date bundle gate");
  }
  assertDateBundleGate(workflow.jobs.unit);
  const missing = structuredClone(workflow.jobs.unit);
  missing.steps = missing.steps.filter(step => !step.run?.includes("test:date-bundle"));
  assert.throws(() => assertDateBundleGate(missing), /must run after ordinary unit tests/);
  for (const flag of ["if", "continue-on-error"]) {
    const skipped = structuredClone(workflow.jobs.unit);
    skipped.steps.find(step => step.run?.includes("test:date-bundle"))[flag] = true;
    assert.throws(() => assertDateBundleGate(skipped), /must not declare/);
  }
  const webPackage = JSON.parse(await readFile(path.join(root, "apps/web/package.json"), "utf8"));
  assert.equal(webPackage.scripts["test:date-bundle"], "node --test scripts/date-bundle.mjs");
  const syntax = spawnSync(process.execPath, ["--check", path.join(root, "apps/web/scripts/date-bundle.mjs")], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stdout + syntax.stderr);
});

test("overlay bundle gate runs serially after unit tests and cannot be skipped", async () => {
  const workflow = await parseWorkflow("ci.yml");
  function assertOverlayBundleGate(job) {
    const unit = job.steps.findIndex(step => step.run === "pnpm test");
    const date = job.steps.findIndex(step => step.run === "pnpm --filter @led-control/web test:date-bundle");
    const bundle = job.steps.findIndex(step => step.run === "pnpm --filter @led-control/web test:overlay-bundle");
    assert.ok(unit >= 0 && date > unit && bundle > date, "overlay bundle gate must run serially after unit and date gates");
    assertCannotBeSkipped(job, "unit job");
    assertCannotBeSkipped(job.steps[bundle], "overlay bundle gate");
  }
  assertOverlayBundleGate(workflow.jobs.unit);
  const missing = structuredClone(workflow.jobs.unit);
  missing.steps = missing.steps.filter(step => !step.run?.includes("test:overlay-bundle"));
  assert.throws(() => assertOverlayBundleGate(missing), /must run serially/);
  for (const flag of ["if", "continue-on-error"]) {
    const skipped = structuredClone(workflow.jobs.unit);
    skipped.steps.find(step => step.run?.includes("test:overlay-bundle"))[flag] = true;
    assert.throws(() => assertOverlayBundleGate(skipped), /must not declare/);
  }
  const webPackage = JSON.parse(await readFile(path.join(root, "apps/web/package.json"), "utf8"));
  assert.equal(webPackage.scripts["test:overlay-bundle"], "node --test scripts/overlay-bundle.mjs");
  const syntax = spawnSync(process.execPath, ["--check", path.join(root, "apps/web/scripts/overlay-bundle.mjs")], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stdout + syntax.stderr);
});

test("production audit cannot skip Docker, MQTT persistence, container, bundle, or dependency policy", async () => {
  const script = await readFile(path.join(root, "scripts/ci-production-audit.sh"), "utf8");
  for (const contract of [
    "docker version",
    "docker compose version",
    "pnpm production:contract",
    "tests/mqtt-production-config.node.mjs",
    "test:contracts",
    "MQTT_INTEGRATION_REQUIRED=1",
    "test:bundle-audit",
    "pnpm production:smoke",
    "pnpm audit:production"
  ]) assert.match(script, new RegExp(escapeRegExp(contract)));
});

test("production smoke fails closed unless the live API and CAD cgroups are exactly 1408 MiB", async () => {
  const script = await readFile(path.join(root, "scripts/production-compose-smoke.sh"), "utf8");
  assert.match(script, /apiContainer\.HostConfig\.Memory\s*,\s*1476395008/);
  assert.match(script, /cat ['"]?\/sys\/fs\/cgroup\/memory\.max/);
  assert.match(script, /assert\.equal\([^\n]*cgroup[^\n]*['"]1476395008['"]/i);
});

test("production audit protects one canonical Gateway release artifact and restore drill gate", async () => {
  const workflow = await parseWorkflow("ci.yml");
  const script = await readFile(path.join(root, "scripts/ci-production-audit.sh"), "utf8");
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assertReleaseGate(workflow, script, pkg);
  for (const mutation of ["if", "continue-on-error"]) {
    const altered = structuredClone(workflow);
    findRunStep(altered.jobs["production-audit"], "pnpm ci:production-audit")[mutation] = true;
    assert.throws(() => assertReleaseGate(altered, script, pkg), /must not declare/);
  }
  assert.throws(() => assertReleaseGate(workflow, script.replace("pnpm gateway:release:ci", "true"), pkg), /exactly once/);
  assert.throws(() => assertReleaseGate(workflow, script + "\npnpm gateway:release:ci\n", pkg), /exactly once/);
  for (const timeout of [undefined, 0, 360, "${{ inputs.timeout }}"]) {
    const altered = structuredClone(workflow);
    altered.jobs["production-audit"]["timeout-minutes"] = timeout;
    assert.throws(() => assertReleaseGate(altered, script, pkg), /bounded production audit timeout/);
  }
});

test("HIL is manual, protected, serialized, exact-confirmation, and fail-closed before execution", async () => {
  const workflow = await parseWorkflow("hil.yml");
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.equal(workflow.on.workflow_dispatch.inputs.confirmation.required, true);
  const job = workflow.jobs["led-hil"];
  assert.deepEqual(job["runs-on"], ["self-hosted", "led-hil"]);
  assert.equal(job.environment, "hil");
  assert.equal(workflow.concurrency.group, "led-hil");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assertSoftwareJobSetup(job, "led-hil", { generatePrisma: false });
  for (const variable of hilCommandVariables) assert.ok(job.env[variable], `${variable} must be injected`);

  const commands = stepCommands(job);
  const confirmationIndex = commands.indexOf("pnpm ci:hil:preflight");
  const pkiIndex = commands.indexOf("pnpm gateway:pki:hil");
  const deviceIndex = commands.indexOf("pnpm gateway:hil:2node -- --repeat 3");
  assert.ok(confirmationIndex >= 0 && confirmationIndex < pkiIndex && pkiIndex < deviceIndex);
  assert.doesNotMatch(commands, /continue-on-error/);
  assertCannotBeSkipped(job, "led-hil job");
  assertCannotBeSkipped(findRunStep(job, "pnpm ci:hil:preflight"), "HIL preflight step");

  const wrongConfirmation = spawnSync(process.execPath, [path.join(root, "scripts/ci-hil-preflight.mjs")], {
    cwd: root,
    env: { HIL_CONFIRMATION: "not-authorized" },
    encoding: "utf8"
  });
  assert.equal(wrongConfirmation.status, 1);
  assert.match(wrongConfirmation.stderr, /HIL_CONFIRMATION must exactly equal RUN_LED_HIL/);

  const missingHardwareConfiguration = spawnSync(process.execPath, [path.join(root, "scripts/ci-hil-preflight.mjs")], {
    cwd: root,
    env: { HIL_CONFIRMATION: "RUN_LED_HIL" },
    encoding: "utf8"
  });
  assert.equal(missingHardwareConfiguration.status, 1);
  assert.match(missingHardwareConfiguration.stderr, /HIL_GATEWAY_SERIAL is required/);
});

test("both HIL harnesses use the shared Gateway execution directory contract", async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["ci:hil:preflight"], "node scripts/run-gateway-hil.mjs preflight");
  assert.equal(packageJson.scripts["gateway:pki:hil"], "node scripts/run-gateway-hil.mjs pki");
  assert.equal(packageJson.scripts["gateway:hil:2node"], "node scripts/run-gateway-hil.mjs two-node");

  const launcher = await import("./run-gateway-hil.mjs");
  for (const mode of ["preflight", "pki", "two-node"]) {
    const invocation = launcher.createGatewayHilInvocation(mode, []);
    assert.equal(invocation.cwd, path.join(root, "apps/gateway"));
  }
  assert.deepEqual(launcher.createGatewayHilInvocation("preflight", []).args, [
    "exec",
    "node",
    "../../scripts/ci-hil-preflight.mjs"
  ]);
});

async function parseWorkflow(name) {
  const source = await readFile(path.join(root, ".github/workflows", name), "utf8");
  const parsed = yaml.load(source);
  assert.ok(parsed && typeof parsed === "object" && parsed.jobs, `${name} must parse as a workflow`);
  return parsed;
}

function assertReleaseGate(workflow, script, pkg) {
  const job = workflow.jobs["production-audit"];
  assert.equal(job["timeout-minutes"], 60, "bounded production audit timeout must be 60 minutes");
  assertCannotBeSkipped(job, "production-audit job");
  const step = findRunStep(job, "pnpm ci:production-audit");
  assert.equal(step.name, "Gateway release artifact and restore drill / production audit");
  assertCannotBeSkipped(step, "Gateway release gate");
  const buildx = job.steps.find((item) => item.uses === "docker/setup-buildx-action@v3");
  assert.ok(buildx, "Buildx must be explicitly installed");
  assertCannotBeSkipped(buildx, "Buildx setup");
  assert.ok(job.steps.indexOf(buildx) < job.steps.indexOf(step));
  assert.equal(pkg.scripts["gateway:release:ci"], "node scripts/gateway-release-ci.mjs");
  assert.equal(script.match(/^pnpm gateway:release:ci$/gm)?.length, 1, "canonical gate must run exactly once, unconditionally");
  assert.ok(script.indexOf("pnpm gateway:release:ci") < script.indexOf("test:bundle-audit"));
  assert.equal(stepCommands(job).match(/pnpm gateway:release:ci/g)?.length ?? 0, 0, "workflow must not run the nested gate twice");
}

function assertSoftwareJobSetup(job, name, { generatePrisma = true } = {}) {
  assert.equal(job["runs-on"] === "ubuntu-latest" || Array.isArray(job["runs-on"]), true, `${name} runner`);
  assert.ok(job.steps.some((step) => step.uses === "actions/checkout@v4"), `${name} checkout`);
  const pnpm = job.steps.find((step) => step.uses === "pnpm/action-setup@v4");
  assert.equal(String(pnpm?.with?.version), "9.15.0", `${name} pnpm`);
  const node = job.steps.find((step) => step.uses === "actions/setup-node@v4");
  assert.equal(String(node?.with?.["node-version"]), "22", `${name} node`);
  const installIndex = job.steps.findIndex((step) => step.run === "pnpm install --frozen-lockfile");
  assert.ok(installIndex >= 0, `${name} frozen install`);
  assertCannotBeSkipped(job.steps[installIndex], `${name} frozen install step`);
  if (!generatePrisma) return;
  const prismaStep = job.steps[installIndex + 1];
  assert.equal(
    prismaStep?.run,
    "pnpm --filter @led-control/api prisma:generate",
    `${name} Prisma Client generation must immediately follow the frozen install`
  );
  assertCannotBeSkipped(prismaStep, `${name} Prisma Client generation step`);
}

function assertCannotBeSkipped(entity, name) {
  assert.equal(Object.hasOwn(entity, "if"), false, `${name} must not declare if`);
  assert.equal(Object.hasOwn(entity, "continue-on-error"), false, `${name} must not declare continue-on-error`);
}

function findRunStep(job, command) {
  const step = job.steps.find((candidate) => candidate.run === command);
  assert.ok(step, `${command} step must exist`);
  return step;
}

function assertStepRuns(job, fragment) {
  assert.match(stepCommands(job), new RegExp(escapeRegExp(fragment)));
}

function stepCommands(job) {
  return job.steps.map((step) => step.run ?? "").join("\n");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
