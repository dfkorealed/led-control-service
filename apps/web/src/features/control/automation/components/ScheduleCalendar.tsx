import { TriangleAlert } from "lucide-react";
import type { RefObject } from "react";
import type { LightingScheduleSnapshot } from "@led-control/shared";
import { scheduleCalendarResponseSchema, type ScheduleCalendarResponse } from "@led-control/shared/holiday-calendar-contracts";
import { Button, FeedbackState, Heading, Text } from "../../../../components/ui";
import { scheduleCalendarErrorMessage } from "../../../../api/automation";
import { calendarAddDays, calendarMonthRange, calendarMoveMonth, calendarWeekSegments } from "./calendar-segments";

export function ScheduleCalendar({ month, timeZone, calendar, isPending = false, error, canManage, actionsDisabled = false,
  onMonthChange, onEdit, onRetry, retryRef }: {
  month: string; timeZone: string; calendar?: ScheduleCalendarResponse; isPending?: boolean; error?: unknown;
  canManage: boolean; actionsDisabled?: boolean;
  onMonthChange: (month: string) => void;
  onEdit: (schedule: LightingScheduleSnapshot, opener: HTMLButtonElement) => void;
  onRetry: () => void;
  retryRef?: RefObject<HTMLButtonElement>;
}) {
  const range = calendarMonthRange(month);
  const parsed = calendar ? scheduleCalendarResponseSchema.safeParse(calendar) : null;
  // A cached projection cannot substitute for a failed refresh, another range or another site's zone.
  const valid = parsed?.success && parsed.data.from === range.from && parsed.data.to === range.to && parsed.data.timeZone === timeZone;
  const data = valid && !error && !isPending ? parsed.data : null;
  const message = error ? scheduleCalendarErrorMessage(error)
    : calendar && !valid ? "완전한 달력 응답을 확인하지 못했습니다. 다시 조회해 주세요." : null;
  const weeks = Math.ceil(((Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86_400_000 + 1) / 7);
  const entries = data?.schedules.map(schedule => ({ schedule,
    segments: calendarWeekSegments(data.occurrences.filter(occurrence => occurrence.scheduleId === schedule.id).map(occurrence => occurrence.localDate), range.from) })) ?? [];
  const holidays = new Map(data?.holidayCoverage.flatMap(dataset => dataset.dates.map(day => [day.date, day.names.join(" · ")] as const)) ?? []);
  return <section aria-label="달력" className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain rounded-panel border border-border-default bg-surface-panel p-2 compact:p-3" data-schedule-calendar="">
    <div className="sticky top-0 z-1 flex items-center justify-between gap-2 bg-surface-panel pb-2">
      <Button type="button" variant="ghost" aria-label="이전 달" disabled={month === "0001-01"} onClick={() => onMonthChange(calendarMoveMonth(month, -1))}>‹</Button>
      <Heading as="h3" variant="card-title">{month}</Heading>
      <Button type="button" variant="ghost" aria-label="다음 달" disabled={month === "9999-12"} onClick={() => onMonthChange(calendarMoveMonth(month, 1))}>›</Button>
    </div>
    {message ? <FeedbackState icon={TriangleAlert} tone="danger" liveRole="alert" title={message}
      action={<Button ref={retryRef} type="button" variant="secondary" onClick={onRetry}>달력 다시 조회</Button>} /> : isPending || !data ? <Text role="status">달력을 불러오는 중입니다.</Text> : <>
      {data.holidayCoverage.length ? <Text variant="caption" tone="secondary">{data.holidayCoverage.map(dataset => `${dataset.coverageFrom}~${dataset.coverageUntil} · 갱신 ${dataset.fetchedAt}`).join(" / ")}</Text> : null}
      {data.occurrences.length === 0 ? <Text>실행 일정이 없습니다.</Text> : null}
      <div className="grid grid-cols-7 text-center">{["일", "월", "화", "수", "목", "금", "토"].map(day => <Text key={day} variant="caption">{day}</Text>)}</div>
      {Array.from({ length: Math.round(weeks) }, (_, week) => {
        const start = calendarAddDays(range.from, week * 7);
        const visible = entries.filter(entry => entry.segments.some(segment => segment.week === week));
        return <div key={start} className="grid grid-cols-7 gap-x-1 gap-y-1 border-t border-border-default py-1" style={{ gridTemplateRows: `28px repeat(${Math.max(visible.length, 1)}, minmax(44px, auto))` }}>
          {Array.from({ length: 7 }, (_, column) => {
            const date = calendarAddDays(start, column), holiday = holidays.get(date);
            return <div key={date} className={`min-w-0 truncate px-1 text-caption ${date.startsWith(month) ? "text-content-primary" : "text-content-disabled"}`} title={holiday ?? date} style={{ gridColumn: column + 1, gridRow: 1 }}>
              {Number(date.slice(8))}{holiday ? <span className="ml-1 hidden compact:inline text-status-danger-foreground">{holiday}</span> : null}
            </div>;
          })}
          {visible.flatMap(({ schedule, segments }, lane) => segments.filter(segment => segment.week === week).map(segment => {
            const overnight = schedule.localEndTime < schedule.localStartTime ? " (+1일)" : "";
            const repeat = { daily: "매일", weekly: "매주", monthly: "매월", yearly: "매년", once: "1회" }[schedule.recurrence.kind];
            return <Button key={`${schedule.id}:${segment.from}`} type="button" variant="secondary" className="min-h-11 min-w-0 flex-col items-start! gap-0! overflow-hidden px-1! py-1! text-left!"
              aria-label={`${schedule.name} ${segment.from}~${segment.to} 수정`} disabled={!canManage || actionsDisabled}
              title={`${schedule.name} · ${repeat} ${schedule.localStartTime}~${schedule.localEndTime}${overnight}`}
              style={{ gridColumn: `${segment.start + 1} / ${segment.end + 2}`, gridRow: lane + 2 }}
              data-calendar-schedule={schedule.id} data-calendar-from={segment.from} data-calendar-to={segment.to}
              onClick={event => onEdit(schedule, event.currentTarget)}>
              <span className="block w-full truncate">{schedule.name}</span>
              <span className="block w-full truncate text-caption">{repeat} {schedule.localStartTime}~{schedule.localEndTime}{overnight}</span>
            </Button>;
          }))}
        </div>;
      })}
    </>}
  </section>;
}
