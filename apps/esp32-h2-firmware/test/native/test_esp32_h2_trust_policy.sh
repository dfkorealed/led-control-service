#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
FIXTURE_ROOT="$(mktemp -d)"
trap 'rm -rf "$FIXTURE_ROOT"' EXIT

COMPANY_ID=4660
SOURCE_COMMIT=0123456789abcdef0123456789abcdef01234567
SDKCONFIG="$FIXTURE_ROOT/sdkconfig"
PARTITIONS="$FIXTURE_ROOT/partitions.csv"
APPROVAL="$FIXTURE_ROOT/approval.manifest"
APPROVAL_SIGNATURE="$FIXTURE_ROOT/approval.sig"
TEST_POLICY="$FIXTURE_ROOT/test-trust-policy.conf"

printf 'CONFIG_LED_CONTROL_TEST_BUILD=n\nCONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID=%s\n' "$COMPANY_ID" >"$SDKCONFIG"
cp "$REPO_ROOT/apps/esp32-h2-firmware/partitions.csv" "$PARTITIONS"

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$FIXTURE_ROOT/approval.key.pem" >/dev/null 2>&1
openssl pkey -in "$FIXTURE_ROOT/approval.key.pem" -pubout -out "$FIXTURE_ROOT/approval.pub.pem" >/dev/null 2>&1
APPROVAL_KEY_SHA256="$(openssl pkey -pubin -in "$FIXTURE_ROOT/approval.pub.pem" -outform DER 2>/dev/null | openssl dgst -sha256 | awk '{print $NF}')"

cat >"$FIXTURE_ROOT/legacy-approval.manifest" <<EOF
schema=led-control-manufacturing-approval-v1
product=led-control-esp32-h2
mode=production
company_id=$COMPANY_ID
EOF
openssl dgst -sha256 -sign "$FIXTURE_ROOT/approval.key.pem" -out "$FIXTURE_ROOT/legacy-approval.sig" "$FIXTURE_ROOT/legacy-approval.manifest"

if env \
  LED_CONTROL_MANUFACTURING_APPROVAL_MANIFEST="$FIXTURE_ROOT/legacy-approval.manifest" \
  LED_CONTROL_MANUFACTURING_APPROVAL_SIGNATURE="$FIXTURE_ROOT/legacy-approval.sig" \
  LED_CONTROL_MANUFACTURING_APPROVAL_PUBLIC_KEY="$FIXTURE_ROOT/approval.pub.pem" \
  LED_CONTROL_MANUFACTURING_APPROVAL_PUBLIC_KEY_SHA256="$APPROVAL_KEY_SHA256" \
  "$REPO_ROOT/scripts/esp32-h2-manufacturing-approval.sh" "$COMPANY_ID" \
  >"$FIXTURE_ROOT/self-approved.out" 2>&1; then
  echo "caller-selected trust root unexpectedly self-approved production" >&2
  exit 1
fi

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

SDKCONFIG_SHA256="$(openssl dgst -sha256 "$SDKCONFIG" | awk '{print $NF}')"
PARTITIONS_SHA256="$(openssl dgst -sha256 "$PARTITIONS" | awk '{print $NF}')"
cat >"$APPROVAL" <<EOF
schema=led-control-manufacturing-approval-v2
product=led-control-esp32-h2
mode=production
company_id=$COMPANY_ID
source_commit=$SOURCE_COMMIT
sdkconfig_sha256=$SDKCONFIG_SHA256
partitions_sha256=$PARTITIONS_SHA256
EOF
openssl dgst -sha256 -sign "$FIXTURE_ROOT/approval.key.pem" -out "$APPROVAL_SIGNATURE" "$APPROVAL"

"$REPO_ROOT/scripts/esp32-h2-manufacturing-approval.sh" \
  verify-test-only \
  "$TEST_POLICY" \
  "$COMPANY_ID" \
  "$SOURCE_COMMIT" \
  "$SDKCONFIG" \
  "$PARTITIONS" \
  "$APPROVAL" \
  "$APPROVAL_SIGNATURE"

if "$REPO_ROOT/scripts/esp32-h2-manufacturing-approval.sh" \
  verify-test-only \
  "$TEST_POLICY" \
  65534 \
  "$SOURCE_COMMIT" \
  "$SDKCONFIG" \
  "$PARTITIONS" \
  "$APPROVAL" \
  "$APPROVAL_SIGNATURE" \
  >"$FIXTURE_ROOT/lab-company-id.out" 2>&1; then
  echo "manufacturing approval unexpectedly accepted the Lab HIL Company ID" >&2
  exit 1
fi
grep -q "manufacturing approval has an invalid Company ID" "$FIXTURE_ROOT/lab-company-id.out"

if "$REPO_ROOT/scripts/esp32-h2-manufacturing-approval.sh" \
  verify-test-only \
  "$TEST_POLICY" \
  "$COMPANY_ID" \
  fedcba9876543210fedcba9876543210fedcba98 \
  "$SDKCONFIG" \
  "$PARTITIONS" \
  "$APPROVAL" \
  "$APPROVAL_SIGNATURE" \
  >"$FIXTURE_ROOT/source-mismatch.out" 2>&1; then
  echo "approval unexpectedly accepted a different source commit" >&2
  exit 1
fi
grep -q "does not exactly match" "$FIXTURE_ROOT/source-mismatch.out"

grep -q '^state=unprovisioned$' "$REPO_ROOT/apps/esp32-h2-firmware/manufacturing/production-trust-policy.conf"
if "$REPO_ROOT/scripts/esp32-h2-manufacturing-approval.sh" check-production-policy >"$FIXTURE_ROOT/unprovisioned.out" 2>&1; then
  echo "unprovisioned production trust policy unexpectedly passed" >&2
  exit 1
fi
grep -q "production trust root is not provisioned" "$FIXTURE_ROOT/unprovisioned.out"
