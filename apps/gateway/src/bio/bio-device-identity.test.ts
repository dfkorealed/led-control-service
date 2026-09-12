import { describe, expect, it } from "vitest";
import { formatBioDeviceUuid, parseBioDeviceUuid } from "./bio-device-identity";

describe("BIO device identity", () => {
  it("formats a six-byte native UUID as the canonical lowercase cloud UUID", () => {
    expect(formatBioDeviceUuid("A1B2C3D4E5F6")).toBe("bio:a1b2c3d4e5f6");
  });

  it("parses only the canonical BIO cloud UUID back to its six-byte native UUID", () => {
    expect(parseBioDeviceUuid("bio:a1b2c3d4e5f6")).toBe("a1b2c3d4e5f6");
    expect(() => parseBioDeviceUuid("BIO:A1B2C3D4E5F6")).toThrow(/invalid BIO device UUID/i);
    expect(() => parseBioDeviceUuid("bio:a1b2c3d4e5")).toThrow(/invalid BIO device UUID/i);
  });
});
