import { describe, expect, it } from "vitest";
import { parseDfkDeviceUuid } from "./product-identity";

describe("parseDfkDeviceUuid", () => {
  it("parses the versioned DFK LED product identity", () => {
    expect(parseDfkDeviceUuid("44464b4c454401010101aabbccddeeff")).toEqual({
      formatVersion: 1,
      productFamily: 1,
      modelCode: 1,
      hardwareRevision: 1,
      deviceIdentity: "aabbccddeeff"
    });
  });

  it.each([
    "00112233445566778899aabbccddeeff",
    "44464b4c454402010101aabbccddeeff",
    "44464b4c454401010101aabbccddeef",
    "not-a-device-uuid"
  ])("rejects unsupported or malformed identity %s", (uuid) => {
    expect(parseDfkDeviceUuid(uuid)).toBeNull();
  });
});
