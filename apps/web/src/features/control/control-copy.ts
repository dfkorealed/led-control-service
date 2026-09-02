/** Converts transport jargon only at the user-visible rendering boundary. */
export function humanizeDeviceResponseMessage(value: string): string {
  return value
    .replace(/\bACK를/gi, "장비 응답을")
    .replace(/\bACK\b/gi, "장비 응답");
}
