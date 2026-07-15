# Raspberry Pi Gateway Appliance 컨테이너 설계

기준일: 2026-07-13

## 목적

같은 LAN의 개발 Mac에서 Web, API, PostgreSQL, Redis, mTLS Mosquitto를 실행하고 Raspberry Pi 4에서는 Docker 기반 Gateway Appliance를 실행한다. Gateway는 ESP32-H2 조명 노드를 BLE Mesh로 검색, provisioning, 구성, 개별·그룹 제어하고 상태를 클라우드에 동기화한다.

첫 실기 완료 기준은 Raspberry Pi 1대와 ESP32-H2 2대로 검색부터 재부팅 복구까지 3회 연속 통과하는 것이다. 자동 테스트와 ESP-IDF 빌드만으로 실기 완료를 선언하지 않는다.

## 현재 확인된 환경

- Raspberry Pi 4, `aarch64`
- Debian 13 Trixie, Raspberry Pi 커널 6.18
- BlueZ 5.82와 BCM4345 HCI 장치 인식 완료
- 배포판 패키지에는 `bluetooth-meshd`가 없음
- `/etc/modprobe.d/rfkill_default.conf`의 `default_state=0`으로 Bluetooth가 부팅 시 차단됨
- 프로젝트의 ESP32-H2 node firmware는 PB-ADV/PB-GATT, Generic OnOff Server, Light Lightness Server, Health Server와 상태 publication을 포함하며 target build를 통과함
- Gateway의 MQTT v2, mTLS, command journal, sequence, ACK 계약은 구현됨
- 실제 BlueZ Mesh provisioner/client adapter는 미구현이며 운영 factory가 시작을 차단함

## 선택 구조

Raspberry Pi에는 Docker Engine과 Bluetooth 커널 드라이버만 두고, 하나의 Gateway Appliance 컨테이너에 다음 런타임을 포함한다.

- Node.js 22 런타임과 빌드된 TypeScript Gateway
- BlueZ 5.82 `bluetooth-meshd`
- 컨테이너 전용 system D-Bus
- BlueZ Mesh application과 provisioner/client adapter
- 시작 전 환경·인증서·Bluetooth capability 검사

컨테이너는 appliance 단위로 함께 생명주기를 가져야 하는 private D-Bus, Mesh daemon, Gateway 프로세스를 최소 init/supervisor로 관리한다. 프로세스 하나가 비정상 종료되면 컨테이너 전체를 실패 처리해 Docker restart policy가 일관되게 복구한다.

```mermaid
flowchart LR
    WEB["Mac Web/API"] --> MQTT["Mac mTLS MQTT"]
    MQTT <--> GW["Raspberry Pi Gateway Appliance"]
    GW --> DBUS["Private system D-Bus"]
    DBUS --> MESHD["BlueZ 5.82 bluetooth-meshd"]
    MESHD --> HCI["Raspberry Pi hci0"]
    HCI <--> LED["ESP32-H2 조명 노드"]
```

## 컨테이너 보안 경계

- `network_mode: host`는 MQTT와 bootstrap 연결, Bluetooth 관리 인터페이스의 예측 가능한 동작을 위해 사용한다.
- 처음에는 필요한 capability를 측정하고 `NET_ADMIN`, `NET_RAW` 등 확인된 최소 집합만 Compose에 남긴다.
- `/dev` 전체 mount와 Docker socket mount는 금지한다.
- `privileged: true`는 Phase 0 원인 분리용 임시 override에서만 허용하며 운영 Compose에는 포함하지 않는다.
- root filesystem은 read-only로 실행하고 `/tmp`, `/run`은 tmpfs로 제공한다.
- Gateway MQTT·bootstrap CA와 client certificate는 host에서 read-only bind mount한다.
- private key, claim code, NetKey, AppKey는 이미지와 Git에 포함하지 않는다.

Bluetooth의 rfkill 영구 해제와 Docker Engine 기동은 host 책임이다. 컨테이너가 host 부팅 설정을 임의 변경하지 않는다.

