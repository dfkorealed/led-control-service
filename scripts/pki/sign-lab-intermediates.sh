#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
PKI_ENV="${PKI_ENV:-}"
PKI_CSR_DIR="${PKI_CSR_DIR:-$ROOT_DIR/.local/vault-pki/csrs}"
LAB_ROOT_DIR="${LAB_ROOT_DIR:-$ROOT_DIR/.local/lab-pki/root}"
LAB_SIGNED_INTERMEDIATE_DIR="${LAB_SIGNED_INTERMEDIATE_DIR:-$ROOT_DIR/.local/lab-pki/intermediates}"
ROOT_KEY_PATH="$LAB_ROOT_DIR/root.key"
ROOT_CERT_PATH="$LAB_ROOT_DIR/root.crt"
ROOT_CONFIG_PATH="$LAB_ROOT_DIR/openssl.cnf"
ROOT_SERIAL_PATH="$LAB_ROOT_DIR/intermediate.srl"
PURPOSES=(gateway-device gateway-mqtt api-server)

die() {
  printf '[lab-intermediate-sign] %s\n' "$*" >&2
  exit 1
}

require_lab_environment() {
  [[ "$PKI_ENV" == "lab" ]] || die "이 명령은 PKI_ENV=lab에서만 실행할 수 있습니다."
  command -v openssl >/dev/null 2>&1 || die "OpenSSL 실행 파일을 찾을 수 없습니다."
  [[ -d "$PKI_CSR_DIR" && ! -L "$PKI_CSR_DIR" ]] || die "PKI_CSR_DIR은 symlink가 아닌 디렉터리여야 합니다."
  [[ ! -L "$LAB_ROOT_DIR" && ! -L "$LAB_SIGNED_INTERMEDIATE_DIR" ]] || die "Lab PKI 출력 경로 symlink는 허용하지 않습니다."
}

ensure_layout() {
  mkdir -p "$LAB_ROOT_DIR" "$LAB_SIGNED_INTERMEDIATE_DIR"
  chmod 0700 "$LAB_ROOT_DIR" "$LAB_SIGNED_INTERMEDIATE_DIR"
}

write_root_config() {
  [[ -f "$ROOT_CONFIG_PATH" ]] && return
  local temporary
  temporary="$(mktemp "$LAB_ROOT_DIR/.openssl.XXXXXX")"
  cat >"$temporary" <<'EOF'
[ req ]
distinguished_name = subject
x509_extensions = root_ca
prompt = no

[ subject ]
CN = LED Control Lab Root CA

[ root_ca ]
basicConstraints = critical, CA:true, pathlen:1
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always

[ intermediate_ca ]
basicConstraints = critical, CA:true, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
EOF
  chmod 0644 "$temporary"
  mv -f "$temporary" "$ROOT_CONFIG_PATH"
}

verify_root() {
  [[ -f "$ROOT_KEY_PATH" && ! -L "$ROOT_KEY_PATH" ]] || die "Lab Root private key가 없습니다."
  [[ -f "$ROOT_CERT_PATH" && ! -L "$ROOT_CERT_PATH" ]] || die "Lab Root certificate가 없습니다."
  [[ "$(stat -f '%Lp' "$ROOT_KEY_PATH" 2>/dev/null || stat -c '%a' "$ROOT_KEY_PATH")" == "600" ]] || die "Lab Root private key 권한은 0600이어야 합니다."
  openssl verify -CAfile "$ROOT_CERT_PATH" "$ROOT_CERT_PATH" >/dev/null 2>&1 || die "Lab Root certificate 검증에 실패했습니다."
  openssl x509 -in "$ROOT_CERT_PATH" -noout -text | grep -Fq "CA:TRUE, pathlen:1" || die "Lab Root pathlen이 올바르지 않습니다."
}

ensure_root() {
  write_root_config
  if [[ -e "$ROOT_KEY_PATH" || -e "$ROOT_CERT_PATH" ]]; then
    verify_root
    return
  fi

  local temporary_key temporary_cert
  temporary_key="$(mktemp "$LAB_ROOT_DIR/.root-key.XXXXXX")"
  temporary_cert="$(mktemp "$LAB_ROOT_DIR/.root-cert.XXXXXX")"
  if ! openssl ecparam -name prime256v1 -genkey -noout -out "$temporary_key" ||
    ! openssl req -x509 -new -sha256 -days 3650 -key "$temporary_key" -config "$ROOT_CONFIG_PATH" -extensions root_ca -out "$temporary_cert"; then
    rm -f "$temporary_key" "$temporary_cert"
    die "Lab Root 생성에 실패했습니다."
  fi
  chmod 0600 "$temporary_key"
  chmod 0644 "$temporary_cert"
  mv -f "$temporary_key" "$ROOT_KEY_PATH"
  mv -f "$temporary_cert" "$ROOT_CERT_PATH"
  verify_root
}

