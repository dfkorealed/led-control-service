# Lab Vault 기반 실장비 설치 시험 설계

## 목적

MacBook에서 API·Web·MQTT를 실행하고 같은 LAN의 Raspberry Pi와 ESP32-H2를 연결해 제조 등록부터 조명 제어까지 실제 설치 흐름을 반복 검증한다. 제품 API, DB, MQTT, Gateway와 펌웨어에는 mock이나 Lab 우회 경로를 추가하지 않고 PKI 기반 인증 흐름도 운영과 동일한 endpoint를 사용한다.

## 범위

- Docker 기반 HashiCorp Vault Lab 인스턴스의 시작, 상태 확인과 종료
- Lab Root CA 생성과 목적별 Vault intermediate CSR 자동 서명
- Gateway device, Gateway MQTT, API server intermediate 설치와 role/policy 구성
- API/MQTT LAN DNS·IP SAN 인증서 발급
- 제조 station 전용 CA와 client 인증서 발급
- API가 사용하는 device/manufacturing trust bundle, device/MQTT CRL과 Vault token file 생성
- 반복 실행 가능한 bootstrap 및 산출물 검증
- 개발자가 직접 수행하는 최초 현장 설치 runbook

실제 Raspberry Pi BlueZ와 ESP32-H2 HIL 성공 자체는 이 작업의 구현 범위가 아니다. 이 작업은 HIL을 시작할 수 있는 신뢰 기반과 수동 절차를 완성한다.

## 안전 경계

- 모든 명령은 `PKI_ENV=lab`만 허용하며 `production` 또는 미확인 환경에서는 실패한다.
- 산출물은 Git에서 제외된 `.local/lab-vault`와 `.local/lab-pki`에만 저장한다.
- Lab Root private key, Vault root token, application token과 모든 leaf private key는 `0600`, 상위 디렉터리는 `0700`으로 유지한다.
- secret과 private key 원문을 stdout, label, 문서 또는 감사 로그에 출력하지 않는다.
- 기본 명령은 기존 PKI를 덮어쓰지 않는다. 초기화는 별도 `reset --confirm-lab-destroy`처럼 명시적 확인을 요구한다.
- Lab Root는 자동화 편의를 위해 로컬 파일로 관리하지만 양산에서는 금지한다. 양산 Root는 오프라인 보관하고 Vault에는 intermediate key만 둔다.
- Lab Vault는 Docker의 persistent file-storage server mode를 사용한다. 최초 시작은 1-share/1-threshold Lab 전용 `operator init`과 unseal을 수행하며, `stop`과 재시작은 host data와 저장된 Lab unseal key를 사용해 상태를 복구한다. 이 구성은 Lab 편의용이며 양산에서 금지한다. HA, 자동 unseal, 외부 KMS, audit device, 백업 또는 운영 unseal 절차를 제공하지 않는다.
- Lab PKI를 실행하는 OS 계정은 신뢰 경계다. 같은 UID의 악성 프로세스는 `0600` Root key와 token을 직접 읽을 수 있으므로 스크립트가 방어할 수 있는 공격자로 간주하지 않는다. 다른 계정의 접근, 외부 경로·symlink 주입과 우발적인 동시 실행을 방어하며, 동일 UID 침해는 호스트 계정 폐기와 Lab PKI 전체 reset으로 대응한다.

## 구성 요소

### Lab Vault 수명주기

`scripts/pki/lab-vault.sh`는 `start`, `status`, `stop`, `reset` 명령을 제공한다. 고정된 loopback 포트로 persistent file-storage Vault server container를 실행하고, host의 `.local/lab-vault/data`를 `/vault/file`에 mount한다. 최초 시작은 `operator init -key-shares=1 -key-threshold=1 -format=json` 결과를 콘솔에 출력하지 않고 root token과 unseal key 파일로 원자 저장한다. unseal key는 Node HTTP client가 loopback `/v1/sys/unseal` 요청 body로만 전달하며 argv, 환경변수와 로그에 넣지 않는다. container name과 삭제 경로는 고정하며 image tag와 포트만 Lab 전용 환경변수로 변경할 수 있다.

### Lab Root와 intermediate 서명

`scripts/pki/sign-lab-intermediates.sh`는 ECDSA P-256 Lab Root를 최초 한 번 생성하고 `bootstrap-lab-vault.sh prepare`가 만든 세 CSR을 목적별 intermediate 인증서로 서명한다. intermediate는 `CA:true`, `pathlen:0`, `keyCertSign`, `cRLSign`을 가져야 하며 동일 CSR에 대한 반복 실행은 기존 유효 산출물을 재사용한다. 다른 CSR이 기존 이름과 충돌하면 덮어쓰지 않고 실패한다.

