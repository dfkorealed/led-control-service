#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultProjectRoot = fileURLToPath(new URL("..", import.meta.url));
const severityNames = ["info", "low", "moderate", "high", "critical"];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value, label) {
  if (!isRecord(value)) throw new Error(`invalid audit report: missing ${label}`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid audit report: ${label} must be a non-empty string`);
  }
  return value;
}

function requireCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid audit report: ${label} must be a non-negative integer`);
  }
  return value;
}

export function validateAuditReport(report) {
  const root = requireRecord(report, "root object");
  if (Object.hasOwn(root, "error")) {
    const error = isRecord(root.error) ? root.error : {};
    const code = typeof error.code === "string" ? error.code : "UNKNOWN";
    const message = typeof error.message === "string" ? error.message : JSON.stringify(root.error);
    throw new Error(`audit collection error ${code}: ${message}`);
  }

  const advisories = requireRecord(root.advisories, "advisories");
  const metadata = requireRecord(root.metadata, "metadata");
  const vulnerabilities = requireRecord(metadata.vulnerabilities, "metadata.vulnerabilities");
  requireCount(metadata.dependencies, "metadata.dependencies");

  const advisoryCounts = Object.fromEntries(severityNames.map((severity) => [severity, 0]));
  for (const [key, value] of Object.entries(advisories)) {
    const advisory = requireRecord(value, `advisory ${key}`);
    requireString(advisory.github_advisory_id, `advisory ${key} github_advisory_id`);
    requireString(advisory.module_name, `advisory ${key} module_name`);
    requireString(advisory.title, `advisory ${key} title`);
    requireString(advisory.vulnerable_versions, `advisory ${key} vulnerable_versions`);
    requireString(advisory.patched_versions, `advisory ${key} patched_versions`);
    if (!severityNames.includes(advisory.severity)) {
      throw new Error(`invalid audit report: advisory ${key} severity is invalid`);
    }
    if (!Array.isArray(advisory.findings) || advisory.findings.length === 0) {
      throw new Error(`invalid audit report: advisory ${key} findings must be a non-empty array`);
    }
    for (const [findingIndex, findingValue] of advisory.findings.entries()) {
      const finding = requireRecord(findingValue, `advisory ${key} finding ${findingIndex}`);
      requireString(finding.version, `advisory ${key} finding ${findingIndex} version`);
      if (!Array.isArray(finding.paths) || finding.paths.length === 0 ||
        finding.paths.some((dependencyPath) => typeof dependencyPath !== "string" || dependencyPath.length === 0)) {
        throw new Error(`invalid audit report: advisory ${key} finding ${findingIndex} paths must be non-empty strings`);
      }
    }
    advisoryCounts[advisory.severity] += 1;
  }

  for (const severity of severityNames) {
    const metadataCount = requireCount(vulnerabilities[severity], `metadata.vulnerabilities.${severity}`);
    if (metadataCount !== advisoryCounts[severity]) {
      throw new Error(
        `invalid audit report: ${severity} count mismatch: metadata=${metadataCount} advisories=${advisoryCounts[severity]}`
      );
    }
  }
  return root;
}

export function normalizeAuditReport(report) {
  const validated = validateAuditReport(report);
  const vulnerabilities = validated.metadata.vulnerabilities;
  return {
    counts: {
      critical: vulnerabilities.critical ?? 0,
      high: vulnerabilities.high ?? 0,
      moderate: vulnerabilities.moderate ?? 0,
      low: vulnerabilities.low ?? 0,
      info: vulnerabilities.info ?? 0,
      dependencies: validated.metadata.dependencies
    },
    advisories: Object.values(validated.advisories)
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
  if (inputIndex !== -1 && !argv[inputIndex + 1]) throw new Error("--input requires an audit JSON path or -");
  const projectRootIndex = argv.indexOf("--project-root");
  return {
    inputPath: inputIndex === -1 ? undefined : argv[inputIndex + 1],
    normalizeOnly: argv.includes("--normalize-only"),
    projectRoot: projectRootIndex === -1 ? defaultProjectRoot : argv[projectRootIndex + 1]
  };
}

function readAuditReport(inputPath) {
  if (inputPath !== undefined) return JSON.parse(readFileSync(inputPath === "-" ? 0 : inputPath, "utf8"));

  const audit = spawnSync("pnpm", ["audit", "--prod", "--audit-level=moderate", "--json"], {
    cwd: defaultProjectRoot,
    encoding: "utf8"
  });
  if (audit.error) throw new Error(`pnpm audit failed to start: ${audit.error.message}`);
  if (audit.signal) throw new Error(`pnpm audit terminated by ${audit.signal}`);
  if (audit.status !== 0 && audit.status !== 1) {
    throw new Error(`pnpm audit exited ${audit.status}: ${audit.stderr.trim()}`);
  }
  const report = JSON.parse(audit.stdout);
  validateAuditReport(report);
  const totalVulnerabilities = severityNames.reduce(
    (total, severity) => total + report.metadata.vulnerabilities[severity],
    0
  );
  if (audit.status === 1 && totalVulnerabilities === 0) {
    throw new Error(`pnpm audit exited 1 without vulnerability findings: ${audit.stderr.trim()}`);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const { inputPath, normalizeOnly, projectRoot } = parseArguments(process.argv.slice(2));
    const report = readAuditReport(inputPath);
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
