#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: scripts/esp32-h2-manufacturing-approval.sh COMPANY_ID" >&2
  exit 2
fi

COMPANY_ID="$1"
MANIFEST="${LED_CONTROL_MANUFACTURING_APPROVAL_MANIFEST:-}"
SIGNATURE="${LED_CONTROL_MANUFACTURING_APPROVAL_SIGNATURE:-}"
PUBLIC_KEY="${LED_CONTROL_MANUFACTURING_APPROVAL_PUBLIC_KEY:-}"
TRUSTED_KEY_SHA256="${LED_CONTROL_MANUFACTURING_APPROVAL_PUBLIC_KEY_SHA256:-}"

for path in "$MANIFEST" "$SIGNATURE" "$PUBLIC_KEY"; do
  if [ -z "$path" ] || [ ! -f "$path" ]; then
    echo "production build requires a signed manufacturing approval manifest and trusted public key" >&2
    exit 1
  fi
done

if ! [[ "$TRUSTED_KEY_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "production build requires the trusted manufacturing approval public-key SHA-256" >&2
  exit 1
fi

ACTUAL_KEY_SHA256="$(openssl pkey -pubin -in "$PUBLIC_KEY" -outform DER 2>/dev/null | openssl dgst -sha256 | awk '{print $NF}')"
if [ "$ACTUAL_KEY_SHA256" != "$TRUSTED_KEY_SHA256" ]; then
  echo "manufacturing approval public key does not match the trusted SHA-256" >&2
  exit 1
fi

if ! openssl dgst -sha256 -verify "$PUBLIC_KEY" -signature "$SIGNATURE" "$MANIFEST" >/dev/null 2>&1; then
  echo "manufacturing approval signature verification failed" >&2
  exit 1
fi

EXPECTED_MANIFEST="$(printf 'schema=led-control-manufacturing-approval-v1\nproduct=led-control-esp32-h2\nmode=production\ncompany_id=%s\n' "$COMPANY_ID")"
if [ "$(cat "$MANIFEST")" != "$EXPECTED_MANIFEST" ]; then
  echo "Company ID $COMPANY_ID does not match signed manufacturing approval" >&2
  exit 1
fi

openssl dgst -sha256 "$MANIFEST" | awk '{print $NF}'
