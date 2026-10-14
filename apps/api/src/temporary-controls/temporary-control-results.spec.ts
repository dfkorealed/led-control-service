import { TemporaryControlResults } from "./temporary-control-results";
import { canonicalPayloadHash } from "../automation/automation-payload-hash";
import { parseTemporaryControlResultTopic } from "../mqtt/topic-scope";

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
});
