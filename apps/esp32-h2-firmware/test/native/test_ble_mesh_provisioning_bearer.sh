#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
SOURCE="$REPO_ROOT/apps/esp32-h2-firmware/main/ble_mesh_node.c"
SDKCONFIG_DEFAULTS="$REPO_ROOT/apps/esp32-h2-firmware/sdkconfig.defaults"

grep -q '^#define LED_CONTROL_PROV_BEARERS ESP_BLE_MESH_PROV_ADV$' "$SOURCE"
test "$(grep -c 'esp_ble_mesh_node_prov_enable(LED_CONTROL_PROV_BEARERS)' "$SOURCE")" -eq 2

if grep -q 'ESP_BLE_MESH_PROV_GATT' "$SOURCE"; then
  echo "gateway provisioning firmware must not enable the unused PB-GATT bearer" >&2
  exit 1
fi

if grep -q 'esp_ble_mesh_set_unprovisioned_device_name' "$SOURCE"; then
  echo "PB-ADV-only nodes must not configure the PB-GATT device name" >&2
  exit 1
fi

grep -q '^#define LED_CONTROL_GATT_PROXY_STATE ESP_BLE_MESH_GATT_PROXY_NOT_SUPPORTED$' "$SOURCE"
grep -q '\.gatt_proxy = LED_CONTROL_GATT_PROXY_STATE,' "$SOURCE"
grep -q '^# CONFIG_BLE_MESH_GATT_PROXY_SERVER is not set$' "$SDKCONFIG_DEFAULTS"
grep -q '^# CONFIG_BLE_MESH_PB_GATT is not set$' "$SDKCONFIG_DEFAULTS"
grep -q '^# CONFIG_BT_LE_SCAN_DUPL_TYPE_DEVICE is not set$' "$SDKCONFIG_DEFAULTS"
grep -q '^CONFIG_BT_LE_SCAN_DUPL_TYPE_DATA_DEVICE=y$' "$SDKCONFIG_DEFAULTS"

if grep -q '^CONFIG_BLE_MESH_GATT_PROXY_SERVER=y$' "$SDKCONFIG_DEFAULTS" ||
   grep -q 'ESP_BLE_MESH_GATT_PROXY_ENABLED' "$SOURCE"; then
  echo "gateway-managed nodes must not enable the unused GATT Proxy server" >&2
  exit 1
fi

echo "BLE Mesh PB-ADV-only provisioning and proxy contract: OK"
