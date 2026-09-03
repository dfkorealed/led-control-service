#!/bin/sh
set -eu

BLUEZ_ADAPTER_PATH="${GATEWAY_BLUEZ_ADAPTER_PATH:-/org/bluez/hci0}"
HCI_NAME="${BLUEZ_ADAPTER_PATH##*/}"
HCI_INDEX="${HCI_NAME#hci}"
case "$HCI_INDEX" in
  ''|*[!0-9]*) exit 1 ;;
  *) ;;
esac

dbus-send --system --print-reply --dest=org.freedesktop.DBus \
  /org/freedesktop/DBus org.freedesktop.DBus.NameHasOwner \
  string:org.bluez.mesh | grep -q 'boolean true'
pgrep -f '/opt/led-control/gateway.mjs' >/dev/null
test -d "/sys/class/bluetooth/$HCI_NAME"

# bluetooth-meshd owns the controller management path after startup. Querying it
# again with btmgmt can block even while Mesh traffic is healthy, so runtime
# readiness is proven by the daemon owner, attached app state, and fresh heartbeat.
node /usr/local/lib/gateway-healthcheck-state.cjs
