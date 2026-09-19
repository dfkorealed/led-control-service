import { CAD_IMPORT_PHASE_FAILURE_CODES, classifyCadImportFailure, safeCadImportDiagnosticFields } from "./cad-import-diagnostics";

describe("CAD import diagnostics", () => {
  it.each([
    ["CAD core child process wall time limit exceeded", "CAD_CORE_TIMEOUT"],
    ["CAD core child process returned an invalid response", "CAD_CORE_INVALID_RESPONSE"],
    ["CAD core child process returned an invalid bounded manifest", "CAD_CORE_INVALID_MANIFEST"],
    ["CAD core child process failed: CAD_CORE_FAILED", "CAD_CORE_FAILED"],
    ["CAD core child process failed (SIGABRT)", "CAD_CORE_FAILED"],
    ["CAD core child process failed (SIGKILL)", "CAD_CORE_FAILED"],
    ["CAD core child process failed (1)", "CAD_CORE_FAILED"],
    ["CAD core child process failed (unknown)", "CAD_CORE_FAILED"],
    ["CAD import region count is outside the API contract", "CAD_REGION_LIMIT"],
    ["CAD import temporary disk budget exceeded", "CAD_TEMP_STORAGE_LIMIT"],
    ["CAD_IMPORT_LEASE_LOST", "CAD_IMPORT_LEASE_LOST"]
  ])("classifies the application-owned failure %s", (message, expected) => {
    expect(classifyCadImportFailure(new Error(message), "parse")).toBe(expected);
  });

  it("falls back to the phase without propagating untrusted child or SDK diagnostics", () => {
    for (const phase of Object.keys(CAD_IMPORT_PHASE_FAILURE_CODES) as Array<keyof typeof CAD_IMPORT_PHASE_FAILURE_CODES>) {
      for (const error of [new Error("CAD core child process failed: /private/drawing password=secret"),
        new Error("CAD core child process failed (SIGKILL) password=secret"),
        { code: "CAD_CORE_TIMEOUT secret" }, "CAD text secret"]) {
        expect(classifyCadImportFailure(error, phase)).toBe(CAD_IMPORT_PHASE_FAILURE_CODES[phase]);
      }
    }
  });

  it("drops malformed diagnostic context even when the category is valid", () => {
    expect(safeCadImportDiagnosticFields({ diagnosticCode: "CAD_REGION_LIMIT", phase: "constructor",
      jobId: "secret", attemptCount: 999, error: new Error("secret") })).toEqual({ diagnosticCode: "CAD_REGION_LIMIT" });
  });
});
