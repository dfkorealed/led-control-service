export function formatMonitoringTimestamp(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
  }).format(new Date(value));
}
