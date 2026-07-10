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

if [ -d "$PYTHON_312_BIN" ]; then
  export PATH="$PYTHON_312_BIN:$PATH"
fi

. "$IDF_PATH/export.sh"
cd "$BUILD_WORKDIR"
idf.py -p "$PORT" flash monitor
