#!/bin/sh
set -eu

dbus-send --system --print-reply --dest=org.freedesktop.DBus \
  /org/freedesktop/DBus org.freedesktop.DBus.NameHasOwner \
  string:org.bluez.mesh | grep -q 'boolean true'
pgrep -f '/opt/led-control/gateway.mjs' >/dev/null
test -r /sys/class/bluetooth/hci0/address

node <<'NODE'
const fs = require("node:fs");
const path = process.env.GATEWAY_HEALTH_PATH || "/var/run/led-control/health.json";
const health = JSON.parse(fs.readFileSync(path, "utf8"));
if (health.status === "starting-unassigned" && health.assignment === false) process.exit(0);
if (
  health.status !== "healthy" ||
  !health.assignment ||
  !health.mqtt ||
  !health.dbusOwner ||
  !health.bluezAttached ||
  !health.hciPowered ||
  !health.mappingValid ||
  !health.heartbeatFresh
) process.exit(1);
const age = Date.now() - Date.parse(health.lastHeartbeatPublishedAt);
const heartbeatMs = Number(process.env.GATEWAY_HEARTBEAT_MS || 5000);
const maximumAge = Math.max(30000, heartbeatMs * 3);
if (!Number.isFinite(age) || age > maximumAge) process.exit(1);
NODE
