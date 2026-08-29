import { BadRequestException } from "@nestjs/common";
import { parseCreateScheduleInput, parseScheduleListQuery } from "./schedule.dto";

const input = {
  name: "Daily schedule",
  status: "enabled",
  activeFrom: "2026-09-01T00:00:00.000Z",
  activeUntil: "2026-09-30T00:00:00.000Z",
  localStartTime: "09:00",
  localEndTime: "10:00",
  recurrence: {
    kind: "daily",
    weeklyDays: [],
    monthlyDay: null,
    yearlyMonth: null,
    yearlyDay: null
  },
  action: { dimmingEnabled: true, brightnessPercent: 70 },
  target: { type: "fixture", fixtureId: "00000000-0000-4000-8000-000000000001" }
};

describe("schedule DTO validation", () => {
  it("rejects equal local times on create", () => {
    expect(() => parseCreateScheduleInput({
      ...input,
      localEndTime: input.localStartTime
    })).toThrow(BadRequestException);
  });

  it("applies bounded schedule-list pagination defaults", () => {
    expect(parseScheduleListQuery({})).toEqual({ limit: 25 });
    expect(parseScheduleListQuery({
      cursor: "00000000-0000-4000-8000-000000000002",
      limit: "100"
    })).toEqual({
      cursor: "00000000-0000-4000-8000-000000000002",
      limit: 100
    });
  });

  it.each(["0", "101", "1.5", "not-a-number"])("rejects invalid list limit %s", (limit) => {
    expect(() => parseScheduleListQuery({ limit })).toThrow(BadRequestException);
  });

  it("rejects an invalid list cursor", () => {
    expect(() => parseScheduleListQuery({ cursor: "not-a-cursor" })).toThrow(BadRequestException);
  });
});
