import { loadAutomationProtocolSupport, recordAutomationProtocolSupport } from "./automation-protocol-support";

const gatewayId = "00000000-0000-4000-8000-000000000001";
const siteId = "00000000-0000-4000-8000-000000000002";
const request = { schemaVersion: 2 as const, requestId: "00000000-0000-4000-8000-000000000003",
  gatewayId, siteId, assignmentVersion: 4, declarationRevision: 1, maxSnapshotVersion: 2 as const,
  requestedAt: "2026-09-30T00:00:00.000Z" };

describe("Gateway automation protocol support authority", () => {
  it("records strict V3 capabilities and does not infer them from a numeric version", async () => {
    const h = harness();
    const v3 = { ...request, schemaVersion: 3 as const, maxSnapshotVersion: 3 as const,
      temporaryControlVersion: 1 as const, bioConfigurationReadback: true as const, durableFixtureLease: true as const };
    await expect(recordAutomationProtocolSupport(h.tx as never, v3 as never)).resolves.toBe("accepted");
    expect(await loadAutomationProtocolSupport(h.tx as never, request)).toBe(3);
    expect(h.rows[0]).toMatchObject({ temporaryControlVersion: 1, bioConfigurationReadback: true, durableFixtureLease: true });
    h.rows[0].durableFixtureLease = false;
    expect(await loadAutomationProtocolSupport(h.tx as never, request)).toBe(1);
  });
  it("treats newer same support as exact snapshot resync, not a support transition", async () => {
    const h = harness(); await recordAutomationProtocolSupport(h.tx as never, request);
    expect(await recordAutomationProtocolSupport(h.tx as never, { ...request, requestId: "00000000-0000-4000-8000-000000000006", declarationRevision: 2 })).toBe("refreshed");
    expect(h.rows).toHaveLength(2); expect(await loadAutomationProtocolSupport(h.tx as never, request)).toBe(2);
  });
  it("persists explicit support independently of snapshot ACK and accepts only exact replay", async () => {
    const h = harness();
    expect(await loadAutomationProtocolSupport(h.tx as never, request)).toBe(1);
    expect(await recordAutomationProtocolSupport(h.tx as never, request)).toBe("accepted");
    expect(await loadAutomationProtocolSupport(h.tx as never, request)).toBe(2);
    expect(await recordAutomationProtocolSupport(h.tx as never, request)).toBe("duplicate");
    expect(h.rows).toHaveLength(1);
    await expect(recordAutomationProtocolSupport(h.tx as never, { ...request, maxSnapshotVersion: 1 }))
      .rejects.toThrow("identity conflict");
  });

  it("uses newest explicit downgrade and never lets older support or reused identity promote it", async () => {
    const h = harness();
    await recordAutomationProtocolSupport(h.tx as never, request);
    const downgraded = { ...request, requestId: "00000000-0000-4000-8000-000000000004",
      declarationRevision: 2, maxSnapshotVersion: 1 as const };
    await recordAutomationProtocolSupport(h.tx as never, downgraded);
    expect(await loadAutomationProtocolSupport(h.tx as never, request)).toBe(1);
    expect(await recordAutomationProtocolSupport(h.tx as never, request)).toBe("duplicate");
    expect(await loadAutomationProtocolSupport(h.tx as never, request)).toBe(1);
    expect(await recordAutomationProtocolSupport(h.tx as never, { ...request,
      requestId: "00000000-0000-4000-8000-000000000005" })).toBe("stale");
    await expect(recordAutomationProtocolSupport(h.tx as never, { ...request, declarationRevision: 3 }))
      .rejects.toThrow("identity conflict");
  });

  it("requires current authenticated claim and current assignment on every read and declaration", async () => {
    const h = harness();
    await recordAutomationProtocolSupport(h.tx as never, request);
    h.identity.assignmentVersion = 5;
    expect(await loadAutomationProtocolSupport(h.tx as never, request)).toBe(1);
    expect(await recordAutomationProtocolSupport(h.tx as never, request)).toBe("unverified");
    h.identity.active = false;
    expect(await recordAutomationProtocolSupport(h.tx as never, { ...request, assignmentVersion: 5 })).toBe("unverified");
    expect(await loadAutomationProtocolSupport(h.tx as never, request)).toBe(1);
  });
});

function harness() {
  const rows: Array<Record<string, any>> = [];
  const identity = { assignmentVersion: 4, active: true };
  const tx = {
    $queryRaw: async () => identity.active ? [{ assignmentVersion: identity.assignmentVersion }] : [],
    gatewayAutomationProtocolSupport: {
      findUnique: async ({ where }: any) => rows.find(row => row.declarationId === where.declarationId) ?? null,
      findFirst: async ({ where }: any) => rows.filter(row => row.gatewayId === where.gatewayId
        && row.siteId === where.siteId && row.assignmentVersion === where.assignmentVersion)
        .sort((a, b) => Number(b.declarationRevision - a.declarationRevision))[0] ?? null,
      create: async ({ data }: any) => { rows.push(structuredClone(data)); return data; }
    }
  };
  return { tx, rows, identity };
}
