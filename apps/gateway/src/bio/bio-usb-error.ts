export type BioUsbErrorCode = "USB_IDENTITY" | "NOT_READY" | "TIMEOUT" | "MALFORMED_FRAME" | "DISCONNECTED" | "LATE_RESPONSE" | "STOPPED" | "READINESS" | "CLOSE_FAILED";

/** USB connection and transport codes carry diagnostics without exposing protocol payloads or site secrets. */
export class BioUsbError extends Error {
  constructor(readonly code: BioUsbErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BioUsbError";
  }
}
