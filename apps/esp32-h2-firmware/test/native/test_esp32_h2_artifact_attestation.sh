#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
FIXTURE_ROOT="$(mktemp -d)"
trap 'rm -rf "$FIXTURE_ROOT"' EXIT

COMPANY_ID=4660
SOURCE_COMMIT=0123456789abcdef0123456789abcdef01234567
BUILD_ROOT="$FIXTURE_ROOT/workdir"
BUILD_DIR="$BUILD_ROOT/build"
APPROVAL="$FIXTURE_ROOT/approval.manifest"
APPROVAL_SIGNATURE="$FIXTURE_ROOT/approval.sig"
TEST_POLICY="$FIXTURE_ROOT/test-trust-policy.conf"
PATCH_GATE="$REPO_ROOT/scripts/esp32-h2-idf-patch.sh"

mkdir -p "$BUILD_DIR/bootloader" "$BUILD_DIR/partition_table"
printf 'firmware\n' >"$BUILD_DIR/led_control_node.bin"
printf 'bootloader\n' >"$BUILD_DIR/bootloader/bootloader.bin"
printf 'partition table\n' >"$BUILD_DIR/partition_table/partition-table.bin"
printf 'blank ota data\n' >"$BUILD_DIR/ota_data_initial.bin"
cat >"$BUILD_DIR/led_control_node.map" <<'EOF'
                0x40801000                vehicle_sensor_gpio_isr
                0x40802000                gpio_get_level
                0x40803000                esp_timer_get_time
                0x40804000                xQueueGenericSendFromISR
EOF
cat >"$BUILD_DIR/flash_args" <<'EOF'
--flash_mode dio --flash_freq 48m --flash_size 4MB
0x0 bootloader/bootloader.bin
0x8000 partition_table/partition-table.bin
0xd000 ota_data_initial.bin
0x10000 led_control_node.bin
EOF
printf 'CONFIG_GPIO_CTRL_FUNC_IN_IRAM=y\nCONFIG_BLE_MESH_SETTINGS=y\nCONFIG_LED_CONTROL_TEST_BUILD=n\nCONFIG_LED_CONTROL_LAB_HIL_BUILD=n\nCONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID=%s\n' "$COMPANY_ID" >"$BUILD_ROOT/sdkconfig"
cp "$REPO_ROOT/apps/esp32-h2-firmware/partitions.csv" "$BUILD_ROOT/partitions.csv"
"$PATCH_GATE" write-identity "$BUILD_ROOT/esp-idf-patch.identity"

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$FIXTURE_ROOT/approval.key.pem" >/dev/null 2>&1
openssl pkey -in "$FIXTURE_ROOT/approval.key.pem" -pubout -out "$FIXTURE_ROOT/approval.pub.pem" >/dev/null 2>&1
APPROVAL_KEY_SHA256="$(openssl pkey -pubin -in "$FIXTURE_ROOT/approval.pub.pem" -outform DER 2>/dev/null | openssl dgst -sha256 | awk '{print $NF}')"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$FIXTURE_ROOT/attestation.key.pem" >/dev/null 2>&1
openssl pkey -in "$FIXTURE_ROOT/attestation.key.pem" -pubout -out "$FIXTURE_ROOT/attestation.pub.pem" >/dev/null 2>&1
ATTESTATION_KEY_SHA256="$(openssl pkey -pubin -in "$FIXTURE_ROOT/attestation.pub.pem" -outform DER 2>/dev/null | openssl dgst -sha256 | awk '{print $NF}')"

cat >"$TEST_POLICY" <<EOF
schema=led-control-trust-policy-v1
state=test-only
approval_public_key=$FIXTURE_ROOT/approval.pub.pem
approval_public_key_sha256=$APPROVAL_KEY_SHA256
attestation_public_key=$FIXTURE_ROOT/attestation.pub.pem
attestation_public_key_sha256=$ATTESTATION_KEY_SHA256
attestation_private_key=$FIXTURE_ROOT/attestation.key.pem
EOF

cat >"$APPROVAL" <<EOF
schema=led-control-manufacturing-approval-v2
product=led-control-esp32-h2
mode=production
company_id=$COMPANY_ID
source_commit=$SOURCE_COMMIT
sdkconfig_sha256=$(openssl dgst -sha256 "$BUILD_ROOT/sdkconfig" | awk '{print $NF}')
partitions_sha256=$(openssl dgst -sha256 "$BUILD_ROOT/partitions.csv" | awk '{print $NF}')
EOF
openssl dgst -sha256 -sign "$FIXTURE_ROOT/approval.key.pem" -out "$APPROVAL_SIGNATURE" "$APPROVAL"