## 영속 데이터

다음 경로를 host volume에 저장한다.

| 데이터 | 컨테이너 경로 | 요구사항 |
|---|---|---|
| Gateway assignment | `/var/lib/led-control/assignment.json` | 원자 쓰기, `0600` |
| Command journal | `/var/lib/led-control/command-journal.json` | 멱등 처리와 재시작 복구 |
| Event sequence | `/var/lib/led-control/event-sequence.json` | 단조 증가 유지 |
| BlueZ Mesh database | `/var/lib/bluetooth/mesh` | token, node, key database 재부팅 복구 |
| Fixture-address mapping | `/var/lib/led-control/mesh-mapping.json` | fixture ID와 unicast/group/model 관계 |
| 로그·HIL 증거 | `/var/log/led-control` | 비밀정보 제외, rotation 적용 |

Gateway assignment와 Mesh database 중 하나만 유실된 상태를 자동 복구로 가장하지 않는다. 불일치가 감지되면 제어를 중지하고 명시적 복구 상태를 보고한다.

## BlueZ Mesh 애플리케이션

Gateway는 private D-Bus에 다음 인터페이스를 export한다.

- `org.freedesktop.DBus.ObjectManager`
- `org.bluez.mesh.Application1`
- `org.bluez.mesh.Provisioner1`
- `org.bluez.mesh.ProvisionAgent1`
- `org.bluez.mesh.Element1`

장기 실행 상태 기계는 다음 순서를 따른다.

1. private D-Bus와 `bluetooth-meshd` 준비 확인
2. 기존 provisioner token이 있으면 `Network1.Attach`, 없으면 provisioner identity 생성
3. `UnprovisionedScan` 결과를 device UUID 기준으로 중복 제거
4. 웹 등록 명령에서 `AddNode` 실행 및 고유 unicast 범위 할당
5. composition data 조회
6. AppKey 추가
7. Generic OnOff, Light Lightness, Health model bind
8. 층·그룹 subscription과 상태 publication 설정
9. fixture ID, primary unicast, element/model 주소를 원자 저장
10. acknowledged Lightness Set을 전송하고 `Element1.MessageReceived`의 Lightness Status로 완료 판정

검색 결과의 device name은 PB-GATT 보조 정보일 뿐이다. PB-ADV 식별의 기준은 firmware가 생성한 device UUID prefix와 제조 serial 매핑이다.

## 명령 및 상태 흐름

API는 transactional outbox를 통해 gateway-scoped MQTT v2 dimming command를 발행한다. Gateway는 다음 두 단계를 분리한다.

1. command 검증과 journal reservation 이후 acceptance ACK 발행
2. BLE Mesh acknowledged status 수신 후 fixture별 device-status ACK와 fixture state 발행

Lightness Status의 source unicast를 영속 mapping으로 fixture ID에 변환한다. MQTT command sequence와 BLE Mesh 8-bit TID는 별도 값으로 관리한다. 재시도는 같은 idempotency key를 재사용하고 완료된 명령을 물리 장치에 다시 적용하지 않는다.

그룹 제어는 group address로 한 번 전송하더라도 완료 판정은 대상 fixture별 Status 또는 timeout으로 계산한다. 일부 노드만 응답하면 `partially_succeeded`로 보고한다.

## Claim과 인증서

양산 이미지는 site ID와 gateway ID를 포함하지 않는다.

1. 제조 단계에서 gateway serial, bootstrap device certificate와 private key를 주입한다.
2. 사용자가 Web에서 일회성 claim code로 장비를 현장에 연결한다.
3. Gateway가 HTTPS mTLS bootstrap으로 assignment를 받는다.
4. claim 후 gateway ID를 CN으로 갖는 MQTT client certificate를 발급·배포한다.
5. assignment와 MQTT 인증서가 준비된 후에만 MQTT 연결과 Mesh 제어를 시작한다.

