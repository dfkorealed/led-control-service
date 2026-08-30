#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IDF_PATH="${IDF_PATH:-$HOME/esp/esp-idf}"
BUILD_WORKDIR="${ESP32_H2_BUILD_WORKDIR:-$HOME/esp/led-control-esp32-h2-build}"
FIRMWARE_DIR="$REPO_ROOT/apps/esp32-h2-firmware"
PYTHON_312_BIN="/opt/homebrew/opt/python@3.12/libexec/bin"
BUILD_MODE="production"
TEST_COMPANY_ID=65535

if [ "${1:-}" = "--test-build" ]; then
  BUILD_MODE="test"
  shift
fi

if [ "$#" -ne 0 ]; then
  echo "Usage: scripts/esp32-h2-build.sh [--test-build]" >&2
  exit 2
fi

if [ "$BUILD_MODE" = "production" ]; then
  COMPANY_ID="${CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID:-}"
  if ! [[ "$COMPANY_ID" =~ ^[0-9]+$ ]] ||
      [ "$COMPANY_ID" -le 0 ] ||
      [ "$COMPANY_ID" -ge 65535 ] ||
      [ "$COMPANY_ID" -eq 741 ]; then
    echo "production build requires CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID with the owner's decimal Bluetooth SIG ID" >&2
    exit 1
  fi
else
  COMPANY_ID="$TEST_COMPANY_ID"
fi

if [ ! -f "$IDF_PATH/export.sh" ]; then
  echo "ESP-IDF export.sh not found at $IDF_PATH/export.sh" >&2
  echo "Install ESP-IDF first: git clone -b v5.5.1 --recursive https://github.com/espressif/esp-idf.git $IDF_PATH && $IDF_PATH/install.sh esp32h2" >&2
  exit 1
fi

if [ -d "$PYTHON_312_BIN" ]; then
  export PATH="$PYTHON_312_BIN:$PATH"
fi

mkdir -p "$BUILD_WORKDIR"
rsync -a --delete \
  --exclude ".pio/" \
  --exclude "build/" \
  --exclude "sdkconfig" \
  "$FIRMWARE_DIR/" "$BUILD_WORKDIR/"

rm -f "$BUILD_WORKDIR/sdkconfig" "$BUILD_WORKDIR/sdkconfig.old"
{
  if [ "$BUILD_MODE" = "test" ]; then
    echo "CONFIG_LED_CONTROL_TEST_BUILD=y"
  else
    echo "CONFIG_LED_CONTROL_TEST_BUILD=n"
  fi
  echo "CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID=$COMPANY_ID"
} >"$BUILD_WORKDIR/sdkconfig.build-gate"

. "$IDF_PATH/export.sh"
cd "$BUILD_WORKDIR"
idf.py -D "SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.build-gate" set-target esp32h2
idf.py build

if [ "$BUILD_MODE" = "test" ]; then
  echo "TEST BUILD ONLY: reserved Company ID 0xFFFF; this binary must not be flashed for HIL or production." >&2
fi
echo "Firmware build output: $BUILD_WORKDIR/build"
