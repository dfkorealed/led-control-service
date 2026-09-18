import {
  FixedLightingDetectorRegistry,
  PROVIDED_SAMPLE_DWG_SHA256
} from "./lighting-detector-registry";

describe("FixedLightingDetectorRegistry", () => {
  const registry = new FixedLightingDetectorRegistry();

  it("binds only the approved sample digest to the drawing-specific profile", () => {
    expect(registry.resolve({ sourceSha256: PROVIDED_SAMPLE_DWG_SHA256, siteId: "site-a" }))
      .toBe("site-drawing-20260803-v1");
    expect(registry.resolve({ sourceSha256: "a".repeat(64), siteId: "site-a" }))
      .toBe("generic-lighting-v1");
  });

  it("rejects a requested profile that is not the server binding", () => {
    expect(() => registry.assertBinding({
      sourceSha256: "a".repeat(64), siteId: "site-a", profileId: "site-drawing-20260803-v1"
    })).toThrow(/binding/i);
  });
});
