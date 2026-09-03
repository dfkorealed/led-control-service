import { describe, expect, it } from "vitest";
import { humanizeTransportMessage } from "./transport-copy";

describe("humanizeTransportMessage", () => {
  it.each([
    ["Gateway ACK timeout", "게이트웨이 장비 응답 시간 초과"],
    ["Gateway ACK 확인 필요", "게이트웨이 장비 응답 확인 필요"],
    ["Gateway ACK를 확인하지 못했습니다.", "게이트웨이 장비 응답을 확인하지 못했습니다."]
  ])("transport 원문 %s를 자연스러운 한국어로 표시한다", (raw, expected) => {
    const display = humanizeTransportMessage(raw);

    expect(display).toBe(expected);
    expect(display).not.toMatch(/Gateway|ACK|timeout/i);
  });
});
