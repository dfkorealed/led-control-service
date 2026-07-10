#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IDF_PATH="${IDF_PATH:-$HOME/esp/esp-idf}"
BUILD_WORKDIR="${ESP32_H2_BUILD_WORKDIR:-$HOME/esp/led-control-esp32-h2-build}"
FIRMWARE_DIR="$REPO_ROOT/apps/esp32-h2-firmware"
PYTHON_312_BIN="/opt/homebrew/opt/python@3.12/libexec/bin"

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

. "$IDF_PATH/export.sh"
cd "$BUILD_WORKDIR"
idf.py set-target esp32h2
idf.py build

echo "Firmware build output: $BUILD_WORKDIR/build"
