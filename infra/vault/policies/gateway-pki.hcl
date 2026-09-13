# Gateway application policy: no service server or API-client signing rights.
path "gateway-device-pki/sign/gateway-device" {
  capabilities = ["update"]
}

path "gateway-mqtt-pki/sign/gateway-mqtt" {
  capabilities = ["update"]
}

path "gateway-device-pki/revoke" {
  capabilities = ["update"]
}

path "gateway-mqtt-pki/revoke" {
  capabilities = ["update"]
}

path "gateway-device-pki/crl/pem" {
  capabilities = ["read"]
}

path "gateway-mqtt-pki/crl/pem" {
  capabilities = ["read"]
}

# Revocation is recorded before Vault's auto-rebuild window necessarily
# regenerates its cached CRL. The API may force only these two purpose-local
# rotations; it still has no issuer, Root, policy, or server-signing rights.
path "gateway-device-pki/crl/rotate" {
  capabilities = ["read"]
}

path "gateway-mqtt-pki/crl/rotate" {
  capabilities = ["read"]
}

path "auth/token/lookup-self" {
  capabilities = ["read"]
}

path "auth/token/renew-self" {
  capabilities = ["update"]
}
