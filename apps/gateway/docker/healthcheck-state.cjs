const fs = require("node:fs");

const path = process.env.GATEWAY_HEALTH_PATH || "/var/run/led-control/health.json";

try {
  const health = JSON.parse(fs.readFileSync(path, "utf8"));
  if (process.env.GATEWAY_HCI_POWERED !== "1") process.exit(1);
  if (
    health.status !== "healthy" ||
    !health.assignment ||
    !health.mqtt ||
    !health.dbusOwner ||
    !health.bluezAttached ||
    !health.mappingValid ||
    !health.heartbeatFresh
  ) process.exit(1);

  const heartbeatMs = Number(process.env.GATEWAY_HEARTBEAT_MS ?? 5000);
  if (!Number.isInteger(heartbeatMs) || heartbeatMs < 1 || heartbeatMs > 86_400_000) process.exit(1);
  const sentAt = Date.parse(health.lastHeartbeatPublishedAt);
  const age = Date.now() - sentAt;
  const maximumAge = Math.max(30_000, heartbeatMs * 3);
  if (!Number.isFinite(sentAt) || !Number.isFinite(age) || age < 0 || age > maximumAge) process.exit(1);
} catch {
  process.exit(1);
}
