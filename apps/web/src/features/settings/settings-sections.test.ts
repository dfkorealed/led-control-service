import { describe, expect, it } from "vitest";
import { settingsSectionsFor } from "./settings-sections";

describe("settingsSectionsFor", () => {
  it("limits an admin to operational settings", () => {
    const labels = settingsSectionsFor("admin").map((section) => section.label);

    expect(labels).toContain("도면 관리");
    expect(labels).not.toContain("설치 및 시운전");
    expect(labels).not.toContain("펌웨어 및 유지보수");
  });

  it("limits a viewer to read-only overview, floor plans, and device status", () => {
    expect(settingsSectionsFor("viewer").map((section) => section.label)).toEqual([
      "설정 개요",
      "도면 관리",
      "장비 상태"
    ]);
  });
});
