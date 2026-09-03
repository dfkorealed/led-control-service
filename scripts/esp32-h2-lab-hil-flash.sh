#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-}"
IDF_PATH="${IDF_PATH:-$HOME/esp/esp-idf}"
BUILD_WORKDIR="${ESP32_H2_BUILD_WORKDIR:-$HOME/esp/led-control-esp32-h2-build}"
PYTHON_312_BIN="/opt/homebrew/opt/python@3.12/libexec/bin"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDKCONFIG="$BUILD_WORKDIR/sdkconfig"
MANIFEST="$BUILD_WORKDIR/build/led-control-artifact.manifest"

if [ -z "$PORT" ]; then
  echo "Usage: scripts/esp32-h2-lab-hil-flash.sh /dev/tty.usbmodemXXXX" >&2
  exit 2
fi
if [ ! -f "$IDF_PATH/export.sh" ]; then
  echo "ESP-IDF export.sh not found at $IDF_PATH/export.sh" >&2
  exit 1
fi
if [ ! -f "$SDKCONFIG" ] || [ ! -f "$MANIFEST" ]; then
  echo "Refusing to flash: Lab HIL sdkconfig or artifact manifest is missing." >&2
  exit 1
fi
if ! grep -Eq '^(# CONFIG_LED_CONTROL_TEST_BUILD is not set|CONFIG_LED_CONTROL_TEST_BUILD=n)$' "$SDKCONFIG" ||
    ! grep -q '^CONFIG_LED_CONTROL_LAB_HIL_BUILD=y$' "$SDKCONFIG" ||
    ! grep -q '^CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID=65534$' "$SDKCONFIG" ||
    ! grep -q '^mode=lab-hil$' "$MANIFEST"; then
  echo "Refusing to flash: artifact is not an explicit Lab HIL build." >&2
  exit 1
fi

SOURCE_COMMIT="$(sed -n 's/^source_commit=//p' "$MANIFEST")"
"$SCRIPT_DIR/esp32-h2-artifact-audit.sh" verify-lab-hil "$BUILD_WORKDIR" 65534 "$SOURCE_COMMIT"
echo "verify-lab-hil artifact verified; NOT FOR PRODUCTION"
"$SCRIPT_DIR/esp32-h2-idf-patch.sh" stage "$IDF_PATH" "$BUILD_WORKDIR"
"$SCRIPT_DIR/esp32-h2-idf-patch.sh" report "$BUILD_WORKDIR"

if [ -d "$PYTHON_312_BIN" ]; then
  export PATH="$PYTHON_312_BIN:$PATH"
fi

. "$IDF_PATH/export.sh"
cd "$BUILD_WORKDIR"
idf.py -p "$PORT" flash monitor
