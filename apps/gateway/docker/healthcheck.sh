#!/bin/sh
set -eu

BLUEZ_ADAPTER_PATH="${GATEWAY_BLUEZ_ADAPTER_PATH:-/org/bluez/hci0}"
HCI_NAME="${BLUEZ_ADAPTER_PATH##*/}"
case "$HCI_NAME" in
  hci[0-9]*) ;;
  *) exit 1 ;;
esac

dbus-send --system --print-reply --dest=org.freedesktop.DBus \
  /org/freedesktop/DBus org.freedesktop.DBus.NameHasOwner \
  string:org.bluez.mesh | grep -q 'boolean true'
pgrep -f '/opt/led-control/gateway.mjs' >/dev/null
# The Gateway health state verifies Adapter1.Powered through BlueZ D-Bus.
# This remains only a configured-controller presence diagnostic.
test -d "/sys/class/bluetooth/$HCI_NAME"

node /usr/local/lib/gateway-healthcheck-state.cjs
