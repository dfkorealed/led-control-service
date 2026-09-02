/** Converts backend transport terminology only at the user-visible rendering boundary. */
export function humanizeTransportMessage(value: string): string {
  return value
    .replace(/\bGateway\b/gi, "게이트웨이")
    .replace(/\bACK를/gi, "장비 응답을")
    .replace(/\bACK\b/gi, "장비 응답")
    .replace(/\btimeout\b/gi, "시간 초과");
}