첫 실험실 시험에서는 현재 수동 개발 PKI를 사용할 수 있지만, 수동 파일 복사는 실기 검증 방식일 뿐 양산 enrollment 완료로 기록하지 않는다.

## 양산 Gateway PKI 자동 등록 설계

### 최종 판단

Raspberry Pi 내부에서 gateway별 private key를 생성하고 CSR만 서버로 전송하며, 중앙 발급 서비스가 검증된 CSR에만 인증서를 서명하는 방식이 현재 서비스에 적합하다. 이는 장비 고유 식별, 통신 데이터 보호, 논리적 접근 통제를 요구하는 IoT 보안 기준과 일치한다. 파일 기반 private key는 TPM보다 물리 탈취 저항성이 낮으므로 잠금 함체, root 전용 파일 권한, read-only container mount, 짧은 운영 인증서 수명, 폐기와 재발급 감사 로그를 필수 보완 통제로 적용한다.

CA 인증서는 gateway마다 생성하지 않는다. 전체 fleet이 신뢰하는 CA chain을 버전 관리하고 gateway마다 고유 leaf 인증서와 private key만 발급한다.

| 구분 | Gateway별 고유 | 저장 위치 | 수명 |
| --- | --- | --- | --- |
| 제조 serial | 예 | 제조 원장, gateway 설정 | 장비 수명 |
| Claim Code | 예 | 서버에는 hash만, 원문은 라벨 1회 | claim 성공까지 |
| `device.key` | 예 | gateway 내부 `0600` | device 인증서 key rotation까지 |
| `device.crt` | 예 | gateway, 서버 metadata | 365일 |
| `api-ca.crt` | 아니오 | fleet trust bundle | CA rotation 정책 |
| `mqtt-ca.crt` | 아니오 | fleet trust bundle | CA rotation 정책 |
| `gateway.key` | 예 | gateway 내부 `0600` | MQTT 인증서 key rotation까지 |
| `gateway.crt` | 예 | gateway, 서버 metadata | 90일 |

### CA 계층과 서명 서비스

Root CA private key는 오프라인으로 보관한다. HashiCorp Vault PKI에는 Root가 서명한 Device Issuing CA와 MQTT Client Issuing CA intermediate만 둔다. API는 Vault token 원문을 환경변수나 DB에 저장하지 않고 Vault Agent의 짧은 수명 token sink 파일을 read-only로 읽는다. `NODE_ENV=production`에서는 OpenSSL local signer를 허용하지 않고 Vault provider가 준비되지 않으면 API 시작을 실패시킨다.

서비스 인증서의 책임은 분리한다. 운영 API와 MQTT broker의 server certificate는 배포 환경의 공인 또는 사설 Service CA가 발급한다. Gateway PKI API는 `api-ca.crt`, `mqtt-ca.crt` trust bundle을 배포하지만 server private key를 gateway enrollment 응답에 포함하지 않는다.

### 제조 등록 흐름

1. 제조 운영자가 mTLS로 보호된 제조 API에 serial을 등록한다.
2. API는 15분 유효, 1회 사용 가능한 enrollment token과 Claim Code를 생성한다.
3. enrollment token과 Claim Code 원문은 hash만 DB에 저장하며 Claim Code 원문은 제조 라벨 출력 경로에 한 번만 반환한다.
4. 제조 station은 enrollment token을 gateway에 전달한다.
5. Gateway는 내부에서 ECDSA P-256 `device.key`를 생성하고 CN=`serial`, SAN URI=`urn:dfkorea:gateway:<serial>` CSR을 만든다.
6. Gateway는 CSR과 token을 제조 enrollment API에 전송한다.
7. API는 token, serial, CSR proof-of-possession과 허용 key algorithm을 검증하고 CSR subject를 신뢰하지 않은 채 서버 정책으로 subject/SAN을 고정한다.
8. Vault Device Issuing CA가 CSR을 서명한다.
9. API는 `device.crt`, device CA chain, `api-ca.crt`, `mqtt-ca.crt`, 인증서 metadata를 반환한다.
10. Gateway는 temporary file write, `fsync`, permission 설정, atomic rename 순서로 identity bundle을 설치한다.
11. API는 `GatewayInventory`와 인증서 원장에 fingerprint, serial number, issuer, notBefore/notAfter, status를 기록하고 token을 폐기한다.
12. 제조 station은 private key가 gateway 밖으로 나오지 않았고 certificate public key가 local private key와 일치하는지 확인한 뒤 합격 라벨을 출력한다.

