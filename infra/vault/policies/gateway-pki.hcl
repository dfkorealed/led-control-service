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
