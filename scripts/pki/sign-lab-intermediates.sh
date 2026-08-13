#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
PKI_ENV="${PKI_ENV:-}"
LAB_PKI_DIR="$ROOT_DIR/.local/lab-pki"
PKI_CSR_DIR="$LAB_PKI_DIR/csrs"
LAB_ROOT_DIR="$LAB_PKI_DIR/root"
LAB_SIGNED_INTERMEDIATE_DIR="$LAB_PKI_DIR/signed-intermediates"
LOCK_DIR="$LAB_PKI_DIR/.intermediate-sign.lock"
LOCK_TIMEOUT_SECONDS="${LAB_SIGNER_LOCK_TIMEOUT_SECONDS:-30}"
ROOT_KEY_PATH="$LAB_ROOT_DIR/root.key"
ROOT_CERT_PATH="$LAB_ROOT_DIR/root.crt"
ROOT_CONFIG_PATH="$LAB_ROOT_DIR/openssl.cnf"
ROOT_SERIAL_PATH="$LAB_ROOT_DIR/intermediate.srl"
GENERATION_DIR="$LAB_SIGNED_INTERMEDIATE_DIR/generations"
PURPOSES=(gateway-device gateway-mqtt api-server)

die() {
  printf '[lab-intermediate-sign] %s\n' "$*" >&2
  exit 1
}

file_mode() {
  stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"
}

assert_component_path() {
  local path="$1" boundary="$ROOT_DIR"
  while :; do
    [[ ! -L "$path" ]] || die "symlink 경로는 허용하지 않습니다: $path"
    [[ "$path" == "$boundary" ]] && return
    [[ "$path" != "/" ]] || die "Lab PKI 경로가 repository 경계를 벗어났습니다."
    path="$(dirname "$path")"
  done
}

assert_regular_file() {
  local path="$1" label="$2"
  [[ ! -L "$path" && -f "$path" ]] || die "$label은 symlink가 아닌 일반 파일이어야 합니다."
}

