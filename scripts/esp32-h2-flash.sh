#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-}"
IDF_PATH="${IDF_PATH:-$HOME/esp/esp-idf}"
BUILD_WORKDIR="${ESP32_H2_BUILD_WORKDIR:-$HOME/esp/led-control-esp32-h2-build}"
PYTHON_312_BIN="/opt/homebrew/opt/python@3.12/libexec/bin"

if [ -z "$PORT" ]; then
  echo "Usage: scripts/esp32-h2-flash.sh /dev/tty.usbmodemXXXX" >&2
  exit 1
fi

if [ ! -f "$IDF_PATH/export.sh" ]; then
  echo "ESP-IDF export.sh not found at $IDF_PATH/export.sh" >&2
  exit 1
fi

SDKCONFIG="$BUILD_WORKDIR/sdkconfig"
TEST_MANIFEST="$BUILD_WORKDIR/build/led-control-artifact.manifest"
ATTESTATION="$BUILD_WORKDIR/build/led-control-artifact.attestation"
ATTESTATION_SIGNATURE="$BUILD_WORKDIR/build/led-control-artifact.attestation.sig"
if [ ! -f "$SDKCONFIG" ]; then
  echo "Refusing to flash: flash requires a verified production sdkconfig." >&2
  exit 1
fi

if grep -q '^CONFIG_LED_CONTROL_TEST_BUILD=y$' "$SDKCONFIG" ||
    { [ -f "$TEST_MANIFEST" ] && grep -q '^mode=test$' "$TEST_MANIFEST"; }; then
  echo "Refusing to flash a test-build binary. Build production firmware with the owner's Bluetooth SIG Company ID." >&2
  exit 1
fi

if [ ! -f "$ATTESTATION" ] || [ ! -f "$ATTESTATION_SIGNATURE" ]; then
  echo "Refusing to flash: signed production artifact attestation is missing." >&2
  exit 1
fi

COMPANY_ID="$(sed -n 's/^CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID=//p' "$SDKCONFIG")"
if ! [[ "$COMPANY_ID" =~ ^[0-9]+$ ]] ||
    [ "$COMPANY_ID" -le 0 ] ||
    [ "$COMPANY_ID" -ge 65535 ] ||
    [ "$COMPANY_ID" -eq 741 ]; then
  echo "Refusing to flash: flash requires the owner's Bluetooth SIG Company ID." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_COMMIT="$(sed -n 's/^source_commit=//p' "$ATTESTATION")"
APPROVAL_MANIFEST="${LED_CONTROL_MANUFACTURING_APPROVAL_MANIFEST:-}"
APPROVAL_SIGNATURE="${LED_CONTROL_MANUFACTURING_APPROVAL_SIGNATURE:-}"
"$SCRIPT_DIR/esp32-h2-manufacturing-approval.sh" \
  verify-production \
  "$COMPANY_ID" \
  "$SOURCE_COMMIT" \
  "$SDKCONFIG" \
  "$BUILD_WORKDIR/partitions.csv" \
  "$APPROVAL_MANIFEST" \
  "$APPROVAL_SIGNATURE" \
  >/dev/null
"$SCRIPT_DIR/esp32-h2-artifact-audit.sh" \
  verify-production-attestation \
  "$BUILD_WORKDIR" \
  "$COMPANY_ID" \
  "$SOURCE_COMMIT" \
  "$APPROVAL_MANIFEST" \
  "$APPROVAL_SIGNATURE"

if [ -d "$PYTHON_312_BIN" ]; then
  export PATH="$PYTHON_312_BIN:$PATH"
fi

. "$IDF_PATH/export.sh"
cd "$BUILD_WORKDIR"
idf.py -p "$PORT" flash monitor
