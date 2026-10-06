import { formatTimestamp } from "../../components/ui";

export function formatMonitoringTimestamp(value: string, timeZone: string): string {
  return formatTimestamp(value, { timeZone });
}