require_lab_environment() {
  [[ "$PKI_ENV" == "lab" ]] || die "이 명령은 PKI_ENV=lab에서만 실행할 수 있습니다."
  [[ "$LOCK_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || die "LAB_SIGNER_LOCK_TIMEOUT_SECONDS는 0 이상의 정수여야 합니다."
  command -v openssl >/dev/null 2>&1 || die "OpenSSL 실행 파일을 찾을 수 없습니다."
  assert_component_path "$ROOT_DIR/.local"
}

acquire_lock() {
  local elapsed=0
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    [[ -d "$LOCK_DIR" && ! -L "$LOCK_DIR" ]] || die "Lab signer lock 경로가 안전하지 않습니다."
    (( elapsed >= LOCK_TIMEOUT_SECONDS )) && die "다른 Lab intermediate signer가 실행 중이거나 stale lock이 남아 있습니다: $LOCK_DIR. 실행 중인 signer가 없는지 확인한 뒤에만 lock을 수동으로 제거하세요."
    sleep 1
    elapsed=$((elapsed + 1))
  done
  chmod 0700 "$LOCK_DIR"
}

release_lock() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
}

ensure_layout() {
  mkdir -p "$ROOT_DIR/.local" "$LAB_PKI_DIR" "$PKI_CSR_DIR" "$LAB_SIGNED_INTERMEDIATE_DIR" "$GENERATION_DIR"
  assert_component_path "$ROOT_DIR/.local"
  assert_component_path "$LAB_PKI_DIR"
  assert_component_path "$PKI_CSR_DIR"
  assert_component_path "$LAB_SIGNED_INTERMEDIATE_DIR"
  assert_component_path "$GENERATION_DIR"
  chmod 0700 "$ROOT_DIR/.local" "$LAB_PKI_DIR" "$PKI_CSR_DIR" "$LAB_SIGNED_INTERMEDIATE_DIR" "$GENERATION_DIR"
}

cleanup_own_temporary_generations() {
  local temporary
  shopt -s nullglob
  for temporary in "$LAB_SIGNED_INTERMEDIATE_DIR"/.generation-tmp-* "$LAB_PKI_DIR"/.root-generation-tmp-*; do
    [[ -d "$temporary" && ! -L "$temporary" ]] || die "Lab PKI 임시 generation 경로가 안전하지 않습니다: $temporary"
    rm -rf "$temporary"
  done
  shopt -u nullglob
}

write_root_config() {
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

public_key_digest() {
  openssl dgst -sha256 | awk '{print $NF}'
}

verify_root() {
  assert_component_path "$LAB_ROOT_DIR"
  assert_regular_file "$ROOT_KEY_PATH" "Lab Root private key"
  assert_regular_file "$ROOT_CERT_PATH" "Lab Root certificate"
  assert_regular_file "$ROOT_CONFIG_PATH" "Lab Root OpenSSL config"
  [[ "$(file_mode "$ROOT_KEY_PATH")" == "600" ]] || die "Lab Root private key 권한은 0600이어야 합니다."
  [[ "$(file_mode "$ROOT_CERT_PATH")" == "644" ]] || die "Lab Root certificate 권한은 0644이어야 합니다."
  openssl verify -CAfile "$ROOT_CERT_PATH" "$ROOT_CERT_PATH" >/dev/null 2>&1 || die "Lab Root certificate 검증에 실패했습니다."
  openssl x509 -in "$ROOT_CERT_PATH" -noout -text | grep -Fq "CA:TRUE, pathlen:1" || die "Lab Root pathlen이 올바르지 않습니다."
  local key_digest certificate_digest
  key_digest="$(openssl pkey -in "$ROOT_KEY_PATH" -pubout | public_key_digest)"
  certificate_digest="$(openssl x509 -in "$ROOT_CERT_PATH" -pubkey -noout | public_key_digest)"
  [[ "$key_digest" == "$certificate_digest" ]] || die "Lab Root private key와 certificate 공개키가 일치하지 않습니다."
}

create_root() {
  local temporary="$LAB_PKI_DIR/.root-generation-tmp-$$-$RANDOM"
  mkdir "$temporary"
  chmod 0700 "$temporary"
  local temporary_key="$temporary/root.key" temporary_certificate="$temporary/root.crt"
  if ! openssl ecparam -name prime256v1 -genkey -noout -out "$temporary_key" ||
    ! openssl req -x509 -new -sha256 -days 3650 -key "$temporary_key" -config <(sed "s|$LAB_ROOT_DIR|$temporary|g" <(cat <<'EOF'
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
EOF
)) -extensions root_ca -out "$temporary_certificate"; then
    rm -rf "$temporary"
    die "Lab Root 생성에 실패했습니다."
  fi
  chmod 0600 "$temporary_key"
  chmod 0644 "$temporary_certificate"
  mv -f "$temporary" "$LAB_ROOT_DIR"
  write_root_config
  verify_root
}

ensure_root() {
  if [[ -e "$LAB_ROOT_DIR" ]]; then
    [[ -d "$LAB_ROOT_DIR" && ! -L "$LAB_ROOT_DIR" ]] || die "Lab Root 경로가 안전하지 않습니다."
    verify_root
  else
    create_root
  fi
}

csr_fingerprint() {
  openssl dgst -sha256 "$1" | awk '{print $NF}'
}

verify_generation() {
  local purpose="$1" fingerprint="$2" generation="$GENERATION_DIR/${purpose}-${fingerprint}"
  local certificate="$generation/certificate.crt" chain="$generation/chain.crt" metadata="$generation/csr.sha256"
  [[ -d "$generation" && ! -L "$generation" ]] || die "$purpose generation이 안전하지 않습니다."
  assert_regular_file "$certificate" "$purpose certificate"
  assert_regular_file "$chain" "$purpose chain"
  assert_regular_file "$metadata" "$purpose fingerprint"
  [[ "$(file_mode "$certificate")" == "644" && "$(file_mode "$chain")" == "644" && "$(file_mode "$metadata")" == "644" ]] || die "$purpose 공개 산출물 권한은 0644이어야 합니다."
  [[ "$(tr -d '[:space:]' <"$metadata")" == "$fingerprint" ]] || die "$purpose CSR fingerprint metadata가 올바르지 않습니다."
  openssl verify -CAfile "$ROOT_CERT_PATH" "$certificate" >/dev/null 2>&1 || die "$purpose intermediate chain 검증에 실패했습니다."
  local details
  details="$(openssl x509 -in "$certificate" -noout -text)"
  grep -Fq "CA:TRUE, pathlen:0" <<<"$details" || die "$purpose intermediate pathlen이 올바르지 않습니다."
  grep -Fq "Certificate Sign, CRL Sign" <<<"$details" || die "$purpose intermediate key usage가 올바르지 않습니다."
  cmp -s <(cat "$certificate" "$ROOT_CERT_PATH") "$chain" || die "$purpose intermediate chain 파일이 올바르지 않습니다."
}

assert_stable_pointer() {
  local path="$1" expected="$2" label="$3"
  [[ -L "$path" ]] || die "$label 기존 산출물은 외부 파일 또는 legacy 형식이라 거부합니다."
  [[ "$(readlink "$path")" == "$expected" ]] || die "$label stable pointer가 예상 generation을 가리키지 않습니다."
}

publish_stable_pointers() {
  local purpose="$1" fingerprint="$2" generation="generations/${purpose}-${fingerprint}"
  local stable_certificate="$LAB_SIGNED_INTERMEDIATE_DIR/${purpose}-intermediate.crt"
  local stable_chain="$LAB_SIGNED_INTERMEDIATE_DIR/${purpose}-intermediate.chain.crt"
  local stable_metadata="$LAB_SIGNED_INTERMEDIATE_DIR/${purpose}-intermediate.csr.sha256"
  local name target temporary
  for name in certificate chain metadata; do
    case "$name" in
      certificate) target="$generation/certificate.crt"; temporary="$stable_certificate" ;;
      chain) target="$generation/chain.crt"; temporary="$stable_chain" ;;
      metadata) target="$generation/csr.sha256"; temporary="$stable_metadata" ;;
    esac
    if [[ -e "$temporary" || -L "$temporary" ]]; then
      assert_stable_pointer "$temporary" "$target" "$purpose"
      continue
    fi
    ln -s "$target" "$temporary.new-$$-$RANDOM"
    mv -f "$temporary.new-$$-"* "$temporary"
  done
}

