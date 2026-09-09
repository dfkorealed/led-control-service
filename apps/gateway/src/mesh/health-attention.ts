import type { EventEmitter } from "node:events";

// Bluetooth Mesh Profile Health Attention Set/Status (ESP-IDF esp_ble_mesh_defs.h).
// Attention is independent of Lightness: it must never generate a brightness command.
export function encodeHealthAttentionSet(seconds: number) {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 10) throw new Error("invalid_attention_seconds");
  return Uint8Array.from([0x80, 0x05, seconds]);
}
export function decodeHealthAttentionStatus(data: Uint8Array) {
  if (data.length !== 3 || data[0] !== 0x80 || data[1] !== 0x07) throw new Error("invalid_attention_status");
  return data[2]!;
}

export function requestHealthAttention(
  application: EventEmitter, source: number, seconds: number,
  send: (payload: Uint8Array) => Promise<unknown>, timeoutMs: number, signal?: AbortSignal
): Promise<number> {
  const payload = encodeHealthAttentionSet(seconds);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      application.off("messageReceived", onMessage);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve(seconds);
    };
    const onAbort = () => finish(new Error("attention_aborted"));
    const onMessage = (event: { source: number; data: Uint8Array }) => {
      if (event.source !== source) return;
      try {
        if (decodeHealthAttentionStatus(event.data) === seconds) finish();
      } catch {
        // Other SIG publications and malformed packets cannot acknowledge Attention.
      }
    };
    const timer = setTimeout(() => finish(new Error("attention_timeout")), timeoutMs);
    application.on("messageReceived", onMessage);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    // The listener and timeout also cover a stuck D-Bus Send, not just its reply.
    void Promise.resolve().then(() => {
      if (!settled) return send(payload);
    }).catch(() => finish(new Error("attention_send_failed")));
  });
}
