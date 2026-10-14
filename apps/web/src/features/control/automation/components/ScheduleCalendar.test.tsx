import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScheduleCalendarResponse } from "@led-control/shared/holiday-calendar-contracts";
import { listScheduleCalendar } from "../../../../api/automation";
import { ApiError } from "../../../../api/client";
import { ScheduleCalendar } from "./ScheduleCalendar";

function response(): ScheduleCalendarResponse {
  const id = "00000000-0000-4000-8000-000000000011";
  return { from: "2026-08-30", to: "2026-10-03", timeZone: "Asia/Seoul", complete: true,
    revisionKey: `sha256:${"a".repeat(64)}`, holidayCoverage: [], schedules: [{ id, name: "야간 운영", status: "enabled",
      activeFrom: "2026-09-01T03:00:00.000Z", activeUntil: "2026-09-30T03:00:00.000Z",
      localStartTime: "22:00", localEndTime: "06:00", recurrence: { kind: "weekly", weeklyDays: [1,2,3,4,5], monthlyDay: null, yearlyMonth: null, yearlyDay: null },
      action: { dimmingEnabled: true, brightnessPercent: 70 }, fixtureIds: ["00000000-0000-4000-8000-000000000003"], excludeWeekends: true, excludeHolidays: false }],
    occurrences: ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-28"].map(date => ({ scheduleId: id, key: date, localDate: date, startsAt: `${date}T13:00:00.000Z`, endsAt: `${date}T21:00:00.000Z` })) };
}
const defaults = { month: "2026-09", timeZone: "Asia/Seoul", onMonthChange: vi.fn(), onEdit: vi.fn(), onRetry: vi.fn(), canManage: true };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("server calendar presentation", () => {
  it("uses only server start dates, splits excluded holes and edits the exact snapshot with its opener", () => {
    const edit = vi.fn();
    render(<ScheduleCalendar {...defaults} calendar={response()} onEdit={edit} />);
    const strip = screen.getByRole("button", { name: "야간 운영 2026-09-21~2026-09-23 수정" });
    expect(strip).toHaveTextContent("매주 22:00~06:00 (+1일)");
    expect(strip).toHaveClass("min-h-11");
    expect(screen.getByRole("button", { name: "야간 운영 2026-09-28~2026-09-28 수정" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /2026-09-24/ })).not.toBeInTheDocument();
    fireEvent.click(strip);
    expect(edit).toHaveBeenCalledWith(expect.objectContaining({ id: response().schedules[0].id, excludeWeekends: true }), strip);
  });
  it("rejects incomplete or mismatched projections rather than showing an empty success", () => {
    const view = render(<ScheduleCalendar {...defaults} calendar={{ ...response(), complete: false } as unknown as ScheduleCalendarResponse} />);
    expect(screen.getByRole("alert")).toHaveTextContent("완전한 달력");
    expect(screen.queryByText("실행 일정이 없습니다.")).not.toBeInTheDocument();
    view.rerender(<ScheduleCalendar {...defaults} calendar={{ ...response(), from: "2026-09-01" }} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /야간 운영.*수정/ })).not.toBeInTheDocument();
  });
  it.each([[409,"공휴일"], [503,"불러오지"], [401,"세션"], [403,"권한"]])("hides cached data on HTTP %s and exposes recovery", (status, message) => {
    render(<ScheduleCalendar {...defaults} calendar={response()} error={new ApiError("failure", status as number, { code: status === 409 ? "holiday_coverage_unavailable" : "schedule_calendar_storage_unavailable" })} />);
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByRole("button", { name: /야간 운영.*수정/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "달력 다시 조회" })).toBeInTheDocument();
  });
  it("does not invent occurrences for disabled or missing server starts and respects read-only editing", () => {
    const data = response(); data.occurrences = []; data.schedules[0].status = "disabled";
    const view = render(<ScheduleCalendar {...defaults} calendar={data} />);
    expect(screen.getByText("실행 일정이 없습니다.")).toBeInTheDocument();
    view.rerender(<ScheduleCalendar {...defaults} calendar={response()} canManage={false} />);
    expect(screen.getByRole("button", { name: /야간 운영 2026-09-21/ })).toBeDisabled();
  });
});

describe("calendar HTTP consumer boundary", () => {
  it("uses only range parameters, forwards abort and validates the complete shared response", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(response()), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const controller = new AbortController();
    const result = await listScheduleCalendar("site/id", { from: "2026-08-30", to: "2026-10-03" }, controller.signal);
    expect(result.schedules[0].id).toBe("00000000-0000-4000-8000-000000000011");
    expect(fetcher).toHaveBeenCalledWith("/api/sites/site%2Fid/automation/schedules/calendar?from=2026-08-30&to=2026-10-03",
      expect.objectContaining({ signal: expect.any(AbortSignal), credentials: "include" }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...response(), complete: false }), { status: 200 })));
    await expect(listScheduleCalendar("site/id", { from: "2026-08-30", to: "2026-10-03" })).rejects.toMatchObject({ status: 502 });
  });
});
