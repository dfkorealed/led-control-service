export type BioUsbErrorCode = "USB_IDENTITY" | "NOT_READY" | "TIMEOUT" | "MALFORMED_FRAME" | "DISCONNECTED" | "LATE_RESPONSE" | "STOPPED" | "READINESS" | "CLOSE_FAILED";

/**
 * payload/site secret를 노출하지 않는 USB/transport 오류 경계다.
 * [확인됨] MALFORMED_FRAME은 checksum/length/응답 계약 위반, LATE_RESPONSE는 요청 소유권
 * 이전·이후의 정상/partial 후보, READINESS는 checksum 이후 mapping/probe 검증 실패를 뜻한다.
 * [추정] 분류 불가능한 제조사 오류를 상세 payload와 함께 로깅하는 것보다 세대 전체를
 * 닫는 편이 안전하므로, close가 확인되지 않으면 CLOSE_FAILED로 재연결도 중단한다.
 */
export class BioUsbError extends Error {
  constructor(readonly code: BioUsbErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BioUsbError";
  }
}
