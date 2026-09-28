export function formatControlTimestamp(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).format(new Date(value));
}
