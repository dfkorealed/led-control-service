import { formatTimestamp } from "../../components/ui";

export function formatControlTimestamp(value: string | number | Date, timeZone: string): string {
  return formatTimestamp(typeof value === "number" ? new Date(value) : value, { timeZone });
}
