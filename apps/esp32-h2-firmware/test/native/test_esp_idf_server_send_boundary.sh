#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
IDF_ROOT="${ESP32_H2_IDF_UNDER_TEST:-${IDF_PATH:-$HOME/esp/esp-idf}}"
FAKE_ROOT="$REPO_ROOT/apps/esp32-h2-firmware/test/idf_patch_fake"
SOURCE="$IDF_ROOT/components/bt/esp_ble_mesh/api/core/esp_ble_mesh_networking_api.c"

if [ ! -f "$SOURCE" ]; then
  echo "ESP-IDF networking source not found at $SOURCE" >&2
  exit 1
fi

cc \
  -std=c11 \
  -Wall \
  -Wextra \
  -Werror \
  -Wno-unused-parameter \
  -I"$FAKE_ROOT/include" \
  "$FAKE_ROOT/test_server_send_boundary.c" \
  "$SOURCE" \
  -o /tmp/test_esp_idf_server_send_boundary

/tmp/test_esp_idf_server_send_boundary
