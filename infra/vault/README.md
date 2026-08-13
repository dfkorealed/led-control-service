# Vault PKI bootstrap 운영 절차

Lab에서 Vault 시작, Root 서명, 제조 station 및 API/MQTT bundle을 한 번에 생성하려면 `LAB_API_IP`, `LAB_MQTT_IP`를 지정해 `pnpm lab:pki:bootstrap`을 실행한다. 산출물 사용과 Raspberry Pi 수동 E2E 절차는 [`docs/runbooks/device-lab-first-install.md`](../../docs/runbooks/device-lab-first-install.md)를 단일 기준으로 사용한다.

이 디렉터리는 LAN 서비스의 Vault PKI 설정을 위한 것이다. Root CA는 반드시 오프라인 보관소에서 관리하며 Vault, Git, 스크립트 출력물, 서비스 bundle에 Root 또는 CA private key와 Vault token을 넣지 않는다. 제조 CA는 이 PKI와 별도의 외부 trust domain으로 운영한다.

## 사전 설정

Vault 주소와 인증 수단은 운영자가 안전한 환경에서 제공한다. PKI_LAN_DOMAIN은 server role이 허용할 LAN DNS suffix이며 기본값은 lan이다. 예를 들어 api.lan과 mqtt.lan을 사용하면 PKI_LAN_DOMAIN=lan으로 설정한다. API/MQTT DNS SAN은 이 suffix에 맞춰 발급하고, IP SAN은 실제 LAN 주소를 사용한다.

## Prepare

PKI_ENV=lab, VAULT_ADDR, PKI_LAN_DOMAIN을 설정한 뒤 scripts/pki/bootstrap-lab-vault.sh prepare를 실행한다. Vault는 gateway-device-pki, gateway-mqtt-pki, api-server-pki에 각각 ECDSA P-256 intermediate key를 내부 생성하고 CSR만 PKI_CSR_DIR에 출력한다. 같은 CSR artifact가 있으면 재생성하지 않는다.

## 오프라인 Root 서명과 Install

gateway-device-intermediate.csr, gateway-mqtt-intermediate.csr, api-server-intermediate.csr만 오프라인 Root 담당자에게 전달한다. 담당자는 각 CSR을 목적별 intermediate certificate로 서명하고 Root key를 Vault 호스트나 저장소에 복사하지 않는다. 서명된 공개 certificate 경로를 GATEWAY_DEVICE_INTERMEDIATE_CERT, GATEWAY_MQTT_INTERMEDIATE_CERT, API_SERVER_INTERMEDIATE_CERT에 지정한 뒤 scripts/pki/bootstrap-lab-vault.sh install을 실행한다. Install은 한 mount 한 issuer를 확인하고 intermediate를 import한 뒤 role과 policy를 구성한다.

## Service issue와 bundle 배포

LAB_API_DNS, LAB_API_IP, LAB_MQTT_DNS, LAB_MQTT_IP를 모두 지정하고 scripts/pki/issue-lab-service-cert.sh를 실행한다. API에는 api.crt/key/chain, MQTT에는 mqtt-server.crt/key/chain, API의 Mosquitto mTLS identity에는 api-mqtt-client.crt/key/chain이 별도 P-256 key와 CSR로 생성된다. api-mqtt-client의 CN은 항상 api-service이며 Mosquitto ACL username과 일치한다. Gateway MQTT role은 Prisma Gateway.id 형식의 UUID 5-segment CN glob만 허용하고 gateway URI SAN만 허용하므로 api-service CN을 발급할 수 없다.

공개 배포물 api-ca.crt와 mqtt-ca.crt는 versioned file을 만든 후 current pointer를 원자적으로 교체한다. mqtt-client.crl도 Vault의 PEM endpoint에서 검증한 뒤 current bundle에 포함한다. Private key와 CSR은 0600, certificate, chain, CA bundle, CRL은 0644이며 public bundle에는 private key와 Vault token을 절대 포함하지 않는다.

## Production 및 실기 검증

PKI_ENV=production은 HTTPS VAULT_ADDR만 허용한다. 스크립트는 호출 환경 변수 대신 vault status -format=json의 storage_type을 신뢰 경계로 사용하며, raft 또는 consul만 명시적으로 허용한다. 빈 값, file, dev, inmem 및 알 수 없는 backend는 모두 거부한다. Production 배포 전에는 HA storage, Vault TLS, audit device, 승인된 unseal 절차와 token policy를 준비하고 복구 절차를 점검한다.

실제 장비에서는 Raspberry Pi가 API와 MQTT의 DNS/IP SAN을 정상 검증하는지, 잘못된 IP와 신뢰하지 않은 CA가 실패하는지 확인한다. Mosquitto는 시작 시 mqtt-client.crl을 읽어야 하며 Task29가 이후 CRL 원자 갱신을 담당한다.
