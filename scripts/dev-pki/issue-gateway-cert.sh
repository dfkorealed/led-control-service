#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# -ne 1 ]]; then
  echo "사용법: $0 <gateway-id>" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PKI_DIR="${PKI_DIR:-$ROOT_DIR/.local/pki}"
GATEWAY_ID="$1"
SAFE_NAME="gateway-${GATEWAY_ID//[^a-zA-Z0-9._-]/_}"
test -f "$PKI_DIR/ca.key" || { echo "먼저 create-ca.sh를 실행하세요." >&2; exit 1; }

openssl genrsa -out "$PKI_DIR/$SAFE_NAME.key" 2048
openssl req -new -key "$PKI_DIR/$SAFE_NAME.key" -out "$PKI_DIR/$SAFE_NAME.csr" -subj "/CN=$GATEWAY_ID"
openssl ca -batch -config "$PKI_DIR/openssl.cnf" -extensions client_cert -in "$PKI_DIR/$SAFE_NAME.csr" -out "$PKI_DIR/$SAFE_NAME.crt"
rm -f "$PKI_DIR/$SAFE_NAME.csr"
chmod 600 "$PKI_DIR/$SAFE_NAME.key"
openssl x509 -in "$PKI_DIR/$SAFE_NAME.crt" -noout -fingerprint -sha256
printf '인증서: %s\n키: %s\n' "$PKI_DIR/$SAFE_NAME.crt" "$PKI_DIR/$SAFE_NAME.key"
