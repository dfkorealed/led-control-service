#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 BUILD_WORKDIR" >&2
  exit 2
fi

BUILD_WORKDIR="$1"
SDKCONFIG="$BUILD_WORKDIR/sdkconfig"
MAP="$BUILD_WORKDIR/build/led_control_node.map"
MAIN_ROOT="$BUILD_WORKDIR/main"

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

grep -q '^CONFIG_BLE_MESH_SETTINGS=y$' "$SDKCONFIG" || {
  echo "vehicle sensor target audit requires CONFIG_BLE_MESH_SETTINGS=y" >&2
  exit 1
}

if grep -Eq 'SENSOR_SETUP_SRV|vehicle_sensor_setup' "$MAIN_ROOT/ble_mesh_node.c"; then
  echo "vehicle sensor target audit forbids unsupported Sensor Setup Server composition" >&2
  exit 1
fi
if grep -Rqs 'k_delayed_work_cancel' \
    "$MAIN_ROOT/vehicle_sensor_model.c" \
    "$MAIN_ROOT/vehicle_sensor_runtime.c" \
    "$MAIN_ROOT/vehicle_sensor_mesh_adapter.c"; then
  echo "vehicle sensor target audit forbids a second stack publication timer path" >&2
  exit 1
fi
if grep -Rqs 'vehicle_sensor_model_current_level' \
    "$MAIN_ROOT/vehicle_sensor_runtime.c" \
    "$MAIN_ROOT/vehicle_sensor_mesh_adapter.c" \
    "$MAIN_ROOT/ble_mesh_node.c"; then
  echo "vehicle sensor target audit forbids the retry-core cache as a current-state source" >&2
  exit 1
fi
if [ "$(wc -l <"$MAIN_ROOT/vehicle_sensor_model.c" | tr -d ' ')" -gt 400 ]; then
  echo "vehicle sensor codec/retry core must stay below 400 lines" >&2
  exit 1
fi

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
  vehicle_sensor_model_runtime_request \
  vehicle_sensor_model_runtime_receive_ack; do
  require_symbol "$symbol"
done

for symbol in \
  vehicle_sensor_mesh_adapter_send_response \
  vehicle_sensor_health_build_current \
  vehicle_sensor_model_runtime_clear_fault_history; do
  require_symbol "$symbol"
done

require_section_size .data.vehicle_sensor_server 0xc
require_section_size .data.vendor_models 0x44
require_section_size .bss.model_task_stack 0x1000
