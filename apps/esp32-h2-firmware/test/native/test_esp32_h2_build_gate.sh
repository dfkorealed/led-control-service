#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
FIXTURE_ROOT="$(mktemp -d)"
trap 'rm -rf "$FIXTURE_ROOT"' EXIT
UPSTREAM_IDF_ROOT="${ESP32_H2_TEST_UPSTREAM_IDF_PATH:-$HOME/esp/esp-idf}"
PINNED_IDF_COMMIT=fcae32885b0296b32044cb99ecbdc50d98dddb83
NETWORKING_PATH=components/bt/esp_ble_mesh/api/core/esp_ble_mesh_networking_api.c
BTC_TASK_PATH=components/bt/common/btc/core/btc_task.c
PROV_PATH=components/bt/esp_ble_mesh/btc/btc_ble_mesh_prov.c

mkdir -p \
  "$FIXTURE_ROOT/idf/$(dirname "$NETWORKING_PATH")" \
  "$FIXTURE_ROOT/idf/$(dirname "$BTC_TASK_PATH")" \
  "$FIXTURE_ROOT/idf/$(dirname "$PROV_PATH")" \
  "$FIXTURE_ROOT/bin"
cp "$UPSTREAM_IDF_ROOT/$NETWORKING_PATH" "$FIXTURE_ROOT/idf/$NETWORKING_PATH"
cp "$UPSTREAM_IDF_ROOT/$BTC_TASK_PATH" "$FIXTURE_ROOT/idf/$BTC_TASK_PATH"
cp "$UPSTREAM_IDF_ROOT/$PROV_PATH" "$FIXTURE_ROOT/idf/$PROV_PATH"
cat >"$FIXTURE_ROOT/idf/export.sh" <<'EOF'
idf.py() {
  printf '%s\n' "$*" >>"$ESP32_H2_BUILD_GATE_CALLS"
  if [[ "$*" == *"set-target esp32h2" ]]; then
    sed -E 's/^CONFIG_([A-Z0-9_]+)=n$/# CONFIG_\1 is not set/' sdkconfig.build-gate >sdkconfig
    cat sdkconfig.defaults >>sdkconfig
  elif [ "$*" = "build" ]; then
    mkdir -p build/bootloader build/partition_table
    printf 'firmware fixture\n' >build/led_control_node.bin
    printf 'bootloader fixture\n' >build/bootloader/bootloader.bin
    printf 'partition fixture\n' >build/partition_table/partition-table.bin
    printf 'ota fixture\n' >build/ota_data_initial.bin
    cat >build/led_control_node.map <<'MAP'
 .data.vendor_models
                0x40800100       0x44 fixture
 .data.vehicle_sensor_server
                0x40800144        0xc fixture
 .bss.model_task_stack
                0x40800200     0x1000 fixture
 .bss.command_queue_buffer
                0x40801200      0x600 fixture
                0x40801000                vehicle_sensor_gpio_isr
                0x40802000                gpio_get_level
                0x40803000                esp_timer_get_time
                0x40804000                xQueueGenericSendFromISR
                0x42001000                esp_ble_mesh_register_sensor_server_callback
                0x42002000                vehicle_sensor_model_runtime_start
                0x42003000                vehicle_sensor_model_runtime_stop
                0x42004000                vehicle_sensor_model_runtime_submit_event
                0x42005000                vehicle_sensor_model_runtime_request
                0x42006000                vehicle_sensor_model_runtime_receive_ack
                0x42006500                vehicle_sensor_model_runtime_record_send_result
                0x42007000                vehicle_sensor_mesh_adapter_send_response
                0x42008000                vehicle_sensor_health_build_current
                0x42009000                vehicle_sensor_model_runtime_clear_fault_history
MAP
    cat >build/flash_args <<'ARGS'
--flash_mode dio --flash_freq 48m --flash_size 4MB
0x0 bootloader/bootloader.bin
0x8000 partition_table/partition-table.bin
0xd000 ota_data_initial.bin
0x10000 led_control_node.bin
ARGS
    printf '[{"file":"%s/components/bt/esp_ble_mesh/api/core/esp_ble_mesh_networking_api.c"}]\n' \
      "$PWD" >build/compile_commands.json
  fi
}
EOF

REAL_GIT="$(command -v git)"
cat >"$FIXTURE_ROOT/bin/git" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = "-C" ] && [ "\${2:-}" = "$FIXTURE_ROOT/idf" ]; then
  if [ "\${3:-}" = "rev-parse" ] && [ "\${4:-}" = "HEAD" ]; then
    printf '%s\n' "$PINNED_IDF_COMMIT"
    exit 0
  fi
  if [ "\${3:-}" = "describe" ]; then
    printf '%s\n' v5.5.1
    exit 0
  fi
  if [ "\${3:-}" = "diff" ] || [ "\${3:-}" = "ls-files" ]; then
    exit 0
  fi
fi
exec "$REAL_GIT" "\$@"
EOF
chmod +x "$FIXTURE_ROOT/bin/git"

