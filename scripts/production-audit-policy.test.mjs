import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function auditMetadata(vulnerabilities, dependencies = 10) {
  return {
    vulnerabilities: {
      info: 0,
      low: 0,
      moderate: 0,
      high: 0,
      critical: 0,
      ...vulnerabilities
    },
    dependencies,
    devDependencies: 0,
    optionalDependencies: 0,
    totalDependencies: dependencies
  };
}

function runLivePolicy(t, report, auditExitCode) {
  const directory = mkdtempSync(path.join(tmpdir(), "led-audit-command-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fakePnpmPath = path.join(directory, "pnpm");
  writeFileSync(
    fakePnpmPath,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(report))});\nprocess.exitCode = ${auditExitCode};\n`
  );
  chmodSync(fakePnpmPath, 0o755);
  return spawnSync(process.execPath, [scriptPath], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}` }
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
    metadata: auditMetadata({ high: 1 })
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
    metadata: auditMetadata({ moderate: 1 })
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
    metadata: auditMetadata({ high: 1 }, 20)
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

test("제거된 ExcelJS의 uuid advisory는 승인하지 않는다", (t) => {
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
    metadata: auditMetadata({ moderate: 1 }, 30)
  };

  const accepted = runPolicy(t, report);
  assert.equal(accepted.status, 1);
  assert.match(accepted.stdout, /UNEXPECTED GHSA-w5hq-g745-h8pq/);

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
    metadata: auditMetadata({ high: 2 }, 40)
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

test("pnpm audit error envelope와 누락·malformed report는 fail-closed한다", (t) => {
  const malformedReports = [
    {
      label: "error envelope",
      report: { error: { code: "ERR_PNPM_AUDIT_BAD_RESPONSE", message: "registry unreachable" } },
      expected: /audit collection error ERR_PNPM_AUDIT_BAD_RESPONSE: registry unreachable/
    },
    {
      label: "missing fields",
      report: {},
      expected: /missing advisories/
    },
    {
      label: "malformed advisory",
      report: {
        advisories: {
          "600": {
            github_advisory_id: "GHSA-malformed-abcd-0006",
            module_name: "malformed-package",
            severity: "high",
            vulnerable_versions: "<1.0.0",
            patched_versions: ">=1.0.0",
            findings: [{ version: "0.1.0", paths: [] }]
          }
        },
        metadata: auditMetadata({ high: 1 })
      },
      expected: /advisory 600 title must be a non-empty string/
    }
  ];

  for (const { label, report, expected } of malformedReports) {
    const result = runPolicy(t, report);
    assert.equal(result.status, 1, `${label}: ${result.stdout}`);
    assert.match(result.stderr, expected, label);
  }
});

test("metadata severity count와 advisory 목록이 다르면 fail-closed한다", (t) => {
  const result = runPolicy(t, {
    advisories: {},
    metadata: auditMetadata({ high: 1 })
  });

  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /high count mismatch: metadata=1 advisories=0/);
});

test("실제 audit command의 error envelope는 실패하고 vulnerability exit 1의 패치 승인 예외 report는 통과한다", (t) => {
  const failedCollection = runLivePolicy(
    t,
    { error: { code: "ERR_PNPM_AUDIT_BAD_RESPONSE", message: "registry unreachable" } },
    1
  );
  assert.equal(failedCollection.status, 1, failedCollection.stdout);
  assert.match(failedCollection.stderr, /audit collection error ERR_PNPM_AUDIT_BAD_RESPONSE: registry unreachable/);

  const allowedAdvisory = {
    advisories: {
      "700": {
        github_advisory_id: "GHSA-w3rx-r6r6-pgpr",
        module_name: "image-size",
        severity: "high",
        title: "ICNS parser infinite loop",
        vulnerable_versions: "<=2.0.2",
        patched_versions: "<0.0.0",
        findings: [{ version: "1.2.1", paths: [
          "apps/mobile > react-native-webview@13.17.0 > react-native@0.76.5 > @react-native/community-cli-plugin@0.76.5 > metro@0.81.5 > image-size@1.2.1",
          "apps/mobile > react-native@0.76.5 > @react-native/community-cli-plugin@0.76.5 > metro@0.81.5 > image-size@1.2.1"
        ] }]
      }
    },
    metadata: auditMetadata({ high: 1 }, 30)
  };
  const acceptedVulnerabilityReport = runLivePolicy(t, allowedAdvisory, 1);
  assert.equal(acceptedVulnerabilityReport.status, 0, acceptedVulnerabilityReport.stderr);
  assert.match(acceptedVulnerabilityReport.stdout, /EXCEPTION GHSA-w3rx-r6r6-pgpr image-size@1\.2\.1 high/);
});

test("공백과 한글 checkout path에서도 main guard가 unknown High를 실행해 실패한다", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "보안 audit checkout "));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const copiedScriptPath = path.join(directory, "production audit 정책.mjs");
  copyFileSync(scriptPath, copiedScriptPath);
  const inputPath = path.join(directory, "unknown-high.json");
  writeFileSync(inputPath, JSON.stringify({
    advisories: {
      "800": {
        github_advisory_id: "GHSA-space-abcd-0008",
        module_name: "space-path-package",
        severity: "high",
        title: "space path vulnerability",
        vulnerable_versions: "<1.0.0",
        patched_versions: ">=1.0.0",
        findings: [{ version: "0.1.0", paths: ["apps/api > space-path-package@0.1.0"] }]
      }
    },
    metadata: auditMetadata({ high: 1 })
  }));

  const result = spawnSync(process.execPath, [copiedScriptPath, "--input", inputPath], { encoding: "utf8" });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /UNEXPECTED GHSA-space-abcd-0008/);
});

test("공백과 한글 checkout path에서도 main guard가 정상 report를 실행한다", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "보안 audit checkout "));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const copiedScriptPath = path.join(directory, "production audit 정책.mjs");
  copyFileSync(scriptPath, copiedScriptPath);
  const inputPath = path.join(directory, "clean.json");
  writeFileSync(inputPath, JSON.stringify({
    advisories: {},
    metadata: auditMetadata({}, 1)
  }));

  const result = spawnSync(process.execPath, [copiedScriptPath, "--input", inputPath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Production audit: critical=0 high=0 moderate=0 low=0 dependencies=1/);
});
