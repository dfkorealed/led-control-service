import { BadRequestException } from "@nestjs/common";
import {
  encodeScheduleListCursor,
  parseCreateScheduleInput,
  parseScheduleListQuery
} from "./schedule.dto";

const SITE_ID = "00000000-0000-4000-8000-000000000010";
const SCHEDULE_ID = "00000000-0000-4000-8000-000000000011";
const CREATED_AT = new Date("2026-08-30T01:02:03.456Z");

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
    const cursor = encodeScheduleListCursor({ siteId: SITE_ID, createdAt: CREATED_AT, id: SCHEDULE_ID });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parseScheduleListQuery({}, SITE_ID)).toEqual({ limit: 25 });
    expect(parseScheduleListQuery({
      cursor,
      limit: "100"
    }, SITE_ID)).toEqual({
      cursor: { siteId: SITE_ID, createdAt: CREATED_AT, id: SCHEDULE_ID },
      limit: 100
    });
  });

  it.each(["0", "101", "1.5", "not-a-number"])("rejects invalid list limit %s", (limit) => {
    expect(() => parseScheduleListQuery({ limit }, SITE_ID)).toThrow(BadRequestException);
  });

  it.each([
    "not-a-cursor",
    Buffer.from(JSON.stringify({ v: 2, siteId: SITE_ID, createdAt: CREATED_AT.toISOString(), id: SCHEDULE_ID }))
      .toString("base64url"),
    Buffer.from(JSON.stringify({ v: 1, siteId: SITE_ID, createdAt: "not-a-date", id: SCHEDULE_ID }))
      .toString("base64url")
  ])("rejects malformed or unsupported list cursor %s", (cursor) => {
    expect(() => parseScheduleListQuery({ cursor }, SITE_ID)).toThrow(BadRequestException);
  });

  it("allows a 512-character cursor through the size gate before rejecting its malformed payload", () => {
    const bufferFrom = jest.spyOn(Buffer, "from");
    const jsonParse = jest.spyOn(JSON, "parse");
    try {
      expect(() => parseScheduleListQuery({ cursor: "A".repeat(512) }, SITE_ID))
        .toThrow(BadRequestException);
      expect(bufferFrom).toHaveBeenCalled();
      expect(jsonParse).toHaveBeenCalled();
    } finally {
      bufferFrom.mockRestore();
      jsonParse.mockRestore();
    }
  });

  it("rejects a 513-character cursor before decoding or parsing it", () => {
    const bufferFrom = jest.spyOn(Buffer, "from");
    const jsonParse = jest.spyOn(JSON, "parse");
    try {
      expect(() => parseScheduleListQuery({ cursor: "A".repeat(513) }, SITE_ID))
        .toThrow(BadRequestException);
      expect(bufferFrom).not.toHaveBeenCalled();
      expect(jsonParse).not.toHaveBeenCalled();
    } finally {
      bufferFrom.mockRestore();
      jsonParse.mockRestore();
    }
  });

  it("rejects a cursor scoped to another Site", () => {
    const cursor = encodeScheduleListCursor({
      siteId: "00000000-0000-4000-8000-000000000012",
      createdAt: CREATED_AT,
      id: SCHEDULE_ID
    });

    expect(() => parseScheduleListQuery({ cursor }, SITE_ID)).toThrow(BadRequestException);
  });
});
