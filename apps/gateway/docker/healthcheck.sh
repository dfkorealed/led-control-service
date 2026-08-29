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

# Node runs as the unprivileged gateway user, so only this root healthcheck may
# query the kernel management socket. Accept the selected controller only when
# its own current settings explicitly report powered.
if ! BTMGMT_OUTPUT="$(timeout 2s /usr/local/bin/btmgmt --index "$HCI_INDEX" info)"; then
  exit 1
fi

printf '%s\n' "$BTMGMT_OUTPUT" | node /usr/local/lib/gateway-btmgmt-powered.cjs "$HCI_NAME"

GATEWAY_HCI_POWERED=1 node /usr/local/lib/gateway-healthcheck-state.cjs
