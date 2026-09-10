import { describe, expect, it } from "vitest";
import { settingsSectionsFor } from "./settings-sections";

describe("settingsSectionsFor", () => {
  it("limits an admin to overview, fixture registration, floor plans, and password changes", () => {
    expect(settingsSectionsFor("admin").map((section) => section.label)).toEqual([
      "설정 개요",
      "조명 등록",
      "맵 관리",
      "비밀번호 변경"
    ]);
  });

  it("limits a viewer to read-only overview and floor plans", () => {
    expect(settingsSectionsFor("viewer").map((section) => section.label)).toEqual([
      "설정 개요",
      "맵 관리"
    ]);
    expect(settingsSectionsFor("viewer").map((section) => section.label)).not.toContain("조명 등록");
  });
});
