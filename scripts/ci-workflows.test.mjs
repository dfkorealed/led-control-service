import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
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

test("production smoke fails closed unless the live API cgroup is exactly 768 MiB", async () => {
  const script = await readFile(path.join(root, "scripts/production-compose-smoke.sh"), "utf8");
  assert.match(script, /apiContainer\.HostConfig\.Memory\s*,\s*805306368/);
  assert.match(script, /cat ['"]?\/sys\/fs\/cgroup\/memory\.max/);
  assert.match(script, /assert\.equal\([^\n]*cgroup[^\n]*['"]805306368['"]/i);
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
