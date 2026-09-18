/** Converts backend transport terminology only at the user-visible rendering boundary. */
export function humanizeTransportMessage(value: string): string {
  if (value === "fixture already registered in this site") {
    return "이미 이 현장에 등록된 조명입니다.";
  }
  if (value === "fixture already registered in another site") {
    return "이미 다른 현장에 등록된 장치입니다.";
  }
  return value
    .replace(/\bGateway\b/gi, "게이트웨이")
    .replace(/\bACK를/gi, "장비 응답을")
    .replace(/\bACK\b/gi, "장비 응답")
    .replace(/\btimeout\b/gi, "시간 초과");
}
