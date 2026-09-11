import { describe, expect, it } from "vitest";
import { settingsSectionsFor } from "./settings-sections";

describe("settingsSectionsFor", () => {
  it("orders manage-capable settings as overview, users, registration, floor plans, and security", () => {
    expect(settingsSectionsFor({ read: true, control: true, manage: true, commission: true }).map((section) => section.label)).toEqual([
      "설정 개요",
      "유저 관리",
      "조명 등록",
      "맵 관리",
      "비밀번호 변경"
    ]);
  });

  it.each([
    { read: true, control: false, manage: false, commission: false },
    { read: true, control: true, manage: false, commission: false }
  ])("gives read and control capabilities only read-only settings", (capabilities) => {
    expect(settingsSectionsFor(capabilities).map((section) => section.label)).toEqual([
      "설정 개요",
      "맵 관리",
      "비밀번호 변경"
    ]);
    expect(settingsSectionsFor(capabilities).map((section) => section.label)).not.toContain("조명 등록");
    expect(settingsSectionsFor(capabilities).map((section) => section.label)).not.toContain("유저 관리");
  });

  it("returns no site settings when read capability is false", () => {
    expect(settingsSectionsFor({ read: false, control: false, manage: false, commission: false })).toEqual([]);
  });
});
