#!/bin/sh
set -eu

dbus-send --system --print-reply --dest=org.freedesktop.DBus \
  /org/freedesktop/DBus org.freedesktop.DBus.NameHasOwner \
  string:org.bluez.mesh | grep -q 'boolean true'
pgrep -f '/opt/led-control/gateway.mjs' >/dev/null
test -r /sys/class/bluetooth/hci0/address

node /usr/local/lib/gateway-healthcheck-state.cjs
