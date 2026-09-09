import type { MqttClient } from "mqtt";
import { fixtureIdentifyResultSchema, fixtureIdentifyTopics, type FixtureIdentifyResult } from "@led-control/shared";

export function publishFixtureIdentifyResult(
  client: Pick<MqttClient, "connected" | "publish" | "getLastMessageId" | "removeOutgoingMessage">,
  input: FixtureIdentifyResult, signal?: AbortSignal
) {
  const result = fixtureIdentifyResultSchema.parse(input);
  return new Promise<void>((resolve, reject) => {
    if (!client.connected) { reject(new Error("identify_result_offline")); return; }
    if (signal?.aborted) { reject(new Error("identify_result_aborted")); return; }
    let settled = false;
    let messageId: number | undefined;
    const finish = (error?: Error, removeOutgoing = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (removeOutgoing && messageId !== undefined) {
        try { client.removeOutgoingMessage(messageId); } catch {
          // Rotation/shutdown may already have drained the old transport's store.
        }
      }
      if (error) reject(error); else resolve();
    };
    const onAbort = () => finish(new Error("identify_result_aborted"), true);
    const timer = setTimeout(() => finish(new Error("identify_result_publish_timeout"), true), 1000);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      client.publish(fixtureIdentifyTopics.result(result.siteId, result.gatewayId), JSON.stringify(result),
        { qos: 1, properties: { messageExpiryInterval: 5 } }, (error) => finish(error ?? undefined));
      messageId = client.getLastMessageId();
    } catch {
      finish(new Error("identify_result_publish_failed"));
    }
  });
}