write_intermediate() {
  local purpose="$1" csr="$PKI_CSR_DIR/${purpose}-intermediate.csr"
  assert_regular_file "$csr" "$purpose CSR"
  openssl req -in "$csr" -noout -verify >/dev/null 2>&1 || die "$purpose CSR 형식이 올바르지 않습니다."
  local fingerprint generation
  fingerprint="$(csr_fingerprint "$csr")"
  generation="$GENERATION_DIR/${purpose}-${fingerprint}"

  local stable_chain="$LAB_SIGNED_INTERMEDIATE_DIR/${purpose}-intermediate.chain.crt"
  if [[ -e "$stable_chain" || -L "$stable_chain" ]]; then
    [[ -L "$stable_chain" ]] || die "$purpose 기존 산출물은 외부 파일 또는 legacy 형식이라 거부합니다."
    local stable_target existing_fingerprint
    stable_target="$(readlink "$stable_chain")"
    if [[ "$stable_target" =~ ^generations/${purpose}-([0-9a-f]{64})/chain\.crt$ ]]; then
      existing_fingerprint="${BASH_REMATCH[1]}"
    else
      die "$purpose stable pointer가 안전한 generation을 가리키지 않습니다."
    fi
    [[ "$existing_fingerprint" == "$fingerprint" ]] || die "$purpose CSR changed: 기존 산출물과 충돌합니다."
    verify_generation "$purpose" "$fingerprint"
  fi

  if [[ -e "$generation" ]]; then
    verify_generation "$purpose" "$fingerprint"
  else
    local temporary="$LAB_SIGNED_INTERMEDIATE_DIR/.generation-tmp-${purpose}-$$-$RANDOM"
    mkdir "$temporary"
    chmod 0700 "$temporary"
    if ! openssl x509 -req -in "$csr" -CA "$ROOT_CERT_PATH" -CAkey "$ROOT_KEY_PATH" -CAserial "$ROOT_SERIAL_PATH" -CAcreateserial -out "$temporary/certificate.crt" -days 1825 -sha256 -extfile "$ROOT_CONFIG_PATH" -extensions intermediate_ca; then
      rm -rf "$temporary"
      die "$purpose intermediate 서명에 실패했습니다."
    fi
    [[ ! -L "$ROOT_SERIAL_PATH" ]] || die "Lab Root serial은 symlink가 아닌 일반 파일이어야 합니다."
    assert_regular_file "$ROOT_SERIAL_PATH" "Lab Root serial"
    chmod 0600 "$ROOT_SERIAL_PATH"
    cat "$temporary/certificate.crt" "$ROOT_CERT_PATH" >"$temporary/chain.crt"
    printf '%s\n' "$fingerprint" >"$temporary/csr.sha256"
    chmod 0644 "$temporary/certificate.crt" "$temporary/chain.crt" "$temporary/csr.sha256"
    mv -f "$temporary" "$generation"
    verify_generation "$purpose" "$fingerprint"
  fi
  publish_stable_pointers "$purpose" "$fingerprint"
}

main() {
  require_lab_environment
  mkdir -p "$ROOT_DIR/.local" "$LAB_PKI_DIR"
  acquire_lock
  trap release_lock EXIT
  ensure_layout
  cleanup_own_temporary_generations
  ensure_root
  local purpose
  for purpose in "${PURPOSES[@]}"; do
    write_intermediate "$purpose"
  done
  printf 'Lab Root와 3개 intermediate chain을 준비했습니다.\n'
}

main "$@"
