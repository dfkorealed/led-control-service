#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 BUILD_WORKDIR" >&2
  exit 2
fi

BUILD_WORKDIR="$1"
SDKCONFIG="$BUILD_WORKDIR/sdkconfig"
MAP="$BUILD_WORKDIR/build/led_control_node.map"

for file in "$SDKCONFIG" "$MAP"; do
  if [ ! -f "$file" ]; then
    echo "vehicle sensor target audit missing $file" >&2
    exit 1
  fi
done

grep -q '^CONFIG_BLE_MESH_SENSOR_SERVER=y$' "$SDKCONFIG" || {
  echo "vehicle sensor target audit requires CONFIG_BLE_MESH_SENSOR_SERVER=y" >&2
  exit 1
}

require_symbol() {
  local symbol="$1"
  if ! awk -v symbol="$symbol" '$1 ~ /^0x[0-9A-Fa-f]+$/ && $2 == symbol { found = 1 } END { exit !found }' "$MAP"; then
    echo "vehicle sensor target audit missing linked symbol $symbol" >&2
    exit 1
  fi
}

require_section_size() {
  local section="$1"
  local expected="$2"
  local actual
  actual="$(awk -v section="$section" '$1 == section { getline; print $2; exit }' "$MAP")"
  if [ "$actual" != "$expected" ]; then
    echo "vehicle sensor target audit expected $section size $expected, got ${actual:-missing}" >&2
    exit 1
  fi
}

for symbol in \
  esp_ble_mesh_register_sensor_server_callback \
  vehicle_sensor_model_runtime_start \
  vehicle_sensor_model_runtime_stop \
  vehicle_sensor_model_runtime_submit_event \
  vehicle_sensor_model_runtime_request_status \
  vehicle_sensor_model_runtime_receive_ack; do
  require_symbol "$symbol"
done

require_section_size .data.vehicle_sensor_server 0xc
require_section_size .data.vendor_models 0x44
require_section_size .bss.model_task_stack 0x1000
require_section_size .bss.command_queue_buffer 0x600