### Claim 이후 MQTT 인증서 흐름

1. 고객이 Web에서 serial과 Claim Code로 gateway를 현장에 claim한다.
2. Gateway는 `device.crt/device.key`로 `/gateway-bootstrap` mTLS 요청을 보내 assignment를 받는다.
3. Gateway는 내부에서 별도 ECDSA P-256 `gateway.key`와 CN=`Gateway.id`, SAN URI=`urn:dfkorea:mqtt:<Gateway.id>` CSR을 생성한다.
4. Gateway는 device mTLS로 `/gateway-certificates/mqtt`에 CSR을 제출한다.
5. API는 device fingerprint, inventory, claim, assignment 관계를 모두 검증한다.
6. Vault MQTT Client Issuing CA는 90일 인증서를 발급한다.
7. Gateway는 `gateway.crt`, MQTT CA chain을 원자 저장하고 MQTT에 재연결한다.
8. Mosquitto는 client certificate CN을 gateway identity로 사용하고 gateway-scoped ACL만 허용한다.
9. Gateway는 만료 30일 전 새 key/CSR로 rotation하고 새 연결 성공 후 이전 key/certificate를 삭제한다.

### 저장과 권한

Host identity 디렉터리는 container writable layer가 아니라 `/opt/led-control/data/identity` persistent volume에 둔다. directory는 `0750 root:gateway`, private key는 `0600 gateway:gateway`, certificate와 CA bundle은 `0644 root:root`를 적용한다. private key, Claim Code, enrollment token, Vault token은 stdout, journald, API 응답 로그, DB, Docker image, backup에 포함하지 않는다.

Gateway 프로세스는 key 파일 내용을 애플리케이션 로그에 출력하지 않으며 CSR 생성 subprocess는 shell 없이 고정 argument array로 실행한다. 제조 실패 시 임시 key와 token을 제거하고 이미 활성화된 identity bundle은 덮어쓰지 않는다.

### 인증서 원장과 폐기

`GatewayCertificate`는 inventory/gateway, purpose(`device` 또는 `mqtt`), certificate serial, fingerprint, issuer, notBefore, notAfter, status, revokedAt, replacedById를 저장한다. `GatewayEnrollment`는 serial, token hash, 만료, 사용 시각, station identity, 결과와 실패 사유를 저장한다. 인증서 PEM과 private key는 DB에 저장하지 않는다.

Inventory 비활성화, gateway 도난, key 노출 신고 시 device와 MQTT 인증서를 모두 폐기한다. Vault CRL을 갱신하고 API mTLS와 Mosquitto에 배포한 뒤 broker를 reload한다. CRL 배포 실패 상태에서는 해당 gateway를 제어 가능 상태로 표시하지 않는다.

### 시험과 양산 provider

자동 테스트는 in-memory fake CA로 계약을 검증한다. 실험실 E2E와 양산은 동일한 Vault PKI API를 사용하되 별도 mount, intermediate, policy, namespace로 격리한다. Vault dev mode와 export 가능한 Root CA key는 양산에서 금지한다. Root CA는 오프라인, Vault는 intermediate만 보유하고 CSR sign, revoke, CRL 기능만 허용한다.

참고 기준:

- NIST IR 8259A IoT Device Cybersecurity Capability Core Baseline
- RFC 7030 Enrollment over Secure Transport의 CSR 기반 enrollment 원칙
- HashiCorp Vault PKI의 intermediate CA, CSR sign, revoke, CRL과 rotation 원칙
- Mosquitto `require_certificate`, `use_identity_as_username`, gateway-scoped ACL

