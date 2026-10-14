import { TemporaryControlResults } from "./temporary-control-results";
import { canonicalPayloadHash } from "../automation/automation-payload-hash";
import { parseTemporaryControlResultTopic } from "../mqtt/topic-scope";
import { randomUUID } from "node:crypto";

describe("temporary result ingress", () => {
  it("matches only the independent exact result channel", () => {
    expect(parseTemporaryControlResultTopic("sites/s/gateways/g/temporary-control/result")).toMatchObject({ siteId: "s", gatewayId: "g" });
    for (const channel of ["temporary-control/command", "temporary-control/result/extra", "events/temporary-control/result"]) {
      expect(parseTemporaryControlResultTopic(`sites/s/gateways/g/${channel}`)).toBeNull();
    }
  });
  it("rejects forged hashes before any transaction or acknowledgement", async () => {
    const result = { schemaVersion: 1, sessionId: "00000000-0000-4000-8000-000000000001", siteId: "00000000-0000-4000-8000-000000000002",
      gatewayId: "00000000-0000-4000-8000-000000000003", assignmentVersion: 1, admissionRevision: 1, originCommandHash: `sha256:${"a".repeat(64)}`,
      originSequence: 1, eventId: "00000000-0000-4000-8000-000000000004", fixtureId: "00000000-0000-4000-8000-000000000005", sessionRevision: 1,
      kind: "apply", targetGeneration: "1", applyConfirmed: false, releaseConfirmed: false, configurationMayHaveChanged: false,
      partialMutation: "none", configurationReadback: null, rfWriteEvidence: "not_started", reason: null, restorationRevision: null,
      restorationPayloadHash: null, observedAt: "2026-10-14T00:00:00.000Z" };
    const receiver = new TemporaryControlResults({} as never);
    await expect(receiver.ingestTemporaryControlResult(result, { ...result, resultHash: canonicalPayloadHash({ wrong: true }) } as never)).rejects.toMatchObject({ status: 400 });
    await expect(receiver.ingestTemporaryControlResult({ siteId: result.fixtureId, gatewayId: result.gatewayId }, { ...result, resultHash: canonicalPayloadHash(result) } as never)).rejects.toMatchObject({ status: 400 });
  });
  it.each(["stale_admission", "stale_owner", "stale_target", "stale_generation"])("never projects rejected mutation through the %s identity gate", async rejection => {
    const sessionId = randomUUID(), fixtureId = randomUUID(), siteId = randomUUID(), gatewayId = randomUUID(), meshNodeId = randomUUID();
    const now = new Date("2026-10-15T00:00:01Z");
    const session = { id: sessionId, siteId, gatewayId, assignmentVersion: 1, admissionRevision: 1, originSequence: 1n,
      originCommandHash: `sha256:${"a".repeat(64)}`, startedAt: new Date("2026-10-15T00:00:00Z"), endsAt: new Date("2026-10-15T00:01:00Z"), terminalAt: null, releaseIntentAt: null, sessionRevision: 1, brightness: 70 };
    const target = { sessionId, fixtureId, meshNodeId, nativeUuid: "001122334455", logicalAddress: "0x0100", applyGeneration: 1n, releaseGeneration: 2n, resolvedAt: null, configurationMayHaveChanged: false };
    const body = { schemaVersion: 1, sessionId, siteId, gatewayId, assignmentVersion: rejection === "stale_admission" ? 2 : 1,
      admissionRevision: 1, originCommandHash: session.originCommandHash, originSequence: 1, eventId: randomUUID(), fixtureId, sessionRevision: 1,
      kind: "apply", targetGeneration: rejection === "stale_generation" ? "3" : "1", applyConfirmed: true, releaseConfirmed: false,
      configurationMayHaveChanged: true, partialMutation: "none", configurationReadback: { configuredHighBrightnessPercent: 69, bioMode: "force-on" },
      rfWriteEvidence: "observed", reason: null, restorationRevision: null, restorationPayloadHash: null, observedAt: now.toISOString() };
    const tx = { $executeRaw: async () => 1, $queryRaw: jest.fn().mockResolvedValueOnce([{ assignmentVersion: 1 }]).mockResolvedValueOnce([{ now }]),
      temporaryControlSession: { findFirst: async () => session }, temporaryControlTarget: { findUnique: async () => target },
      temporaryControlLease: { findUnique: async () => ({ ownerSessionId: rejection === "stale_owner" ? randomUUID() : sessionId, lastGeneration: 2n, liveFixtureId: fixtureId }) },
      fixture: { findUnique: async () => ({ siteId, gatewayId, meshNodeId, meshNode: { deviceUuid: rejection === "stale_target" ? "bio:ffeeddccbbaa" : "bio:001122334455", meshAddress: "0x0100" } }) },
      temporaryControlResultReceipt: { findUnique: async () => null, findMany: async () => [], create: async ({ data }: any) => data },
      temporaryControlOutbox: { findUnique: async () => null, upsert: async ({ create }: any) => create } };
    // The fake offers receipt/ACK persistence, but no target/session mutation:
    // a bypass of an identity gate must fail instead of mutating a successor.
    const consumer = new TemporaryControlResults({ $transaction: (work: (value: unknown) => unknown) => work(tx) } as never);
    expect(await consumer.ingestTemporaryControlResult({ siteId, gatewayId }, { ...body, resultHash: canonicalPayloadHash(body) } as never)).toMatchObject({ status: "rejected", reason: rejection });
    expect(target.configurationMayHaveChanged).toBe(false);
  });
});
