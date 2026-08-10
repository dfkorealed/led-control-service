import { createHash } from "node:crypto";

export const editorLeaseTtlSeconds = 90;
export const editorLeaseTtlMs = editorLeaseTtlSeconds * 1_000;

export function hashEditorLeaseToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