## 이미지 빌드와 배포

ARM64 multi-stage Dockerfile은 BlueZ 5.82 source를 고정 checksum으로 빌드하고 Gateway production dependency와 TypeScript build 산출물만 runtime image에 포함한다.

배포 방법은 두 경로를 제공한다.

- 개발: Mac에서 `linux/arm64` 이미지를 buildx로 빌드해 tar로 내보낸 후 SSH로 Pi에 전송
- 운영: immutable version tag와 digest를 private registry에서 pull

Compose에는 image digest, restart policy, healthcheck, read-only mounts, persistent volumes와 resource limit을 명시한다. `latest` tag는 사용하지 않는다. 이전 digest를 보관해 실패 시 Compose image reference만 되돌린다.

## Healthcheck

컨테이너 healthcheck는 프로세스 존재가 아니라 다음 상태를 모두 확인한다.

- private D-Bus 응답
- `org.bluez.mesh` service 존재
- HCI controller 사용 가능
- Gateway assignment 유효
- MQTT mTLS 연결 상태
- heartbeat publish age
- Mesh mapping/database 일관성

아직 claim되지 않은 정상 장비는 `starting/unassigned`로 구분하고 crash loop로 처리하지 않는다.

## 오류 처리

- Bluetooth blocked: 시작 실패, host rfkill 조치 안내
- Mesh daemon 부팅 실패: Gateway 시작 금지
- D-Bus callback export 실패: provisioning·제어 시작 금지
- MQTT 단절: 로컬 Mesh 상태는 보존하되 신규 cloud 명령을 받지 않음
- status timeout: fixture별 `timed_out`, 추정 성공 처리 금지
- mapping 불일치: 해당 fixture 제어 차단
- Mesh database 손상: 자동 reprovision 금지, 복구 절차 요구
- 인증서 만료·폐기: 연결 실패와 인증서 상태를 분리 보고

## 검증 단계

### 자동 검증

- D-Bus exported object와 callback fake test
- scan deduplication과 unicast allocator test
- composition/configuration state machine test
- Lightness/OnOff/Health codec test
- fixture-address mapping 원자성·복구 test
- Docker image ARM64 build
- Compose config와 비밀정보 미포함 검사

### Raspberry Pi Phase 0

- host Bluetooth unblock와 재부팅 후 유지
- 컨테이너에서 HCI 접근
- `org.bluez.mesh` 준비
- ESP32-H2 unprovisioned beacon 수신
- 1-node provisioning, bind, Lightness Status 왕복
- 컨테이너·Pi·ESP32-H2 재부팅 후 재provision 없이 복구

### 서비스 E2E

- Web에서 gateway claim
- 층과 gateway 연결
- 조명 2대 검색·identify·등록
- 개별 밝기 0/25/50/100%
- 그룹 밝기 제어와 한 노드 timeout 부분 실패
- 상태 publication의 DB·모니터링 화면 반영
- 다른 gateway topic ACL 부정 시험

### 완료 관문

- 전체 시나리오 3회 연속 통과
- 72시간 soak에서 failure 0
- 주차장 RF walk test와 음영 구간 기록

## 이번 구현 범위

포함:

- Raspberry Pi Gateway Appliance Dockerfile과 Compose
- BlueZ 5.82 Mesh daemon build/runtime
- 실제 BlueZ scan/provision/configure/identify/control/status adapter
- 영속 mapping과 healthcheck
- Mac-to-Pi image 전송·설치 스크립트
- Phase 0 및 2-node HIL 실행 도구와 한글 문서

제외:

- ESP32-H2 OTA 실제 배포
- 스케줄·센서 이벤트 제어
- 5대 이상 Mesh 부하 시험
- 양산 PKI 자동 CSR enrollment와 인증서 갱신 서버

제외 항목은 현재 기능처럼 표시하지 않고 기존 계획 문서의 후속 작업으로 유지한다.
