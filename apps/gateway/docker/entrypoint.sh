#!/bin/sh
set -eu
umask 077

mkdir -p /run/dbus /var/run/led-control /var/lib/bluetooth/mesh /var/lib/led-control \
  /var/lib/led-control/identity/device /var/lib/led-control/identity/mqtt
chmod 0750 /var/lib/led-control/identity /var/lib/led-control/identity/device /var/lib/led-control/identity/mqtt
chown gateway:gateway /var/lib/led-control /var/lib/led-control/identity \
  /var/lib/led-control/identity/device /var/lib/led-control/identity/mqtt /var/run/led-control
rm -f /run/dbus/system_bus_socket

dbus-daemon --config-file=/etc/dbus-1/gateway-system.conf --nofork --nopidfile &
DBUS_PID=$!
MESH_PID=""
GATEWAY_PID=""

cleanup() {
  if [ -n "$GATEWAY_PID" ]; then
    kill "$GATEWAY_PID" 2>/dev/null || true
  fi
  if [ -n "$MESH_PID" ]; then
    kill "$MESH_PID" 2>/dev/null || true
  fi
  kill "$DBUS_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

attempt=0
while [ ! -S /run/dbus/system_bus_socket ] && [ "$attempt" -lt 50 ]; do
  kill -0 "$DBUS_PID" 2>/dev/null || {
    echo "dbus-daemon exited before the system bus became ready" >&2
    exit 1
  }
  attempt=$((attempt + 1))
  sleep 0.1
done
[ -S /run/dbus/system_bus_socket ] || {
  echo "D-Bus system bus socket did not become ready" >&2
  exit 1
}

bluetooth-meshd --nodetach --storage /var/lib/bluetooth/mesh &
MESH_PID=$!

attempt=0
while [ "$attempt" -lt 50 ]; do
  if dbus-send --system --print-reply --dest=org.freedesktop.DBus \
      /org/freedesktop/DBus org.freedesktop.DBus.NameHasOwner \
      string:org.bluez.mesh 2>/dev/null | grep -q 'boolean true'; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 0.2
done
[ "$attempt" -lt 50 ] || { echo "org.bluez.mesh did not become ready" >&2; exit 1; }

runuser -u gateway -- node /opt/led-control/gateway.mjs &
GATEWAY_PID=$!
wait "$GATEWAY_PID"
