#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
FIXTURE_ROOT="$(mktemp -d)"
trap 'rm -rf "$FIXTURE_ROOT"' EXIT
PATCH_GATE="$REPO_ROOT/scripts/esp32-h2-idf-patch.sh"

mkdir -p "$FIXTURE_ROOT/build/bootloader" "$FIXTURE_ROOT/build/partition_table"
cat >"$FIXTURE_ROOT/sdkconfig" <<'EOF'
CONFIG_GPIO_CTRL_FUNC_IN_IRAM=y
CONFIG_BLE_MESH_SETTINGS=y
CONFIG_LED_CONTROL_TEST_BUILD=y
CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID=65535
EOF
"$PATCH_GATE" write-identity "$FIXTURE_ROOT/esp-idf-patch.identity"
printf 'fixture binary\n' >"$FIXTURE_ROOT/build/led_control_node.bin"
printf 'bootloader fixture\n' >"$FIXTURE_ROOT/build/bootloader/bootloader.bin"
printf 'partition fixture\n' >"$FIXTURE_ROOT/build/partition_table/partition-table.bin"
printf 'ota fixture\n' >"$FIXTURE_ROOT/build/ota_data_initial.bin"
cat >"$FIXTURE_ROOT/build/flash_args" <<'EOF'
--flash_mode dio --flash_freq 48m --flash_size 4MB
0x0 bootloader/bootloader.bin
0x8000 partition_table/partition-table.bin
0xd000 ota_data_initial.bin
0x10000 led_control_node.bin
EOF
cat >"$FIXTURE_ROOT/partitions.csv" <<'EOF'
# Name, Type, SubType, Offset, Size, Flags
nvs,data,nvs,0x9000,0x4000,
otadata,data,ota,0xd000,0x2000,
phy_init,data,phy,0xf000,0x1000,
ota_0,app,ota_0,0x10000,0x1f0000,
ota_1,app,ota_1,0x200000,0x1f0000,
EOF

write_map() {
  local gpio_address="$1"
  cat >"$FIXTURE_ROOT/build/led_control_node.map" <<EOF
                0x40801000                vehicle_sensor_gpio_isr
                $gpio_address                gpio_get_level
                0x40803000                esp_timer_get_time
                0x40804000                xQueueGenericSendFromISR
EOF
}

write_map 0x42002000
if "$REPO_ROOT/scripts/esp32-h2-artifact-audit.sh" create "$FIXTURE_ROOT" test 65535 >"$FIXTURE_ROOT/flash-symbol.out" 2>&1; then
  echo "audit unexpectedly accepted flash-resident gpio_get_level" >&2
  exit 1
fi
grep -q "gpio_get_level is not linked to IRAM/ROM" "$FIXTURE_ROOT/flash-symbol.out"

write_map 0x40402000
if "$REPO_ROOT/scripts/esp32-h2-artifact-audit.sh" create "$FIXTURE_ROOT" test 65535 >"$FIXTURE_ROOT/non-executable-symbol.out" 2>&1; then
  echo "audit unexpectedly accepted an address outside ESP32-H2 ROM/IRAM" >&2
  exit 1
fi
grep -q "gpio_get_level is not linked to IRAM/ROM" "$FIXTURE_ROOT/non-executable-symbol.out"

write_map 0x40802000
printf 'stale production attestation\n' >"$FIXTURE_ROOT/build/led-control-artifact.attestation"
printf 'stale production signature\n' >"$FIXTURE_ROOT/build/led-control-artifact.attestation.sig"
"$REPO_ROOT/scripts/esp32-h2-artifact-audit.sh" create "$FIXTURE_ROOT" test 65535
test ! -e "$FIXTURE_ROOT/build/led-control-artifact.attestation"
test ! -e "$FIXTURE_ROOT/build/led-control-artifact.attestation.sig"
grep -q '^binary_size=15$' "$FIXTURE_ROOT/build/led-control-artifact.manifest"
grep -q '^bootloader_sha256=' "$FIXTURE_ROOT/build/led-control-artifact.manifest"
grep -q '^partition_table_sha256=' "$FIXTURE_ROOT/build/led-control-artifact.manifest"
grep -q '^ota_data_sha256=' "$FIXTURE_ROOT/build/led-control-artifact.manifest"
grep -q '^schema=led-control-test-artifact-v3$' "$FIXTURE_ROOT/build/led-control-artifact.manifest"
grep -q '^esp_idf_version=v5.5.1$' "$FIXTURE_ROOT/build/led-control-artifact.manifest"
grep -Eq '^esp_idf_patch_sha256=[0-9a-f]{64}$' "$FIXTURE_ROOT/build/led-control-artifact.manifest"
grep -Eq '^esp_idf_patch_identity_sha256=[0-9a-f]{64}$' "$FIXTURE_ROOT/build/led-control-artifact.manifest"
grep -q '^app_partition_size=2031616$' "$FIXTURE_ROOT/build/led-control-artifact.manifest"
grep -q '^release_required_free=406324$' "$FIXTURE_ROOT/build/led-control-artifact.manifest"

cp "$FIXTURE_ROOT/esp-idf-patch.identity" "$FIXTURE_ROOT/esp-idf-patch.identity.valid"
sed 's/^patch_sha256=.*/patch_sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/' \
  "$FIXTURE_ROOT/esp-idf-patch.identity.valid" >"$FIXTURE_ROOT/esp-idf-patch.identity"
if "$REPO_ROOT/scripts/esp32-h2-artifact-audit.sh" verify "$FIXTURE_ROOT" test 65535 >"$FIXTURE_ROOT/patch-identity.out" 2>&1; then
  echo "audit unexpectedly accepted a tampered ESP-IDF patch identity" >&2
  exit 1
fi
grep -q 'ESP-IDF patch identity patch_sha256 mismatch' "$FIXTURE_ROOT/patch-identity.out"
mv "$FIXTURE_ROOT/esp-idf-patch.identity.valid" "$FIXTURE_ROOT/esp-idf-patch.identity"

sed -i.bak '/CONFIG_GPIO_CTRL_FUNC_IN_IRAM/d' "$FIXTURE_ROOT/sdkconfig"
printf 'fixture binary\n' >"$FIXTURE_ROOT/build/led_control_node.bin"
if "$REPO_ROOT/scripts/esp32-h2-artifact-audit.sh" create "$FIXTURE_ROOT" test 65535 >"$FIXTURE_ROOT/config.out" 2>&1; then
  echo "audit unexpectedly accepted missing GPIO IRAM config" >&2
  exit 1
fi
grep -q "CONFIG_GPIO_CTRL_FUNC_IN_IRAM=y" "$FIXTURE_ROOT/config.out"

printf 'CONFIG_GPIO_CTRL_FUNC_IN_IRAM=y\n' >>"$FIXTURE_ROOT/sdkconfig"
sed -i.bak '/CONFIG_BLE_MESH_SETTINGS/d' "$FIXTURE_ROOT/sdkconfig"
printf 'fixture binary\n' >"$FIXTURE_ROOT/build/led_control_node.bin"
if "$REPO_ROOT/scripts/esp32-h2-artifact-audit.sh" create "$FIXTURE_ROOT" test 65535 >"$FIXTURE_ROOT/mesh-settings.out" 2>&1; then
  echo "audit unexpectedly accepted disabled BLE Mesh settings persistence" >&2
  exit 1
fi
grep -q "CONFIG_BLE_MESH_SETTINGS=y" "$FIXTURE_ROOT/mesh-settings.out"
