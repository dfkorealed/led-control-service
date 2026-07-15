import { describe, expect, it, vi } from "vitest";
import { PKI_HIL_STEPS, redactSecrets, runPkiHil } from "./pki-hil-test";

describe("PKI HIL contract", () => {
  it("runs every production PKI gate in order and redacts secrets", async () => {
    const execute = vi.fn(async (step: (typeof PKI_HIL_STEPS)[number]) => ({ passed: true, evidence: evidenceFor(step) }));
    const result = await runPkiHil(execute);
    expect(result.passed).toBe(true);
    expect(result.steps.map((step) => step.name)).toEqual(PKI_HIL_STEPS);
    expect(result.steps[0].evidence).toMatchObject({ token: "[REDACTED]", privateKeyExported: "[REDACTED]" });
  });

  it("fails when rotation loses a command or two gateways share a fingerprint", async () => {
    const result = await runPkiHil(async (step) => ({
      passed: true,
      evidence: step === "mqtt-rotation" ? { lostCommands: 1, duplicateCommands: 0 } :
        step === "two-gateway-fingerprint" ? { fingerprints: ["AA", "AA"] } : evidenceFor(step)
    }));
    expect(result.passed).toBe(false);
    expect(result.steps.filter((step) => !step.passed).map((step) => step.name)).toEqual([
      "mqtt-rotation", "two-gateway-fingerprint"
    ]);
  });

  it("redacts nested secret fields and error values", async () => {
    expect(redactSecrets({ nested: { claimCode: "x" } })).toEqual({ nested: { claimCode: "[REDACTED]" } });
    const result = await runPkiHil(async (step) => {
      if (step === "wrong-ca") throw new Error("token=secret-value");
      return { passed: true, evidence: evidenceFor(step) };
    });
    expect(result.steps.find((step) => step.name === "wrong-ca")?.error).toBe("token=[REDACTED]");
  });
});

function evidenceFor(step: (typeof PKI_HIL_STEPS)[number]) {
  if (step === "manufacturing") return { privateKeyExported: false, token: "secret" };
  if (["token-reuse", "csr-tamper", "serial-mismatch", "wrong-ca"].includes(step)) return { rejected: true };
  if (step === "claim-bootstrap-mqtt") return { assigned: true, mqttIssued: true };
  if (step === "restart-recovery") return { identityRecovered: true, assignmentRecovered: true };
  if (step === "mqtt-rotation") return { lostCommands: 0, duplicateCommands: 0 };
  if (step === "two-gateway-fingerprint") return { fingerprints: ["AA".repeat(32), "BB".repeat(32)] };
  if (step === "secret-scan") return { matches: 0 };
  return {};
}