run_build() {
  env \
    PATH="$FIXTURE_ROOT/bin:$PATH" \
    IDF_PATH="$FIXTURE_ROOT/idf" \
    ESP32_H2_BUILD_WORKDIR="$FIXTURE_ROOT/build-workdir" \
    ESP32_H2_BUILD_GATE_CALLS="$FIXTURE_ROOT/idf-calls" \
    "$REPO_ROOT/scripts/esp32-h2-build.sh" "$@"
}

if run_build >"$FIXTURE_ROOT/production-missing.out" 2>&1; then
  echo "production build unexpectedly accepted a missing Company ID" >&2
  exit 1
fi
grep -q "production build requires CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID" "$FIXTURE_ROOT/production-missing.out"
test ! -e "$FIXTURE_ROOT/idf-calls"

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$FIXTURE_ROOT/caller.key.pem" >/dev/null 2>&1
openssl pkey -in "$FIXTURE_ROOT/caller.key.pem" -pubout -out "$FIXTURE_ROOT/caller.pub.pem" >/dev/null 2>&1
CALLER_KEY_SHA256="$(openssl pkey -pubin -in "$FIXTURE_ROOT/caller.pub.pem" -outform DER 2>/dev/null | openssl dgst -sha256 | awk '{print $NF}')"
cat >"$FIXTURE_ROOT/caller-approval.manifest" <<'EOF'
schema=led-control-manufacturing-approval-v2
product=led-control-esp32-h2
mode=production
company_id=4660
source_commit=0123456789abcdef0123456789abcdef01234567
sdkconfig_sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
partitions_sha256=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
EOF
openssl dgst -sha256 -sign "$FIXTURE_ROOT/caller.key.pem" -out "$FIXTURE_ROOT/caller-approval.sig" "$FIXTURE_ROOT/caller-approval.manifest"

if env \
  CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID=4660 \
  LED_CONTROL_MANUFACTURING_APPROVAL_MANIFEST="$FIXTURE_ROOT/caller-approval.manifest" \
  LED_CONTROL_MANUFACTURING_APPROVAL_SIGNATURE="$FIXTURE_ROOT/caller-approval.sig" \
  LED_CONTROL_MANUFACTURING_APPROVAL_PUBLIC_KEY="$FIXTURE_ROOT/caller.pub.pem" \
  LED_CONTROL_MANUFACTURING_APPROVAL_PUBLIC_KEY_SHA256="$CALLER_KEY_SHA256" \
  LED_CONTROL_PRODUCTION_TRUST_POLICY="$FIXTURE_ROOT/caller-policy.conf" \
  IDF_PATH="$FIXTURE_ROOT/idf" \
  ESP32_H2_BUILD_WORKDIR="$FIXTURE_ROOT/build-workdir" \
  ESP32_H2_BUILD_GATE_CALLS="$FIXTURE_ROOT/idf-calls" \
  "$REPO_ROOT/scripts/esp32-h2-build.sh" >"$FIXTURE_ROOT/unprovisioned.out" 2>&1; then
  echo "caller-selected trust material unexpectedly enabled production build" >&2
  exit 1
fi
grep -q "production trust root is not provisioned" "$FIXTURE_ROOT/unprovisioned.out"
test ! -e "$FIXTURE_ROOT/idf-calls"

for invalid in 0 741 65535 invalid; do
  if CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID="$invalid" run_build >"$FIXTURE_ROOT/invalid.out" 2>&1; then
    echo "production build unexpectedly accepted Company ID $invalid" >&2
    exit 1
  fi
done

run_build --test-build >"$FIXTURE_ROOT/test-build.out" 2>&1
grep -q '^CONFIG_LED_CONTROL_TEST_BUILD=y$' "$FIXTURE_ROOT/build-workdir/sdkconfig.build-gate"
grep -q '^CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID=65535$' "$FIXTURE_ROOT/build-workdir/sdkconfig.build-gate"
grep -q '^CONFIG_GPIO_CTRL_FUNC_IN_IRAM=y$' "$FIXTURE_ROOT/build-workdir/sdkconfig"
grep -q '^CONFIG_BLE_MESH_SETTINGS=y$' "$FIXTURE_ROOT/build-workdir/sdkconfig"
grep -q '^schema=led-control-test-artifact-v3$' "$FIXTURE_ROOT/build-workdir/build/led-control-artifact.manifest"
grep -q '^mode=test$' "$FIXTURE_ROOT/build-workdir/build/led-control-artifact.manifest"
grep -q '^company_id=65535$' "$FIXTURE_ROOT/build-workdir/build/led-control-artifact.manifest"
grep -q '^bootloader_sha256=' "$FIXTURE_ROOT/build-workdir/build/led-control-artifact.manifest"
grep -q '^partition_table_sha256=' "$FIXTURE_ROOT/build-workdir/build/led-control-artifact.manifest"
grep -q '^ota_data_sha256=' "$FIXTURE_ROOT/build-workdir/build/led-control-artifact.manifest"
grep -q '^esp_idf_version=v5.5.1$' "$FIXTURE_ROOT/build-workdir/build/led-control-artifact.manifest"
grep -q "^esp_idf_commit=$PINNED_IDF_COMMIT$" "$FIXTURE_ROOT/build-workdir/build/led-control-artifact.manifest"
grep -Eq '^esp_idf_patch_sha256=[0-9a-f]{64}$' "$FIXTURE_ROOT/build-workdir/build/led-control-artifact.manifest"
grep -Eq '^esp_idf_patch_identity_sha256=[0-9a-f]{64}$' "$FIXTURE_ROOT/build-workdir/build/led-control-artifact.manifest"
grep -q 'ESP-IDF v5.5.1' "$FIXTURE_ROOT/test-build.out"
grep -q "must not be flashed for HIL or production" "$FIXTURE_ROOT/test-build.out"

