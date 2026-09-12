#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultProjectRoot = fileURLToPath(new URL("..", import.meta.url));

export function normalizeAuditReport(report) {
  const vulnerabilities = report.metadata?.vulnerabilities ?? {};
  return {
    counts: {
      critical: vulnerabilities.critical ?? 0,
      high: vulnerabilities.high ?? 0,
      moderate: vulnerabilities.moderate ?? 0,
      low: vulnerabilities.low ?? 0,
      info: vulnerabilities.info ?? 0,
      dependencies: report.metadata?.dependencies ?? report.metadata?.totalDependencies ?? 0
    },
    advisories: Object.values(report.advisories ?? {})
      .map((advisory) => ({
        id: advisory.github_advisory_id,
        package: advisory.module_name,
        severity: advisory.severity,
        currentVersions: [...new Set(advisory.findings.flatMap((finding) => finding.version))].sort(),
        vulnerableVersions: advisory.vulnerable_versions,
        patchedFloor: advisory.patched_versions,
        title: advisory.title,
        paths: [...new Set(advisory.findings.flatMap((finding) => finding.paths))].sort(),
        runtimeReachability: "unassessed"
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  };
}

const gatedSeverities = new Set(["moderate", "high", "critical"]);

const auditExceptions = {
  "GHSA-w5hq-g745-h8pq": {
    package: "uuid",
    severity: "moderate",
    versions: ["8.3.2"],
    patchedFloor: ">=11.1.1",
    paths: ["apps/api > exceljs@4.4.0 > uuid@8.3.2"],
    runtimeReachability: "ExcelJS imports uuid.v4 only; the advisory affects the v3/v5/v6 caller-provided buffer API",
    mitigation: "XLSX render/load regression covers the only production consumer",
    removal: "Remove when ExcelJS supports uuid >=11.1.1 or a tested supported replacement is adopted"
  },
  "GHSA-w3rx-r6r6-pgpr": imageSizeException(),
  "GHSA-5p2g-fcmc-qvqq": imageSizeException()
};

function imageSizeException() {
  return {
    package: "image-size",
    severity: "high",
    versions: ["1.2.1"],
    patchedFloor: "<0.0.0",
    paths: [
      "apps/mobile > react-native-webview@13.17.0 > react-native@0.76.5 > @react-native/community-cli-plugin@0.76.5 > metro@0.81.5 > image-size@1.2.1",
      "apps/mobile > react-native@0.76.5 > @react-native/community-cli-plugin@0.76.5 > metro@0.81.5 > image-size@1.2.1"
    ],
    runtimeReachability: "Metro build-time inspection of repository assets only; not shipped in the mobile runtime",
    mitigation: "ICNS, JXL and HEIF signatures fail closed before parser dispatch",
    removal: "Remove the patch and exceptions when upstream publishes a non-vulnerable release",
    patchedDependency: ["image-size@1.2.1", "patches/image-size@1.2.1.patch"],
    requiredArtifacts: [
      ["patches/image-size@1.2.1.patch", "9b6f61e6da7d91f29322ae809e8640276214dcc836283bb38f821ed6bd9ca6b0"],
      ["scripts/image-size-security.test.mjs"]
    ]
  };
}

function exceptionMatches(advisory, exception) {
  return advisory.package === exception.package &&
    advisory.severity === exception.severity &&
    advisory.patchedFloor === exception.patchedFloor &&
    advisory.currentVersions.length === exception.versions.length &&
    advisory.currentVersions.every((version, index) => version === exception.versions[index]) &&
    advisory.paths.length === exception.paths.length &&
    advisory.paths.every((dependencyPath, index) => dependencyPath === exception.paths[index]);
}

function manifestHasPatchedDependency(projectRoot, dependency, relativePath) {
  const manifestPath = path.join(projectRoot, "package.json");
  if (!existsSync(manifestPath)) return false;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  return manifest.pnpm?.patchedDependencies?.[dependency] === relativePath;
}

function missingMitigation(exception, projectRoot) {
  const missing = [];
  for (const [relativePath, expectedSha256] of exception.requiredArtifacts ?? []) {
    const artifactPath = path.join(projectRoot, relativePath);
    if (!existsSync(artifactPath)) {
      missing.push(relativePath);
      continue;
    }
    if (expectedSha256) {
      const actual = createHash("sha256").update(readFileSync(artifactPath)).digest("hex");
      if (actual !== expectedSha256) missing.push(`${relativePath}#sha256`);
    }
  }
  if (exception.patchedDependency) {
    const [dependency, relativePath] = exception.patchedDependency;
    if (!manifestHasPatchedDependency(projectRoot, dependency, relativePath)) {
      missing.push(`package.json#${dependency}`);
    }
  }
  return missing;
}

export function evaluateAuditReport(normalized, projectRoot = defaultProjectRoot) {
  const unexpected = [];
  const exceptions = [];
  for (const advisory of normalized.advisories.filter((item) => gatedSeverities.has(item.severity))) {
    const exception = auditExceptions[advisory.id];
    const mitigationMissing = exception ? missingMitigation(exception, projectRoot) : [];
    if (!exception || !exceptionMatches(advisory, exception) || mitigationMissing.length > 0) {
      unexpected.push({ ...advisory, mitigationMissing });
      continue;
    }
    exceptions.push({ ...advisory, ...exception });
  }
  return {
    unexpected,
    exceptions
  };
}

function printEvaluation(normalized, evaluation) {
  process.stdout.write(
    `Production audit: critical=${normalized.counts.critical} high=${normalized.counts.high} ` +
      `moderate=${normalized.counts.moderate} low=${normalized.counts.low} dependencies=${normalized.counts.dependencies}\n`
  );
  for (const advisory of evaluation.unexpected) {
    process.stdout.write(
      `UNEXPECTED ${advisory.id} ${advisory.package}@${advisory.currentVersions.join(",")} ${advisory.severity} ` +
        `patched=${advisory.patchedFloor} runtime=${advisory.runtimeReachability}\n`
    );
    process.stdout.write(`  path: ${advisory.paths[0]}\n`);
    if (advisory.paths.length > 1) process.stdout.write(`  additional-paths: ${advisory.paths.length - 1}\n`);
    for (const missing of advisory.mitigationMissing ?? []) process.stdout.write(`  mitigation-missing=${missing}\n`);
  }
  for (const advisory of evaluation.exceptions) {
    process.stdout.write(
      `EXCEPTION ${advisory.id} ${advisory.package}@${advisory.currentVersions.join(",")} ${advisory.severity} ` +
        `patched=${advisory.patchedFloor}\n` +
        `  path: ${advisory.paths[0]}\n` +
        `  runtime=${advisory.runtimeReachability}\n` +
        `  mitigation=${advisory.mitigation}\n` +
        `  removal=${advisory.removal}\n`
    );
  }
}

function parseArguments(argv) {
  const inputIndex = argv.indexOf("--input");
  if (inputIndex === -1 || !argv[inputIndex + 1]) {
    throw new Error("usage: production-audit-policy.mjs [--normalize-only] --input <audit.json>");
  }
  const projectRootIndex = argv.indexOf("--project-root");
  return {
    inputPath: argv[inputIndex + 1],
    normalizeOnly: argv.includes("--normalize-only"),
    projectRoot: projectRootIndex === -1 ? defaultProjectRoot : argv[projectRootIndex + 1]
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { inputPath, normalizeOnly, projectRoot } = parseArguments(process.argv.slice(2));
    const report = JSON.parse(readFileSync(inputPath === "-" ? 0 : inputPath, "utf8"));
    const normalized = normalizeAuditReport(report);
    if (normalizeOnly) {
      process.stdout.write(`${JSON.stringify(normalized, null, 2)}\n`);
    } else {
      const evaluation = evaluateAuditReport(normalized, projectRoot);
      printEvaluation(normalized, evaluation);
      if (evaluation.unexpected.length > 0) process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
