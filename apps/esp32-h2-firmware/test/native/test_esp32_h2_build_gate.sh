#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
FIXTURE_ROOT="$(mktemp -d)"
trap 'rm -rf "$FIXTURE_ROOT"' EXIT

mkdir -p "$FIXTURE_ROOT/idf"
cat >"$FIXTURE_ROOT/idf/export.sh" <<'EOF'
idf.py() {
  printf '%s\n' "$*" >>"$ESP32_H2_BUILD_GATE_CALLS"
  if [[ "$*" == *"set-target esp32h2" ]]; then
    cp sdkconfig.build-gate sdkconfig
    cat sdkconfig.defaults >>sdkconfig
  elif [ "$*" = "build" ]; then
    mkdir -p build
    printf 'firmware fixture\n' >build/led_control_node.bin
    cat >build/led_control_node.map <<'MAP'
                0x40801000                vehicle_sensor_gpio_isr
                0x40802000                gpio_get_level
                0x40803000                esp_timer_get_time
                0x40804000                xQueueGenericSendFromISR
MAP
    cat >build/flash_args <<'ARGS'
--flash_mode dio --flash_freq 48m --flash_size 4MB
0x0 bootloader/bootloader.bin
0x10000 led_control_node.bin
0x8000 partition_table/partition-table.bin
0xd000 ota_data_initial.bin
ARGS
  fi
}
EOF

run_build() {
  env \
    IDF_PATH="$FIXTURE_ROOT/idf" \
    ESP32_H2_BUILD_WORKDIR="$FIXTURE_ROOT/build-workdir" \
    ESP32_H2_BUILD_GATE_CALLS="$FIXTURE_ROOT/idf-calls" \
    "$REPO_ROOT/scripts/esp32-h2-build.sh" "$@"
}

run_production_build() {
  env \
    CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID="${1:-4660}" \
    LED_CONTROL_MANUFACTURING_APPROVAL_MANIFEST="$FIXTURE_ROOT/approval.manifest" \
    LED_CONTROL_MANUFACTURING_APPROVAL_SIGNATURE="$FIXTURE_ROOT/approval.sig" \
    LED_CONTROL_MANUFACTURING_APPROVAL_PUBLIC_KEY="$FIXTURE_ROOT/approval.pub.pem" \
    LED_CONTROL_MANUFACTURING_APPROVAL_PUBLIC_KEY_SHA256="$TRUSTED_KEY_SHA256" \
    IDF_PATH="$FIXTURE_ROOT/idf" \
    ESP32_H2_BUILD_WORKDIR="$FIXTURE_ROOT/build-workdir" \
    ESP32_H2_BUILD_GATE_CALLS="$FIXTURE_ROOT/idf-calls" \
    "$REPO_ROOT/scripts/esp32-h2-build.sh"
}

run_flash() {
  env \
    LED_CONTROL_MANUFACTURING_APPROVAL_MANIFEST="$FIXTURE_ROOT/approval.manifest" \
    LED_CONTROL_MANUFACTURING_APPROVAL_SIGNATURE="$FIXTURE_ROOT/approval.sig" \
    LED_CONTROL_MANUFACTURING_APPROVAL_PUBLIC_KEY="$FIXTURE_ROOT/approval.pub.pem" \
    LED_CONTROL_MANUFACTURING_APPROVAL_PUBLIC_KEY_SHA256="$TRUSTED_KEY_SHA256" \
    IDF_PATH="$FIXTURE_ROOT/idf" \
    ESP32_H2_BUILD_WORKDIR="$FIXTURE_ROOT/build-workdir" \
    ESP32_H2_BUILD_GATE_CALLS="$FIXTURE_ROOT/idf-calls" \
    "$REPO_ROOT/scripts/esp32-h2-flash.sh" /dev/null
}

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$FIXTURE_ROOT/approval.key.pem" >/dev/null 2>&1
openssl pkey -in "$FIXTURE_ROOT/approval.key.pem" -pubout -out "$FIXTURE_ROOT/approval.pub.pem" >/dev/null 2>&1
TRUSTED_KEY_SHA256="$(openssl pkey -pubin -in "$FIXTURE_ROOT/approval.pub.pem" -outform DER 2>/dev/null | openssl dgst -sha256 | awk '{print $NF}')"
cat >"$FIXTURE_ROOT/approval.manifest" <<'MANIFEST'
schema=led-control-manufacturing-approval-v1
product=led-control-esp32-h2
mode=production
company_id=4660
MANIFEST
openssl dgst -sha256 -sign "$FIXTURE_ROOT/approval.key.pem" -out "$FIXTURE_ROOT/approval.sig" "$FIXTURE_ROOT/approval.manifest"

if run_build >"$FIXTURE_ROOT/production-missing.out" 2>&1; then
  echo "production build unexpectedly accepted a missing Company ID" >&2
  exit 1
fi
grep -q "production build requires" "$FIXTURE_ROOT/production-missing.out"
test ! -e "$FIXTURE_ROOT/idf-calls"

if CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID=4660 run_build >"$FIXTURE_ROOT/production-unapproved.out" 2>&1; then
  echo "production build unexpectedly accepted an unsigned Company ID" >&2
  exit 1
fi
grep -q "signed manufacturing approval" "$FIXTURE_ROOT/production-unapproved.out"

cp "$FIXTURE_ROOT/approval.sig" "$FIXTURE_ROOT/approval.sig.valid"
head -c 1 "$FIXTURE_ROOT/approval.sig.valid" >"$FIXTURE_ROOT/approval.sig"
if run_production_build 4660 >"$FIXTURE_ROOT/production-signature.out" 2>&1; then
  echo "production build unexpectedly accepted a bad manufacturing signature" >&2
  exit 1