run_build --lab-hil-build >"$FIXTURE_ROOT/lab-hil-build.out" 2>&1
grep -q '^CONFIG_LED_CONTROL_TEST_BUILD=n$' "$FIXTURE_ROOT/build-workdir/sdkconfig.build-gate"
grep -q '^CONFIG_LED_CONTROL_LAB_HIL_BUILD=y$' "$FIXTURE_ROOT/build-workdir/sdkconfig.build-gate"
grep -q '^CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID=65534$' "$FIXTURE_ROOT/build-workdir/sdkconfig.build-gate"
grep -q '^schema=led-control-lab-hil-artifact-v1$' "$FIXTURE_ROOT/build-workdir/build/led-control-artifact.manifest"
grep -q '^mode=lab-hil$' "$FIXTURE_ROOT/build-workdir/build/led-control-artifact.manifest"
grep -q '^company_id=65534$' "$FIXTURE_ROOT/build-workdir/build/led-control-artifact.manifest"
grep -q "LAB HIL ONLY: non-production RFU Company ID 0xFFFE" "$FIXTURE_ROOT/lab-hil-build.out"

if env \
  IDF_PATH="$FIXTURE_ROOT/idf" \
  ESP32_H2_BUILD_WORKDIR="$FIXTURE_ROOT/build-workdir" \
  ESP32_H2_BUILD_GATE_CALLS="$FIXTURE_ROOT/idf-calls" \
  "$REPO_ROOT/scripts/esp32-h2-flash.sh" /dev/null >"$FIXTURE_ROOT/flash-lab-as-production.out" 2>&1; then
  echo "production flash unexpectedly accepted a Lab HIL build" >&2
  exit 1
fi
grep -q "Refusing to flash a Lab HIL build" "$FIXTURE_ROOT/flash-lab-as-production.out"

if ! env \
  PATH="$FIXTURE_ROOT/bin:$PATH" \
  IDF_PATH="$FIXTURE_ROOT/idf" \
  ESP32_H2_BUILD_WORKDIR="$FIXTURE_ROOT/build-workdir" \
  ESP32_H2_BUILD_GATE_CALLS="$FIXTURE_ROOT/idf-calls" \
  "$REPO_ROOT/scripts/esp32-h2-lab-hil-flash.sh" /dev/null >"$FIXTURE_ROOT/flash-lab-hil.out" 2>&1; then
  cat "$FIXTURE_ROOT/flash-lab-hil.out" >&2
  exit 1
fi
grep -q '^verify-lab-hil ' "$FIXTURE_ROOT/flash-lab-hil.out"
grep -q 'flash monitor' "$FIXTURE_ROOT/idf-calls"
run_build --test-build >"$FIXTURE_ROOT/test-build-restored.out" 2>&1

CALLS_BEFORE_WRONG_SOURCE="$(wc -l <"$FIXTURE_ROOT/idf-calls" | tr -d ' ')"
printf '\nwrong source\n' >>"$FIXTURE_ROOT/idf/$BTC_TASK_PATH"
if run_build --test-build >"$FIXTURE_ROOT/wrong-idf-source.out" 2>&1; then
  echo "build unexpectedly accepted a wrong ESP-IDF source hash" >&2
  exit 1
fi
grep -q 'btc_task.c upstream SHA-256 mismatch' "$FIXTURE_ROOT/wrong-idf-source.out"
test "$(wc -l <"$FIXTURE_ROOT/idf-calls" | tr -d ' ')" = "$CALLS_BEFORE_WRONG_SOURCE"

if env \
  IDF_PATH="$FIXTURE_ROOT/idf" \
  ESP32_H2_BUILD_WORKDIR="$FIXTURE_ROOT/build-workdir" \
  ESP32_H2_BUILD_GATE_CALLS="$FIXTURE_ROOT/idf-calls" \
  "$REPO_ROOT/scripts/esp32-h2-flash.sh" /dev/null >"$FIXTURE_ROOT/flash-test.out" 2>&1; then
  echo "flash unexpectedly accepted a test build" >&2
  exit 1
fi
grep -q "Refusing to flash a test-build binary" "$FIXTURE_ROOT/flash-test.out"
