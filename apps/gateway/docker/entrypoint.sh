#!/bin/sh
set -eu
umask 077

# 설치 인증만 수행하는 독립 명령은 mkdir/chown/USB 검사보다도 먼저 분기한다.
# Compose의 user=gateway로 시작하며 CLI도 root를 거부한다. 별도 mount를 검증한
# 뒤 제품 bootstrap/CSR/atomic install만 실행하고 종료하므로 HCI/BlueZ/BIO는
# 준비하거나 정리할 이유가 없다. 알 수 없는 인수도 hardware 경로로 흘리지 않는다.
if [ "$#" -gt 0 ]; then
  if [ "$#" -eq 1 ] && [ "$1" = bootstrap-only ]; then
    exec node /opt/led-control/bootstrap-only.mjs
  fi
  echo 'GATEWAY_ENTRYPOINT_INVALID_COMMAND' >&2
  exit 1
fi

mkdir -p /run/dbus /var/run/led-control /var/lib/bluetooth/mesh /var/lib/led-control \
  /var/lib/led-control/identity/device /var/lib/led-control/identity/mqtt
chmod 0755 /run/dbus
chmod 0750 /var/lib/led-control/identity /var/lib/led-control/identity/device /var/lib/led-control/identity/mqtt
chmod 0700 /var/lib/led-control
chown gateway:gateway /var/lib/led-control /var/lib/led-control/identity \
  /var/lib/led-control/identity/device /var/lib/led-control/identity/mqtt /var/run/led-control

case "${GATEWAY_ADAPTER:-}" in
bio-usb)
  # Host preflight 결과만 신뢰하지 않는다. Container namespace에서도 현재
  # descriptor/node/GID를 다시 대조해 stale bind나 바뀐 장치를 fail-closed 한다.
  BIO_PREFLIGHT=$(env -u GATEWAY_BIO_USB_SYSFS_ROOT -u GATEWAY_BIO_USB_DEV_ROOT \
    gateway-bio-usb-preflight)
  BIO_DEVICE=$(printf '%s\n' "$BIO_PREFLIGHT" | sed -n 's/^GATEWAY_BIO_USB_DEVICE=//p')
  BIO_GID=$(printf '%s\n' "$BIO_PREFLIGHT" | sed -n 's/^GATEWAY_BIO_USB_GID=//p')
  [ -n "${GATEWAY_BIO_USB_DEVICE:-}" ] && [ "$BIO_DEVICE" = "$GATEWAY_BIO_USB_DEVICE" ] || {
    echo "BIO USB preflight device changed before startup" >&2
    exit 1
  }
  [ -n "${GATEWAY_BIO_USB_GID:-}" ] && [ "$BIO_GID" = "$GATEWAY_BIO_USB_GID" ] || {
    echo "BIO USB preflight group changed before startup" >&2
    exit 1
  }
  case " $(id -G) " in
    *" $BIO_GID "*) ;;
    *) echo "BIO USB supplemental group is unavailable" >&2; exit 1 ;;
  esac

  # Docker group_add로 받은 숫자 GID는 image의 /etc/group에 없을 수 있다.
  # 검증한 USB GID 하나만 supplementary group으로 다시 지정해 root group을
  # 버린다. BIO overlay의 SETPCAP도 bounding-set과 함께 Node 실행 전에 제거한다.
  exec setpriv --reuid gateway --regid gateway --groups "$BIO_GID" \
    --bounding-set=-all --inh-caps=-all --ambient-caps=-all \
    node /opt/led-control/gateway.mjs
  ;;
bluez)
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
  ;;
*)
  echo "GATEWAY_ADAPTER must be bluez or bio-usb" >&2
  exit 1
  ;;
esac
