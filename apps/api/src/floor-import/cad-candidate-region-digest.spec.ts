import { computeCandidateRegionDigests } from "./cad-candidate-region-digest";

describe("computeCandidateRegionDigests", () => {
  it("is deterministic across retry ordering and normalized candidate identity spelling", () => {
    const regionIds = ["region-b", "region-a"];
    const first = computeCandidateRegionDigests(regionIds, [
      { sourceEntityId: "insert/fixture-b", regionId: "region-b" },
      { sourceEntityId: "insert/fixture-a", regionId: "region-a" },
      { sourceEntityId: "insert/fixture-c", regionId: "region-a" }
    ]);
    const retried = computeCandidateRegionDigests([...regionIds].reverse(), [
      { sourceEntityId: "INSERT/FIXTURE-C", regionId: "region-a" },
      { sourceEntityId: "insert/fixture-b", regionId: "region-b" },
      { sourceEntityId: "INSERT/FIXTURE-A", regionId: "region-a" }
    ]);

    expect(retried).toEqual(first);
    expect(Object.values(first)).toEqual([
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.stringMatching(/^[a-f0-9]{64}$/)
    ]);
  });
});
