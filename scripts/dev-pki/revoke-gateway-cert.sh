#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# -ne 1 ]]; then
  echo "사용법: $0 <gateway-certificate-path>" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PKI_DIR="${PKI_DIR:-$ROOT_DIR/.local/pki}"
openssl ca -batch -config "$PKI_DIR/openssl.cnf" -revoke "$1"
openssl ca -config "$PKI_DIR/openssl.cnf" -gencrl -out "$PKI_DIR/ca.crl"
printf '인증서를 폐기하고 CRL을 갱신했습니다. Mosquitto를 재시작하세요.\n'
