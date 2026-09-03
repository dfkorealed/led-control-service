#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRODUCTION_POLICY="$REPO_ROOT/apps/esp32-h2-firmware/manufacturing/production-trust-policy.conf"

usage() {
  echo "Usage: scripts/esp32-h2-manufacturing-approval.sh check-production-policy" >&2
  echo "   or: scripts/esp32-h2-manufacturing-approval.sh verify-production COMPANY_ID SOURCE_COMMIT SDKCONFIG PARTITIONS MANIFEST SIGNATURE" >&2
  echo "   or: scripts/esp32-h2-manufacturing-approval.sh verify-test-only POLICY COMPANY_ID SOURCE_COMMIT SDKCONFIG PARTITIONS MANIFEST SIGNATURE" >&2
  exit 2
}

hash_file() {
  openssl dgst -sha256 "$1" | awk '{print $NF}'
}

policy_value() {
  local key="$1"
  local policy="$2"
  local values
  values="$(sed -n "s/^${key}=//p" "$policy")"
  if [ "$(printf '%s\n' "$values" | sed '/^$/d' | wc -l | tr -d ' ')" -ne 1 ]; then
    echo "trust policy has invalid $key" >&2
    exit 1
  fi
  printf '%s\n' "$values"
}

load_policy() {
  local policy="$1"
  local required_state="$2"

  if [ ! -f "$policy" ]; then
    echo "production trust policy is missing" >&2
    exit 1
  fi
  if [ "$(policy_value schema "$policy")" != "led-control-trust-policy-v1" ]; then
    echo "trust policy schema mismatch" >&2
    exit 1
  fi

  local state
  state="$(policy_value state "$policy")"
  if [ "$state" = "unprovisioned" ]; then
    echo "production trust root is not provisioned" >&2
    exit 1
  fi
  if [ "$state" != "$required_state" ]; then
    echo "trust policy state must be $required_state" >&2
    exit 1
  fi

  APPROVAL_PUBLIC_KEY="$(policy_value approval_public_key "$policy")"
  APPROVAL_PUBLIC_KEY_SHA256="$(policy_value approval_public_key_sha256 "$policy")"
  ATTESTATION_PUBLIC_KEY="$(policy_value attestation_public_key "$policy")"
  ATTESTATION_PUBLIC_KEY_SHA256="$(policy_value attestation_public_key_sha256 "$policy")"
  ATTESTATION_PRIVATE_KEY="$(policy_value attestation_private_key "$policy")"

  for path in "$APPROVAL_PUBLIC_KEY" "$ATTESTATION_PUBLIC_KEY"; do
    if [ ! -f "$path" ]; then
      echo "trust policy key is missing: $path" >&2
      exit 1
    fi
  done
  for fingerprint in "$APPROVAL_PUBLIC_KEY_SHA256" "$ATTESTATION_PUBLIC_KEY_SHA256"; do
    if ! [[ "$fingerprint" =~ ^[0-9a-f]{64}$ ]]; then
      echo "trust policy contains an invalid public-key SHA-256" >&2
      exit 1
    fi
  done

  local actual_approval_sha256
  local actual_attestation_sha256
  actual_approval_sha256="$(openssl pkey -pubin -in "$APPROVAL_PUBLIC_KEY" -outform DER 2>/dev/null | openssl dgst -sha256 | awk '{print $NF}')"
  actual_attestation_sha256="$(openssl pkey -pubin -in "$ATTESTATION_PUBLIC_KEY" -outform DER 2>/dev/null | openssl dgst -sha256 | awk '{print $NF}')"
  if [ "$actual_approval_sha256" != "$APPROVAL_PUBLIC_KEY_SHA256" ]; then
    echo "approval public key does not match fixed trust policy fingerprint" >&2
    exit 1
  fi
  if [ "$actual_attestation_sha256" != "$ATTESTATION_PUBLIC_KEY_SHA256" ]; then
    echo "attestation public key does not match fixed trust policy fingerprint" >&2
    exit 1
  fi
}

verify_approval() {
  local company_id="$1"
  local source_commit="$2"
  local sdkconfig="$3"
  local partitions="$4"
  local manifest="$5"
  local signature="$6"

  if ! [[ "$company_id" =~ ^[0-9]+$ ]] ||
      [ "$company_id" -le 0 ] ||
      [ "$company_id" -ge 65535 ] ||
      [ "$company_id" -eq 65534 ] ||
      [ "$company_id" -eq 741 ]; then
    echo "manufacturing approval has an invalid Company ID" >&2
    exit 1
  fi
  if ! [[ "$source_commit" =~ ^[0-9a-f]{40}$|^[0-9a-f]{64}$ ]]; then
    echo "manufacturing approval has an invalid source commit" >&2
    exit 1
  fi
  for path in "$sdkconfig" "$partitions" "$manifest" "$signature"; do
    if [ ! -f "$path" ]; then
      echo "manufacturing approval input is missing: $path" >&2
      exit 1
    fi
  done

  if ! openssl dgst -sha256 -verify "$APPROVAL_PUBLIC_KEY" -signature "$signature" "$manifest" >/dev/null 2>&1; then
    echo "manufacturing approval signature verification failed" >&2
    exit 1
  fi

  local expected
  expected="$(mktemp)"
  printf '%s\n' \
    "schema=led-control-manufacturing-approval-v2" \
    "product=led-control-esp32-h2" \
    "mode=production" \
    "company_id=$company_id" \
    "source_commit=$source_commit" \
    "sdkconfig_sha256=$(hash_file "$sdkconfig")" \
    "partitions_sha256=$(hash_file "$partitions")" \
    >"$expected"
  if ! cmp -s "$expected" "$manifest"; then
    rm -f "$expected"
    echo "manufacturing approval does not exactly match CID/source/config/partition inputs" >&2
    exit 1
  fi
  rm -f "$expected"

  printf 'approval_manifest_sha256=%s\n' "$(hash_file "$manifest")"
  printf 'approval_signature_sha256=%s\n' "$(hash_file "$signature")"
  printf 'approval_signer_sha256=%s\n' "$APPROVAL_PUBLIC_KEY_SHA256"
}

ACTION="${1:-}"
case "$ACTION" in
  check-production-policy)
    [ "$#" -eq 1 ] || usage
    load_policy "$PRODUCTION_POLICY" provisioned
    ;;
  verify-production)
    [ "$#" -eq 7 ] || usage
    load_policy "$PRODUCTION_POLICY" provisioned
    verify_approval "$2" "$3" "$4" "$5" "$6" "$7"
    ;;
  verify-test-only)
    [ "$#" -eq 8 ] || usage
    load_policy "$2" test-only
    verify_approval "$3" "$4" "$5" "$6" "$7" "$8"
    ;;
  *) usage ;;
esac
