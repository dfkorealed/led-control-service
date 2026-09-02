import { humanizeTransportMessage } from "../transport-copy";

/** Preserved control feature API backed by the shared display-only transport copy mapper. */
export function humanizeDeviceResponseMessage(value: string): string {
  return humanizeTransportMessage(value);
}
