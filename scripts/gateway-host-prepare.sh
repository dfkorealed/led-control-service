#!/bin/sh
set -eu

CHECK_ONLY=0
if [ "${1:-}" = "--check-only" ]; then
  CHECK_ONLY=1
elif [ "$#" -gt 0 ]; then
  echo "Usage: $0 [--check-only]" >&2
  exit 1
fi

ROOT="${GATEWAY_HOST_ROOT:-}"
RFKILL_CONFIG="${ROOT}/etc/modprobe.d/rfkill_default.conf"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

[ "$(uname -m)" = "aarch64" ] || fail "Gateway appliance requires aarch64 Linux"
require_command docker
docker compose version >/dev/null 2>&1 || fail "Docker Compose plugin is required"

if ! command -v rfkill >/dev/null 2>&1; then
  if [ "$CHECK_ONLY" -eq 1 ]; then
    echo "rfkill is not installed"
    exit 2
  fi
  [ "${GATEWAY_HOST_SKIP_PACKAGE_INSTALL:-0}" = "1" ] || {
    [ "$(id -u)" -eq 0 ] || fail "Run this script with sudo to install rfkill"
    apt-get update
    apt-get install -y rfkill
  }
  require_command rfkill
fi

if [ -f "$RFKILL_CONFIG" ] && grep -Eq '^[[:space:]]*options[[:space:]]+rfkill[[:space:]]+default_state=0([[:space:]]|$)' "$RFKILL_CONFIG"; then
  if [ "$CHECK_ONLY" -eq 1 ]; then
    echo "Bluetooth boot policy is blocked: default_state=0"
    exit 2
  fi
  [ -n "$ROOT" ] || [ "$(id -u)" -eq 0 ] || fail "Run this script with sudo to update $RFKILL_CONFIG"
  temp_config="${RFKILL_CONFIG}.tmp.$$"
  trap 'rm -f "$temp_config"' EXIT HUP INT TERM
  printf '%s\n' 'options rfkill default_state=1' > "$temp_config"
  chmod 0644 "$temp_config"
  mv "$temp_config" "$RFKILL_CONFIG"
  trap - EXIT HUP INT TERM
fi

if [ "$CHECK_ONLY" -eq 0 ]; then
  [ -n "$ROOT" ] || [ "$(id -u)" -eq 0 ] || fail "Run this script with sudo to configure Bluetooth"
  rfkill unblock bluetooth
  systemctl enable --now bluetooth
fi

controller_state="$(bluetoothctl show 2>/dev/null || true)"
printf '%s\n' "$controller_state" | grep -Eq '^[[:space:]]*Powered:[[:space:]]+yes' || fail "Bluetooth controller is not powered"

echo "Gateway host preparation complete"
