export const CAD_IMPORT_PHASE_FAILURE_CODES = {
  download: "CAD_IMPORT_SOURCE_INVALID",
  convert: "CAD_IMPORT_CONVERSION_FAILED",
  parse: "CAD_IMPORT_PARSE_FAILED",
  detect: "CAD_IMPORT_DETECTION_FAILED",
  render: "CAD_IMPORT_RENDER_FAILED",
  storage: "CAD_IMPORT_STORAGE_FAILED",
  persist: "CAD_IMPORT_PERSIST_FAILED"
} as const;

export type ImportPhase = keyof typeof CAD_IMPORT_PHASE_FAILURE_CODES;

const knownFailures = new Map([
  ["CAD core child process wall time limit exceeded", "CAD_CORE_TIMEOUT"],
  ["CAD core child process returned an invalid response", "CAD_CORE_INVALID_RESPONSE"],
  ["CAD core child response byte limit exceeded", "CAD_CORE_INVALID_RESPONSE"],
  ["CAD core child stderr byte limit exceeded", "CAD_CORE_INVALID_RESPONSE"],
  ["CAD core child process returned an invalid bounded manifest", "CAD_CORE_INVALID_MANIFEST"],
  ["CAD core child process failed: CAD_CORE_FAILED", "CAD_CORE_FAILED"],
  ["CAD core child process failed", "CAD_CORE_FAILED"],
  ["CAD core child process IPC failed", "CAD_CORE_FAILED"],
  ["CAD core child process aborted", "CAD_CORE_ABORTED"],
  ["CAD import region count is outside the API contract", "CAD_REGION_LIMIT"],
  ["CAD import stored region count exceeds the limit", "CAD_REGION_LIMIT"],
  ["CAD import temporary disk budget exceeded", "CAD_TEMP_STORAGE_LIMIT"],
  ["CAD import temporary disk budget unavailable", "CAD_TEMP_STORAGE_LIMIT"],
  ["CAD_IMPORT_LEASE_LOST", "CAD_IMPORT_LEASE_LOST"]
]);
const diagnosticCodes = new Set([...Object.values(CAD_IMPORT_PHASE_FAILURE_CODES), ...knownFailures.values()]);

export function classifyCadImportFailure(error: unknown, phase: ImportPhase): string {
  // Match only application-owned messages; never return messages, stacks or
  // arbitrary child/SDK error codes that may contain paths or uploaded CAD text.
  const message = error instanceof Error ? error.message : "";
  if (/^CAD core child process failed \((?:[0-9]{1,3}|SIG[A-Z]{2,8}|unknown)\)$/.test(message)) return "CAD_CORE_FAILED";
  return knownFailures.get(message) ?? CAD_IMPORT_PHASE_FAILURE_CODES[phase];
}

export function safeCadImportDiagnosticFields(record: Record<string, unknown> | undefined) {
  if (!record || typeof record.diagnosticCode !== "string" || !diagnosticCodes.has(record.diagnosticCode)) return {};
  return {
    diagnosticCode: record.diagnosticCode,
    ...(typeof record.phase === "string" && Object.hasOwn(CAD_IMPORT_PHASE_FAILURE_CODES, record.phase)
      ? { phase: record.phase } : {}),
    ...(typeof record.jobId === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(record.jobId)
      ? { jobId: record.jobId } : {}),
    ...(Number.isSafeInteger(record.attemptCount) && Number(record.attemptCount) >= 1 && Number(record.attemptCount) <= 3
      ? { attemptCount: record.attemptCount } : {})
  };
}
