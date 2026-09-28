import {
  BrokerGenerationFence, BrokerFenceAdapter, BrokerFenceCensus, BrokerNodeFenceObservation,
  BrokerFenceChallenge, StockMosquittoFenceAdapter
} from "./broker-generation-fence";

const fingerprint = "a".repeat(64);
const census: BrokerFenceCensus = {
  generation: 7, revision: "deployment-42", source: "deployment-inventory", complete: true,
  nodes: ["broker-a", "broker-b"].map(nodeId => ({ nodeId, bootId: `${nodeId}-boot-1`,
    retiredCertificateFingerprints: [fingerprint] }))
};

function observation(challenge: BrokerFenceChallenge, nodeId: string): BrokerNodeFenceObservation {
  return {
    nodeId, bootId: `${nodeId}-boot-1`, generation: challenge.generation, nonce: challenge.nonce,
    inventoryRevision: challenge.inventoryRevision, revokedCertificateFingerprints: [fingerprint],
    irreversibleRevocation: true, sessionInventoryComplete: true,
    activeConnections: 0, persistentSessions: 0, queuedMessages: 0,
    freshPublishDenied: true, admissionMinimumGeneration: 8,
    rollback: { restartDenied: true, oldAclDenied: true, oldCrlDenied: true, oldAclAndCrlDenied: true,
      minimumGenerationAfterRollback: 8, revocationLedgerPreserved: true }
  };
}

function fixture(options: {
  mutate?: (nodes: BrokerNodeFenceObservation[]) => void;
  inventory?: () => Promise<BrokerFenceCensus>;
  collect?: BrokerFenceAdapter["collect"];
  monotonicNow?: () => number;
} = {}) {
  const adapter: BrokerFenceAdapter = { kind: "disposable", collect: options.collect ?? (async challenge => {
    const nodes = census.nodes.map(node => observation(challenge, node.nodeId));
    options.mutate?.(nodes);
    return nodes;
  }) };
  return new BrokerGenerationFence({ adapter, census: options.inventory ?? (async () => structuredClone(census)),
    monotonicNow: options.monotonicNow ?? (() => 100), maxVerificationMs: 1000 });
}