audit_fixture() {
  "$REPO_ROOT/scripts/esp32-h2-artifact-audit.sh" \
    "$1-test-only-attestation" \
    "$TEST_POLICY" \
    "$BUILD_ROOT" \
    "$COMPANY_ID" \
    "$SOURCE_COMMIT" \
    "$APPROVAL" \
    "$APPROVAL_SIGNATURE"
}

printf 'schema=led-control-test-artifact-v3\nmode=test\n' >"$BUILD_DIR/led-control-artifact.manifest"
audit_fixture create
test ! -e "$BUILD_DIR/led-control-artifact.manifest"
audit_fixture verify

ATTESTATION="$BUILD_DIR/led-control-artifact.attestation"
ATTESTATION_SIGNATURE="$BUILD_DIR/led-control-artifact.attestation.sig"
grep -q '^schema=led-control-artifact-attestation-v2$' "$ATTESTATION"
grep -q '^approval_manifest_sha256=' "$ATTESTATION"
grep -q '^approval_signature_sha256=' "$ATTESTATION"
grep -q '^approval_signer_sha256=' "$ATTESTATION"
grep -q '^binary_sha256=' "$ATTESTATION"
grep -q '^bootloader_sha256=' "$ATTESTATION"
grep -q '^partition_table_sha256=' "$ATTESTATION"
grep -q '^ota_data_sha256=' "$ATTESTATION"
grep -q '^esp_idf_version=v5.5.1$' "$ATTESTATION"
grep -Eq '^esp_idf_patch_sha256=[0-9a-f]{64}$' "$ATTESTATION"
grep -Eq '^esp_idf_patch_identity_sha256=[0-9a-f]{64}$' "$ATTESTATION"
openssl dgst -sha256 -verify "$FIXTURE_ROOT/attestation.pub.pem" -signature "$ATTESTATION_SIGNATURE" "$ATTESTATION" >/dev/null

cp "$BUILD_ROOT/esp-idf-patch.identity" "$FIXTURE_ROOT/esp-idf-patch.identity.valid"
sed 's/^patch_sha256=.*/patch_sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/' \
  "$FIXTURE_ROOT/esp-idf-patch.identity.valid" >"$BUILD_ROOT/esp-idf-patch.identity"
if audit_fixture verify >"$FIXTURE_ROOT/patch-identity.out" 2>&1; then
  echo "attestation unexpectedly accepted a tampered ESP-IDF patch identity" >&2
  exit 1
fi
grep -q 'ESP-IDF patch identity patch_sha256 mismatch' "$FIXTURE_ROOT/patch-identity.out"
mv "$FIXTURE_ROOT/esp-idf-patch.identity.valid" "$BUILD_ROOT/esp-idf-patch.identity"

cp "$BUILD_DIR/led_control_node.bin" "$FIXTURE_ROOT/firmware.valid"
dd if=/dev/zero of="$BUILD_DIR/led_control_node.bin" bs=1 count=1700000 2>/dev/null
if audit_fixture create >"$FIXTURE_ROOT/margin.out" 2>&1; then
  echo "attestation unexpectedly accepted insufficient production OTA margin" >&2
  exit 1
fi
grep -q "production OTA free margin" "$FIXTURE_ROOT/margin.out"
mv "$FIXTURE_ROOT/firmware.valid" "$BUILD_DIR/led_control_node.bin"

for entry in \
  "led_control_node.bin:binary" \
  "bootloader/bootloader.bin:bootloader" \
  "partition_table/partition-table.bin:partition table" \
  "ota_data_initial.bin:OTA data"; do
  path="${entry%%:*}"
  label="${entry#*:}"
  cp "$BUILD_DIR/$path" "$FIXTURE_ROOT/original.bin"
  printf 'tamper\n' >>"$BUILD_DIR/$path"
  if audit_fixture verify >"$FIXTURE_ROOT/tamper.out" 2>&1; then
    echo "attestation unexpectedly accepted tampered $label" >&2
    exit 1
  fi
  grep -q "$label hash mismatch" "$FIXTURE_ROOT/tamper.out"
  mv "$FIXTURE_ROOT/original.bin" "$BUILD_DIR/$path"
done

cp "$ATTESTATION" "$FIXTURE_ROOT/attestation.valid"
sed 's/^company_id=.*/company_id=1/' "$FIXTURE_ROOT/attestation.valid" >"$ATTESTATION"
if audit_fixture verify >"$FIXTURE_ROOT/attestation-tamper.out" 2>&1; then
  echo "attestation unexpectedly accepted edited identity" >&2
  exit 1
fi
grep -q "attestation signature verification failed" "$FIXTURE_ROOT/attestation-tamper.out"
