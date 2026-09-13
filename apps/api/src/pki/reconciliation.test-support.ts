// Unit boundary double; durable storage, cancellation and worker behavior are
// covered by the real service and disposable PostgreSQL integration suites.
export function reconciliationFixture() {
  return {
    armSignedCertificate: jest.fn(async (metadata: any) => {
      if (!/^[0-9A-Fa-f:]{64,95}$/.test(metadata.fingerprint)) throw new Error("invalid certificate metadata");
      return "orphan-job";
    }),
    cancelSignedCertificate: jest.fn().mockResolvedValue(undefined),
    stageInventoryRevocation: jest.fn().mockResolvedValue(["revocation-job"]),
    processNow: jest.fn().mockResolvedValue(undefined)
  };
}
