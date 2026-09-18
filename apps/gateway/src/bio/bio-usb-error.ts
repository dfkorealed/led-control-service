export type BioUsbErrorCode =
  | "USB_IDENTITY" | "NOT_READY" | "TIMEOUT" | "MALFORMED_FRAME" | "DISCONNECTED"
  | "LATE_RESPONSE" | "STOPPED" | "READINESS" | "CLOSE_FAILED"
  | "BIO_DEVICE_NOT_FOUND" | "BIO_ADDRESS_CONFLICT" | "BIO_ADDRESS_STATE_UNKNOWN"
  | "BIO_IDENTIFY_RESTORE_UNCONFIRMED" | "BIO_BRIGHTNESS_STATE_MISMATCH"
  | "BIO_CONTROL_MODE_STATE_MISMATCH";

/**
 * payload/site secret를 노출하지 않는 USB/transport 오류 경계다.
 * [확인됨] MALFORMED_FRAME은 checksum/length/응답 계약 위반, LATE_RESPONSE는 요청 소유권
 * 이전·이후의 정상/partial 후보, READINESS는 checksum 이후 mapping/probe 검증 실패를 뜻한다.
 * [추정] 분류 불가능한 제조사 오류를 상세 payload와 함께 로깅하는 것보다 세대 전체를
 * 닫는 편이 안전하므로, close가 확인되지 않으면 CLOSE_FAILED로 재연결도 중단한다.
 * [확인됨] BIO_* state code는 외부 0x11 ACK가 아닌 UUID/address 재검색 또는 0x12
 * read-back 검증 결과다. ACK 수락은 이 오류 경계에서 deviceApplied로 승격되지 않는다.
 */
export class BioUsbError extends Error {
  constructor(readonly code: BioUsbErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BioUsbError";
  }
}

/** Missing matched lamp report; USB ACK/recovery timeouts keep the base BioUsbError type. */
export class BioDeviceReadTimeoutError extends BioUsbError {
  constructor() {
    super("TIMEOUT", "BIO matching device read-back timed out");
    this.name = "BioDeviceReadTimeoutError";
  }
}
