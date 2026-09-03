#!/bin/sh
set -eu
umask 077

mkdir -p /run/dbus /var/run/led-control /var/lib/bluetooth/mesh /var/lib/led-control \
  /var/lib/led-control/identity/device /var/lib/led-control/identity/mqtt
chmod 0755 /run/dbus
chmod 0750 /var/lib/led-control/identity /var/lib/led-control/identity/device /var/lib/led-control/identity/mqtt
chmod 0700 /var/lib/led-control
chown gateway:gateway /var/lib/led-control /var/lib/led-control/identity \
  /var/lib/led-control/identity/device /var/lib/led-control/identity/mqtt /var/run/led-control
rm -f /run/dbus/system_bus_socket

# The gateway process runs without root. Keep only the D-Bus runtime socket
# accessible while preserving umask 077 for all persistent identity material.
umask 011
dbus-daemon --config-file=/etc/dbus-1/gateway-system.conf --nofork --nopidfile &
DBUS_PID=$!
umask 077
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

BLUEZ_DEBUG_ARGS=""
if [ "${GATEWAY_BLUEZ_DEBUG:-0}" = "1" ]; then
  BLUEZ_DEBUG_ARGS="--debug --dbus-debug"
fi

# The appliance owns a dedicated controller. Raw HCI avoids kernel MGMT Mesh
# transmit failures observed on Raspberry Pi while keeping an explicit `auto`
# escape hatch for diagnostics.
BLUEZ_IO="${GATEWAY_BLUEZ_IO:-generic:hci0}"
BLUEZ_IO_ARGS=""
if [ "$BLUEZ_IO" != "auto" ]; then
  printf '%s\n' "$BLUEZ_IO" | grep -Eq '^generic:hci[0-9]+$' || {
    echo "GATEWAY_BLUEZ_IO must be auto or generic:hciN" >&2
    exit 1
  }
  BLUEZ_IO_ARGS="--io $BLUEZ_IO"
  HCI_INDEX="${BLUEZ_IO#generic:hci}"

  # Raw HCI requires an unpowered controller when bluetooth-meshd takes
  # ownership. A previous container may leave it powered during a redeploy.
  BTMGMT_OUTPUT=$(mktemp)
  set +e
  timeout "${GATEWAY_HCI_RESET_TIMEOUT_SECONDS:-5}" \
    btmgmt --index "$HCI_INDEX" power off >"$BTMGMT_OUTPUT" 2>&1
  BTMGMT_STATUS=$?
  set -e
  case "$BTMGMT_STATUS" in
    0) ;;
    124)
      grep -q 'Set Powered complete' "$BTMGMT_OUTPUT" || {
        cat "$BTMGMT_OUTPUT" >&2
        rm -f "$BTMGMT_OUTPUT"
        echo "Timed out before hci$HCI_INDEX powered off" >&2
        exit 1
      }
      ;;
    *)
      cat "$BTMGMT_OUTPUT" >&2
      rm -f "$BTMGMT_OUTPUT"
      echo "Failed to power off hci$HCI_INDEX" >&2
      exit "$BTMGMT_STATUS"
      ;;
  esac
  rm -f "$BTMGMT_OUTPUT"
fi

# BLUEZ arguments contain only the validated/fixed switches above and are intentionally split.
# shellcheck disable=SC2086
bluetooth-meshd --nodetach --storage /var/lib/bluetooth/mesh $BLUEZ_IO_ARGS $BLUEZ_DEBUG_ARGS &
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