describe("BrokerGenerationFence", () => {
  it("defaults to unavailable for stock production even with an ACL rejection or local close", async () => {
    const result = await new BrokerGenerationFence().verifyRetired(7);
    expect(result).toMatchObject({ status: "unavailable", reason: "immutable_admission_unavailable", productionPurgeAllowed: false });
    const stock = new BrokerGenerationFence({ adapter: new StockMosquittoFenceAdapter(),
      census: async () => census });
    expect(await stock.verifyRetired(7)).toMatchObject({ status: "unavailable", productionPurgeAllowed: false });
  });

  it("verifies every node but only creates disposable evidence that cannot authorize production", async () => {
    const result = await fixture().verifyRetired(7);
    expect(result).toMatchObject({ status: "verified", scope: "disposable", generation: 7,
      inventoryRevision: "deployment-42", nodeIds: ["broker-a", "broker-b"], productionPurgeAllowed: false });
    if (result.status !== "verified") throw new Error("expected evidence");
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.nodeIds)).toBe(true);
    // This literal type prevents Task 6 from accidentally accepting test proof
    // as a production grant. No adapter in this module can produce true.
    const productionPermission: false = result.productionPurgeAllowed;
    expect(productionPermission).toBe(false);
  });

  it.each([
    ["only a one-time ACL rejection", (n: BrokerNodeFenceObservation) => { delete (n as Partial<BrokerNodeFenceObservation>).rollback; }],
    ["client end callback without session census", (n: BrokerNodeFenceObservation) => { n.sessionInventoryComplete = false; }],
    ["certificate not revoked", (n: BrokerNodeFenceObservation) => { n.revokedCertificateFingerprints = []; }],
    ["rollbackable revocation", (n: BrokerNodeFenceObservation) => { n.irreversibleRevocation = false; }],
    ["active connection", (n: BrokerNodeFenceObservation) => { n.activeConnections = 1; }],
    ["old persistent session", (n: BrokerNodeFenceObservation) => { n.persistentSessions = 1; }],
    ["old queued outgoing Set", (n: BrokerNodeFenceObservation) => { n.queuedMessages = 1; }],
    ["fresh old-generation publish accepted", (n: BrokerNodeFenceObservation) => { n.freshPublishDenied = false; }],
    ["minimum generation not retired", (n: BrokerNodeFenceObservation) => { n.admissionMinimumGeneration = 7; }],
    ["restart accepts", (n: BrokerNodeFenceObservation) => { n.rollback.restartDenied = false; }],
    ["old ACL accepts", (n: BrokerNodeFenceObservation) => { n.rollback.oldAclDenied = false; }],
    ["old CRL accepts", (n: BrokerNodeFenceObservation) => { n.rollback.oldCrlDenied = false; }],
    ["combined rollback accepts", (n: BrokerNodeFenceObservation) => { n.rollback.oldAclAndCrlDenied = false; }],
    ["minimum generation rolled back", (n: BrokerNodeFenceObservation) => { n.rollback.minimumGenerationAfterRollback = 7; }],
    ["revocation ledger rolled back", (n: BrokerNodeFenceObservation) => { n.rollback.revocationLedgerPreserved = false; }],
    ["wrong generation", (n: BrokerNodeFenceObservation) => { n.generation = 6; }],
    ["stale nonce", (n: BrokerNodeFenceObservation) => { n.nonce = "prior-request"; }],
    ["old inventory revision", (n: BrokerNodeFenceObservation) => { n.inventoryRevision = "deployment-41"; }],
    ["previous broker boot", (n: BrokerNodeFenceObservation) => { n.bootId = "old-boot"; }],
    ["unbounded queue count", (n: BrokerNodeFenceObservation) => { n.queuedMessages = NaN; }]
  ])("rejects %s on even one node", async (_name, mutate) => {
    expect(await fixture({ mutate: nodes => mutate(nodes[1]) }).verifyRetired(7))
      .toMatchObject({ status: "unavailable", productionPurgeAllowed: false });
  });

  it.each(["missing", "duplicate", "unexpected"])("rejects a %s broker node", async gap => {
    const result = await fixture({ mutate: nodes => {
      if (gap === "missing") nodes.pop();
      if (gap === "duplicate") nodes[1] = nodes[0];
      if (gap === "unexpected") nodes[1].nodeId = "broker-not-in-census";
    } }).verifyRetired(7);
    expect(result).toMatchObject({ status: "unavailable", reason: "node_evidence_invalid" });
  });

  it.each(["empty", "incomplete", "untrusted-source", "certificate-gap", "duplicate", "wrong-generation"])("rejects %s independent census", async gap => {
    const bad = structuredClone(census);
    if (gap === "empty") bad.nodes = [];
    if (gap === "incomplete") bad.complete = false;
    if (gap === "untrusted-source") (bad as { source: string }).source = "responding-nodes-only";
    if (gap === "certificate-gap") bad.nodes[0].retiredCertificateFingerprints = [];
    if (gap === "duplicate") bad.nodes[1] = bad.nodes[0];
    if (gap === "wrong-generation") bad.generation = 8;
    expect(await fixture({ inventory: async () => bad }).verifyRetired(7))
      .toMatchObject({ status: "unavailable", reason: "census_unavailable" });
  });

  it("rejects changed deployment inventory or broker boot during verification", async () => {
    for (const change of ["revision", "boot", "certificate"]) {
      let reads = 0;
      const result = await fixture({ inventory: async () => {
        const next = structuredClone(census);
        if (++reads > 1) {
          if (change === "revision") next.revision = "deployment-43";
          if (change === "boot") next.nodes[0].bootId = "restarted";
          if (change === "certificate") next.nodes[0].retiredCertificateFingerprints.push("b".repeat(64));
        }
        return next;
      } }).verifyRetired(7);
      expect(result).toMatchObject({ status: "unavailable", reason: "census_changed" });
    }
  });

  it.each([1100, 99, NaN])("rejects expired or discontinuous monotonic collection: %s", async end => {
    let reads = 0;
    expect(await fixture({ monotonicNow: () => ++reads === 1 ? 100 : end }).verifyRetired(7))
      .toMatchObject({ status: "unavailable", reason: "evidence_stale" });
  });

  it("bounds nonresponsive adapter and inventory rather than returning stale success", async () => {
    const never = () => new Promise<never>(() => {});
    for (const pending of ["adapter", "inventory"]) {
      const fence = new BrokerGenerationFence({ adapter: { kind: "disposable", collect: pending === "adapter" ? never : async () => [] },
        census: pending === "inventory" ? never : async () => census, maxVerificationMs: 10 });
      expect(await fence.verifyRetired(7)).toMatchObject({ status: "unavailable", reason: "verification_timeout" });
    }
  });

  it("fails closed for adapter errors and malformed evidence", async () => {
    for (const collect of [async () => { throw new Error("private endpoint/token must not leak"); }, async () => null as never]) {
      const result = await fixture({ collect }).verifyRetired(7);
      expect(result).toMatchObject({ status: "unavailable", productionPurgeAllowed: false });
      expect(JSON.stringify(result)).not.toContain("private endpoint");
    }
  });

  it.each([0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1])("rejects invalid retired generation %s", async generation => {
    expect(await fixture().verifyRetired(generation)).toMatchObject({ status: "unavailable", reason: "invalid_generation" });
  });

  it("does not reuse previous node evidence for a fresh verification challenge", async () => {
    let cached: BrokerNodeFenceObservation[] | undefined;
    const fence = fixture({ collect: async challenge => cached ??= census.nodes.map(node => observation(challenge, node.nodeId)) });
    expect(await fence.verifyRetired(7)).toMatchObject({ status: "verified" });
    expect(await fence.verifyRetired(7)).toMatchObject({ status: "unavailable", reason: "node_evidence_invalid" });
  });
});
