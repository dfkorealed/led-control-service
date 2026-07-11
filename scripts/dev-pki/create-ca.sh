#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PKI_DIR="${PKI_DIR:-$ROOT_DIR/.local/pki}"
mkdir -p "$PKI_DIR/newcerts"
touch "$PKI_DIR/index.txt"
printf '1000\n' > "$PKI_DIR/serial"
printf '1000\n' > "$PKI_DIR/crlnumber"

cat > "$PKI_DIR/openssl.cnf" <<EOF
[ ca ]
default_ca = local_ca
[ local_ca ]
dir = $PKI_DIR
database = \$dir/index.txt
new_certs_dir = \$dir/newcerts
certificate = \$dir/ca.crt
private_key = \$dir/ca.key
serial = \$dir/serial
crlnumber = \$dir/crlnumber
default_md = sha256
default_days = 825
default_crl_days = 30
policy = policy_any
unique_subject = no
[ policy_any ]
commonName = supplied
[ server_cert ]
basicConstraints = CA:false
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost,IP:127.0.0.1
[ client_cert ]
basicConstraints = CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = clientAuth
EOF

openssl genrsa -out "$PKI_DIR/ca.key" 4096
openssl req -x509 -new -sha256 -days 3650 -key "$PKI_DIR/ca.key" -out "$PKI_DIR/ca.crt" -subj "/CN=LED Control Development CA"

issue_certificate() {
  local name="$1" common_name="$2" extension="$3"
  openssl genrsa -out "$PKI_DIR/$name.key" 2048
  openssl req -new -key "$PKI_DIR/$name.key" -out "$PKI_DIR/$name.csr" -subj "/CN=$common_name"
  openssl ca -batch -config "$PKI_DIR/openssl.cnf" -extensions "$extension" -in "$PKI_DIR/$name.csr" -out "$PKI_DIR/$name.crt"
  rm -f "$PKI_DIR/$name.csr"
}

issue_certificate broker localhost server_cert
issue_certificate api api-service client_cert
openssl ca -config "$PKI_DIR/openssl.cnf" -gencrl -out "$PKI_DIR/ca.crl"
chmod 600 "$PKI_DIR"/*.key
printf '개발용 CA, broker, API 인증서를 생성했습니다: %s\n' "$PKI_DIR"