### 제조 station 인증서

`scripts/pki/issue-lab-manufacturing-station.sh`는 별도의 Lab Manufacturing CA와 station client certificate를 발급한다. station 인증서는 `clientAuth`만 허용하며 API TLS trust용 issuing CA를 공개 산출물로 제공한다. API server CA나 Gateway device CA를 제조 station CA로 재사용하지 않는다.

### 통합 bootstrap

`scripts/pki/bootstrap-device-lab.sh`는 다음 순서를 멱등적으로 조정한다.

1. Lab 전용 입력과 필수 도구를 검사한다.
2. Vault를 시작하고 health를 확인한다.
3. 목적별 CSR을 생성한다.
4. Lab Root로 intermediate를 서명한다.
5. intermediate, role과 policy를 Vault에 설치한다.
6. API/MQTT service 인증서를 발급한다.
7. 제조 station CA와 인증서를 발급한다.
8. device CRL과 trust bundle을 생성한다.
9. `gateway-pki` policy의 API application token을 발급해 token file에 저장한다.
10. 실행에 필요한 절대 경로만 담은 `.local/lab-pki/lab.env`를 `0600`으로 생성한다.

`lab.env`에는 secret 원문이 아니라 token file 경로와 인증서 경로를 기록한다. Vault root token은 API에 제공하지 않는다.

## 명령 인터페이스

필수 입력은 `LAB_API_IP`, `LAB_MQTT_IP`이며 DNS 기본값은 `api.led.lan`, `mqtt.led.lan`이다.

```bash
LAB_API_IP=192.168.0.10 \
LAB_MQTT_IP=192.168.0.10 \
scripts/pki/bootstrap-device-lab.sh
```

완료 후 개발자는 다음과 같이 환경을 로드한다.

```bash
set -a
. .local/lab-pki/lab.env
set +a
pnpm dev
```

## 검증

- shell 단위 테스트는 fake Vault와 임시 디렉터리로 환경 제한, 권한, 멱등성, 충돌 거부와 secret 비출력을 검사한다.
- OpenSSL 검증은 Root→intermediate→leaf chain, `serverAuth`/`clientAuth`, DNS·IP SAN과 CA path length를 검사한다.
- 선택적 Docker 통합 시험은 실제 Lab Vault에 bootstrap을 실행하고 service/station 인증서 발급과 CRL 파싱을 확인한다.
- runbook은 현장 생성, 제조 enrollment, claim, bootstrap, heartbeat, ESP32 검색·등록, 상태 확인과 0/25/50/100% 제어의 수동 판정 기준을 제공한다.

## 실패 처리

- Docker/Vault/OpenSSL/jq/Node 중 하나라도 없으면 변경 전에 누락 도구를 출력하고 종료한다.
- IP/DNS, 환경값 또는 파일 권한이 잘못되면 인증서를 발급하지 않는다.
- 중간 단계가 실패하면 기존 유효 산출물을 유지하고 임시 파일만 삭제한다.
- Vault 상태와 로컬 산출물 세대가 불일치하면 자동 혼합하지 않고 reset 후 전체 재발급을 요구한다.
- `lab:vault reset`은 Lab Vault container와 `.local/lab-vault`만 제거하며 `.local/lab-pki`, PostgreSQL, 운영 PKI와 Gateway 장비 파일은 건드리지 않는다. 전체 Lab PKI 초기화는 runbook에서 각 경계를 별도로 확인하고 수행한다.

## 수동 시험 완료 기준

- DB 직접 수정 없이 operator가 고객사·현장·층을 만든다.
- 제조 station mTLS로 Gateway device identity와 일회성 claim code를 발급한다.
- claim code 재사용과 잘못된 인증서가 거부된다.
- Raspberry Pi가 claim 결과를 bootstrap해 자체 MQTT key와 인증서를 발급받는다.
- Gateway heartbeat가 90초 freshness 계약 안에서 online으로 표시된다.
- 하드웨어가 없을 때 검색 결과가 0개이고 unprovisioned ESP32-H2만 실제 UUID/RSSI로 발견된다.
- provisioning 직후 `상태 확인 대기`, 첫 실제 status 이후 online/fault와 밝기가 확정된다.
- 제어 성공은 MQTT 접수 ACK가 아니라 ESP32 Lightness Status 이후 확정된다.
