import { describe, expect, it } from "vitest";
import { settingsSectionsFor } from "./settings-sections";

describe("settingsSectionsFor", () => {
  it("orders admin settings as overview, users, registration, floor plans, and security", () => {
    expect(settingsSectionsFor("admin").map((section) => section.label)).toEqual([
      "설정 개요",
      "유저 관리",
      "조명 등록",
      "맵 관리",
      "비밀번호 변경"
    ]);
  });

  it("gives a general user overview, read-only floor plans, and password changes", () => {
    expect(settingsSectionsFor("viewer").map((section) => section.label)).toEqual([
      "설정 개요",
      "맵 관리",
      "비밀번호 변경"
    ]);
    expect(settingsSectionsFor("viewer").map((section) => section.label)).not.toContain("조명 등록");
    expect(settingsSectionsFor("viewer").map((section) => section.label)).not.toContain("유저 관리");
  });
});