csr_fingerprint() {
  openssl dgst -sha256 "$1" | awk '{print $NF}'
}

verify_intermediate() {
  local purpose="$1" certificate="$2" chain="$3"
  openssl verify -CAfile "$ROOT_CERT_PATH" "$certificate" >/dev/null 2>&1 || die "$purpose intermediate chain 검증에 실패했습니다."
  local details
  details="$(openssl x509 -in "$certificate" -noout -text)"
  grep -Fq "CA:TRUE, pathlen:0" <<<"$details" || die "$purpose intermediate pathlen이 올바르지 않습니다."
  grep -Fq "Certificate Sign, CRL Sign" <<<"$details" || die "$purpose intermediate key usage가 올바르지 않습니다."
  cmp -s <(cat "$certificate" "$ROOT_CERT_PATH") "$chain" || die "$purpose intermediate chain 파일이 올바르지 않습니다."
}

write_intermediate() {
  local purpose="$1" csr="$PKI_CSR_DIR/${purpose}-intermediate.csr"
  local certificate="$LAB_SIGNED_INTERMEDIATE_DIR/${purpose}-intermediate.crt"
  local chain="$LAB_SIGNED_INTERMEDIATE_DIR/${purpose}-intermediate.chain.crt"
  local metadata="$LAB_SIGNED_INTERMEDIATE_DIR/${purpose}-intermediate.csr.sha256"
  [[ -f "$csr" && ! -L "$csr" ]] || die "$purpose CSR이 없습니다."
  openssl req -in "$csr" -noout -verify >/dev/null 2>&1 || die "$purpose CSR 형식이 올바르지 않습니다."

  local fingerprint
  fingerprint="$(csr_fingerprint "$csr")"
  if [[ -e "$certificate" || -e "$chain" || -e "$metadata" ]]; then
    [[ -f "$certificate" && -f "$chain" && -f "$metadata" && ! -L "$certificate" && ! -L "$chain" && ! -L "$metadata" ]] || die "$purpose 기존 산출물이 불완전합니다."
    [[ "$(tr -d '[:space:]' <"$metadata")" == "$fingerprint" ]] || die "$purpose CSR changed: 기존 산출물과 충돌합니다."
    verify_intermediate "$purpose" "$certificate" "$chain"
    return
  fi

  local temporary_certificate temporary_chain temporary_metadata
  temporary_certificate="$(mktemp "$LAB_SIGNED_INTERMEDIATE_DIR/.${purpose}.certificate.XXXXXX")"
  temporary_chain="$(mktemp "$LAB_SIGNED_INTERMEDIATE_DIR/.${purpose}.chain.XXXXXX")"
  temporary_metadata="$(mktemp "$LAB_SIGNED_INTERMEDIATE_DIR/.${purpose}.metadata.XXXXXX")"
  if ! openssl x509 -req -in "$csr" -CA "$ROOT_CERT_PATH" -CAkey "$ROOT_KEY_PATH" -CAserial "$ROOT_SERIAL_PATH" -CAcreateserial -out "$temporary_certificate" -days 1825 -sha256 -extfile "$ROOT_CONFIG_PATH" -extensions intermediate_ca; then
    rm -f "$temporary_certificate" "$temporary_chain" "$temporary_metadata"
    die "$purpose intermediate 서명에 실패했습니다."
  fi
  cat "$temporary_certificate" "$ROOT_CERT_PATH" >"$temporary_chain"
  printf '%s\n' "$fingerprint" >"$temporary_metadata"
  chmod 0644 "$temporary_certificate" "$temporary_chain" "$temporary_metadata"
  [[ -f "$ROOT_SERIAL_PATH" ]] && chmod 0600 "$ROOT_SERIAL_PATH"
  verify_intermediate "$purpose" "$temporary_certificate" "$temporary_chain"
  mv -f "$temporary_certificate" "$certificate"
  mv -f "$temporary_chain" "$chain"
  mv -f "$temporary_metadata" "$metadata"
}

main() {
  require_lab_environment
  ensure_layout
  ensure_root
  local purpose
  for purpose in "${PURPOSES[@]}"; do
    write_intermediate "$purpose"
  done
  printf 'Lab Root와 3개 intermediate chain을 준비했습니다.\n'
}

main "$@"