fi
grep -q "signature verification failed" "$FIXTURE_ROOT/production-signature.out"
mv "$FIXTURE_ROOT/approval.sig.valid" "$FIXTURE_ROOT/approval.sig"

if env \
  CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID=4660 \
  LED_CONTROL_MANUFACTURING_APPROVAL_MANIFEST="$FIXTURE_ROOT/approval.manifest" \
  LED_CONTROL_MANUFACTURING_APPROVAL_SIGNATURE="$FIXTURE_ROOT/approval.sig" \
  LED_CONTROL_MANUFACTURING_APPROVAL_PUBLIC_KEY="$FIXTURE_ROOT/approval.pub.pem" \
  LED_CONTROL_MANUFACTURING_APPROVAL_PUBLIC_KEY_SHA256="$(printf '0%.0s' {1..64})" \
  IDF_PATH="$FIXTURE_ROOT/idf" \
  ESP32_H2_BUILD_WORKDIR="$FIXTURE_ROOT/build-workdir" \
  ESP32_H2_BUILD_GATE_CALLS="$FIXTURE_ROOT/idf-calls" \
  "$REPO_ROOT/scripts/esp32-h2-build.sh" >"$FIXTURE_ROOT/production-trust-anchor.out" 2>&1; then
  echo "production build unexpectedly accepted an untrusted manufacturing key" >&2
  exit 1
fi
grep -q "does not match the trusted SHA-256" "$FIXTURE_ROOT/production-trust-anchor.out"

run_build --test-build >"$FIXTURE_ROOT/test-build.out" 2>&1
grep -q '^CONFIG_LED_CONTROL_TEST_BUILD=y$' "$FIXTURE_ROOT/build-workdir/sdkconfig.build-gate"
grep -q '^CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID=65535$' "$FIXTURE_ROOT/build-workdir/sdkconfig.build-gate"
grep -q '^CONFIG_GPIO_CTRL_FUNC_IN_IRAM=y$' "$FIXTURE_ROOT/build-workdir/sdkconfig"
grep -q '^mode=test$' "$FIXTURE_ROOT/build-workdir/build/led-control-artifact.manifest"
grep -q '^company_id=65535$' "$FIXTURE_ROOT/build-workdir/build/led-control-artifact.manifest"
grep -q "must not be flashed for HIL or production" "$FIXTURE_ROOT/test-build.out"

rm -f "$FIXTURE_ROOT/idf-calls"
run_production_build 4660 >"$FIXTURE_ROOT/production.out" 2>&1
grep -q '^CONFIG_LED_CONTROL_TEST_BUILD=n$' "$FIXTURE_ROOT/build-workdir/sdkconfig.build-gate"
grep -q '^CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID=4660$' "$FIXTURE_ROOT/build-workdir/sdkconfig.build-gate"
grep -q '^mode=production$' "$FIXTURE_ROOT/build-workdir/build/led-control-artifact.manifest"
grep -q '^company_id=4660$' "$FIXTURE_ROOT/build-workdir/build/led-control-artifact.manifest"

if run_production_build 4661 >"$FIXTURE_ROOT/production-mismatch.out" 2>&1; then
  echo "production build unexpectedly accepted a CID not approved by the signed manifest" >&2
  exit 1
fi
grep -q "does not match signed manufacturing approval" "$FIXTURE_ROOT/production-mismatch.out"

for invalid in 0 741 65535 invalid; do
  if CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID="$invalid" run_build >"$FIXTURE_ROOT/invalid.out" 2>&1; then
    echo "production build unexpectedly accepted Company ID $invalid" >&2
    exit 1
  fi
done

rm -f "$FIXTURE_ROOT/idf-calls"
run_flash >"$FIXTURE_ROOT/flash-production.out" 2>&1
grep -q -- '-p /dev/null flash monitor' "$FIXTURE_ROOT/idf-calls"

printf 'tampered firmware\n' >>"$FIXTURE_ROOT/build-workdir/build/led_control_node.bin"
if run_flash >"$FIXTURE_ROOT/flash-tampered-binary.out" 2>&1; then
  echo "flash unexpectedly accepted a binary hash mismatch" >&2
  exit 1
fi
grep -q "artifact binary hash mismatch" "$FIXTURE_ROOT/flash-tampered-binary.out"

run_production_build 4660 >/dev/null 2>&1
printf '\n# tampered\n' >>"$FIXTURE_ROOT/build-workdir/sdkconfig"
if run_flash >"$FIXTURE_ROOT/flash-tampered-sdkconfig.out" 2>&1; then
  echo "flash unexpectedly accepted an sdkconfig hash mismatch" >&2
  exit 1
fi
grep -q "artifact sdkconfig hash mismatch" "$FIXTURE_ROOT/flash-tampered-sdkconfig.out"

run_production_build 4660 >/dev/null 2>&1
sed -i.bak 's/^company_id=4660$/company_id=4661/' "$FIXTURE_ROOT/build-workdir/build/led-control-artifact.manifest"
if run_flash >"$FIXTURE_ROOT/flash-tampered-manifest.out" 2>&1; then
  echo "flash unexpectedly accepted an artifact CID mismatch" >&2
  exit 1
fi
grep -q "artifact Company ID mismatch" "$FIXTURE_ROOT/flash-tampered-manifest.out"

run_build --test-build >/dev/null 2>&1
if run_flash >"$FIXTURE_ROOT/flash-test.out" 2>&1; then
  echo "flash unexpectedly accepted a test build" >&2
  exit 1
fi
grep -q "Refusing to flash a test-build binary" "$FIXTURE_ROOT/flash-test.out"
