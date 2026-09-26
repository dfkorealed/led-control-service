/** UTC rolling-calendar cutoff; derive it from one request/sweep `now`, never from each row. */
export function threeCalendarMonthsBefore(now: Date): Date {
  if (Number.isNaN(now.getTime())) throw new RangeError("invalid retention clock");
  const targetFirst = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1));
  const targetLastDay = new Date(Date.UTC(targetFirst.getUTCFullYear(), targetFirst.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    targetFirst.getUTCFullYear(), targetFirst.getUTCMonth(), Math.min(now.getUTCDate(), targetLastDay),
    now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds(), now.getUTCMilliseconds()
  ));
}
