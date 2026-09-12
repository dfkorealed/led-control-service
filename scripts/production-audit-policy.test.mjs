import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(projectRoot, "scripts/production-audit-policy.mjs");

function runPolicy(t, report, args = [], options = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "led-audit-policy-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const inputPath = path.join(directory, "audit.json");
  writeFileSync(inputPath, JSON.stringify(report));
  return spawnSync(process.execPath, [scriptPath, ...args, "--input", inputPath], {
    cwd: projectRoot,
    encoding: "utf8",
    ...options
  });
}

test("production audit JSON을 advisory별 package, severity, 경로와 patched floor로 정규화한다", (t) => {
  const result = runPolicy(t, {
    advisories: {
      "100": {
        github_advisory_id: "GHSA-test-abcd-0001",
        module_name: "example-package",
        severity: "high",
        title: "example denial of service",
        vulnerable_versions: "<2.0.0",
        patched_versions: ">=2.0.0",
        findings: [
          { version: "1.4.0", paths: ["apps/api > parent@1.0.0 > example-package@1.4.0"] },
          { version: "1.4.0", paths: ["apps/gateway > parent@1.0.0 > example-package@1.4.0"] }
        ]
      }
    },
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 },
      dependencies: 10,
      devDependencies: 0,
      optionalDependencies: 0,
      totalDependencies: 10
    }
  }, ["--normalize-only"]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    counts: { critical: 0, high: 1, moderate: 0, low: 0, info: 0, dependencies: 10 },
    advisories: [{
      id: "GHSA-test-abcd-0001",
      package: "example-package",
      severity: "high",
      currentVersions: ["1.4.0"],
      vulnerableVersions: "<2.0.0",
      patchedFloor: ">=2.0.0",
      title: "example denial of service",
      paths: [
        "apps/api > parent@1.0.0 > example-package@1.4.0",
        "apps/gateway > parent@1.0.0 > example-package@1.4.0"
      ],
      runtimeReachability: "unassessed"
    }]
  });
});

test("정책에 없는 Moderate 이상 advisory는 경로와 안전 버전을 출력하고 실패한다", (t) => {
  const result = runPolicy(t, {
    advisories: {
      "200": {
        github_advisory_id: "GHSA-unknown-abcd-0002",
        module_name: "unknown-package",
        severity: "moderate",
        title: "unknown vulnerability",
        vulnerable_versions: "<=1.0.0",
        patched_versions: ">=1.0.1",
        findings: [{ version: "1.0.0", paths: ["apps/api > unknown-package@1.0.0"] }]
      }
    },
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 1, high: 0, critical: 0 },
      dependencies: 10
    }
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /UNEXPECTED\s+GHSA-unknown-abcd-0002\s+unknown-package@1\.0\.0\s+moderate/);
  assert.match(result.stdout, /patched=>=1\.0\.1/);
  assert.match(result.stdout, /apps\/api > unknown-package@1\.0\.0/);
  assert.match(result.stdout, /runtime=unassessed/);
});

test("CI는 fresh audit JSON을 stdin으로 전달해 같은 fail-closed 정책을 실행한다", () => {
  const report = {
    advisories: {
      "300": {
        github_advisory_id: "GHSA-stdin-abcd-0003",
        module_name: "stdin-package",
        severity: "high",
        title: "stdin vulnerability",
        vulnerable_versions: "<3.0.0",
        patched_versions: ">=3.0.0",
        findings: [{ version: "2.0.0", paths: ["apps/web > stdin-package@2.0.0"] }]
      }
    },
    metadata: { vulnerabilities: { high: 1 }, dependencies: 20 }
  };
  const result = spawnSync(process.execPath, [scriptPath, "--input", "-"], {
    cwd: projectRoot,
    encoding: "utf8",
    input: JSON.stringify(report)
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /UNEXPECTED GHSA-stdin-abcd-0003/);
  assert.doesNotMatch(result.stderr, /ENOENT/);
});

test("승인된 exception은 exact package/version/path에만 적용하고 제거 조건까지 항상 출력한다", (t) => {
  const advisory = {
    github_advisory_id: "GHSA-w5hq-g745-h8pq",
    module_name: "uuid",
    severity: "moderate",
    title: "uuid buffer bounds",
    vulnerable_versions: "<11.1.1",
    patched_versions: ">=11.1.1",
    findings: [{ version: "8.3.2", paths: ["apps/api > exceljs@4.4.0 > uuid@8.3.2"] }]
  };
  const report = {
    advisories: { "400": advisory },
    metadata: { vulnerabilities: { moderate: 1 }, dependencies: 30 }
  };

  const accepted = runPolicy(t, report);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /EXCEPTION GHSA-w5hq-g745-h8pq uuid@8\.3\.2 moderate/);
  assert.match(accepted.stdout, /runtime=ExcelJS imports uuid\.v4 only/);
  assert.match(accepted.stdout, /removal=Remove when ExcelJS supports uuid >=11\.1\.1/);

  const changed = runPolicy(t, {
    ...report,
    advisories: {
      "400": {
        ...advisory,
        findings: [{ version: "8.3.2", paths: ["apps/api > another-package@1.0.0 > uuid@8.3.2"] }]
      }
    }
  });
  assert.equal(changed.status, 1);
  assert.match(changed.stdout, /UNEXPECTED GHSA-w5hq-g745-h8pq/);
});

test("image-size exception은 exact advisory와 repository patch/regression이 모두 있을 때만 통과한다", (t) => {
  const paths = [
    "apps/mobile > react-native-webview@13.17.0 > react-native@0.76.5 > @react-native/community-cli-plugin@0.76.5 > metro@0.81.5 > image-size@1.2.1",
    "apps/mobile > react-native@0.76.5 > @react-native/community-cli-plugin@0.76.5 > metro@0.81.5 > image-size@1.2.1"
  ];
  const advisory = (id, title) => ({
    github_advisory_id: id,
    module_name: "image-size",
    severity: "high",
    title,
    vulnerable_versions: "<=2.0.2",
    patched_versions: "<0.0.0",
    findings: [{ version: "1.2.1", paths }]
  });
  const report = {
    advisories: {
      "500": advisory("GHSA-w3rx-r6r6-pgpr", "ICNS parser infinite loop"),
      "501": advisory("GHSA-5p2g-fcmc-qvqq", "JXL and HEIF parser infinite loops")
    },
    metadata: { vulnerabilities: { high: 2 }, dependencies: 40 }
  };

  const accepted = runPolicy(t, report);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /EXCEPTION GHSA-w3rx-r6r6-pgpr image-size@1\.2\.1 high/);
  assert.match(accepted.stdout, /EXCEPTION GHSA-5p2g-fcmc-qvqq image-size@1\.2\.1 high/);
  assert.match(accepted.stdout, /mitigation=ICNS, JXL and HEIF signatures fail closed before parser dispatch/);
  assert.match(accepted.stdout, /removal=Remove the patch and exceptions when upstream publishes a non-vulnerable release/);

  const unpatchedRoot = mkdtempSync(path.join(tmpdir(), "led-audit-unpatched-"));
  t.after(() => rmSync(unpatchedRoot, { recursive: true, force: true }));
  writeFileSync(path.join(unpatchedRoot, "package.json"), JSON.stringify({ pnpm: { patchedDependencies: {} } }));
  const rejected = runPolicy(t, report, ["--project-root", unpatchedRoot]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stdout, /UNEXPECTED GHSA-w3rx-r6r6-pgpr/);
  assert.match(rejected.stdout, /mitigation-missing=patches\/image-size@1\.2\.1\.patch/);
});
