import { stageCreateSchema, stagePartSchema, stageCommitSchema, stagePartIndex,
  MAP_STAGE_PART_BYTES, MAP_STAGE_TOTAL_BYTES } from "./map-document-stage-contracts";

const lease = { leaseToken: "lease-token", leaseFence: 3 };
const envelope = { ...lease, expectedRevision: 4, fixtureUpdates: [], slotAssignments: [],
  objectCreates: [], objectUpdates: [], objectDeletes: [],
  documentChanges: { requestId: "save-1", generationId: "generation-1", operations: [] } };

describe("staged editor public input contract", () => {
  it("reuses the normal save envelope with empty operations and actual map dimensions", () => {
    expect(stageCreateSchema.parse(envelope)).toEqual(envelope);
    const floorPlan = { sourceType: "none", imageUrl: "", originalFileUrl: null, renderedImageUrl: null,
      width: 2048, height: 1024, gridSize: 25 };
    expect(stageCreateSchema.parse({ ...envelope, floorPlan }).floorPlan).toMatchObject(floorPlan);
    expect(stageCreateSchema.safeParse({ ...envelope, documentChanges: undefined }).success).toBe(false);
    expect(stageCreateSchema.safeParse({ ...envelope, documentChanges: {
      ...envelope.documentChanges, operations: [{ kind: "delete", id: "one" }]
    } }).success).toBe(false);
    expect(stageCreateSchema.safeParse({ ...envelope, extra: true }).success).toBe(false);
  });

  it("accepts canonical base64 with a decoded 512 KiB limit, bound lease and SHA256", () => {
    const input = { ...lease, data: Buffer.alloc(MAP_STAGE_PART_BYTES).toString("base64"), sha256: "a".repeat(64) };
    expect(stagePartSchema.safeParse(input).success).toBe(true);
    for (const data of ["", "?", "YQ", "YR==", Buffer.alloc(MAP_STAGE_PART_BYTES + 1).toString("base64")]) {
      expect(stagePartSchema.safeParse({ ...input, data }).success).toBe(false);
    }
    expect(stagePartSchema.safeParse({ ...input, leaseFence: 0 }).success).toBe(false);
    expect(stagePartSchema.safeParse({ ...input, sha256: "A".repeat(64) }).success).toBe(false);
  });

  it("requires complete-stream integrity and bounded canonical part indexes", () => {
    const input = { ...lease, partCount: 1024, decodedBytes: MAP_STAGE_TOTAL_BYTES, sha256: "b".repeat(64) };
    expect(stageCommitSchema.parse(input)).toEqual(input);
    for (const patch of [{ partCount: 0 }, { partCount: 1025 }, { decodedBytes: MAP_STAGE_TOTAL_BYTES + 1 },
      { decodedBytes: 0 }, { partCount: 1, decodedBytes: MAP_STAGE_PART_BYTES + 1 }]) {
      expect(stageCommitSchema.safeParse({ ...input, ...patch }).success).toBe(false);
    }
    expect(stagePartIndex.parse("1023")).toBe(1023);
    for (const value of ["1024", "-1", "01", "1.0", "1e2", "", " 1"]) expect(stagePartIndex.safeParse(value).success).toBe(false);
  });
});
