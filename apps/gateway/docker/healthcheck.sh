#!/bin/sh
set -eu

case "${GATEWAY_ADAPTER:-}" in
  bluez)
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
    test -d "/sys/class/bluetooth/$HCI_NAME"
    ;;
  bio-usb)
    # [확인됨] BIO readiness는 state JSON의 direct-USB boolean probe가 소유한다.
    # D-Bus/HCI/제조사 앱을 조회하지 않는다. raw node 재매핑은 Task 8 전까지 [미확인]이다.
    ;;
  *) exit 1 ;;
esac

pgrep -f '/opt/led-control/gateway.mjs' >/dev/null

# bluetooth-meshd owns the BlueZ controller management path after startup. Querying
# it again with btmgmt can block; adapter-specific readiness is recorded in state.
node /usr/local/lib/gateway-healthcheck-state.cjs
