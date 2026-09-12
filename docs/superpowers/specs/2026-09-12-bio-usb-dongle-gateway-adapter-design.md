# BIO USB 동글 Gateway Adapter 설계

기준일: 2026-09-12

## 목적

Raspberry Pi Gateway에 연결된 바이오일렉트로닉스 CH34x USB-UART 동글을 통해 JA58 계열 센서통신모듈을 검색·등록하고, 기존 LED 관제 서비스에서 개별 조명의 밝기와 점멸 식별을 제어한다.

1차 적용은 `bio-usb` 전용 adapter로 수행한다. 기존 BlueZ/ESP32-H2 코드는 제거하거나 변경된 의미로 재사용하지 않고 `GATEWAY_ADAPTER=bluez` 경로를 그대로 보존한다. 같은 Gateway에서 BlueZ와 BIO 동글을 동시에 운전하는 `hybrid` routing은 1차 HIL 이후 별도 설계로 다룬다.

## 확인된 실장비 기준선

- Gateway: `dfkorea@192.168.45.122`
- CPU: `aarch64`
- USB 동글: `1a86:5523 QinHeng Electronics CH341/CH57x serial mode`
- host device: `/dev/ttyUSB0`
- stable link: `/dev/serial/by-id/usb-1a86_CH57x-if00-port0`
- host 계정 `dfkorea`는 `dialout`, `docker` group에 속한다.
- 현재 `led-control-gateway` container에는 USB device mapping이 없고 `privileged=false`다.
- 현재 container health는 `mqtt_error`이며 `lastHeartbeatPublishedAt=null`이다. 이는 USB adapter와 별개의 기존 기준선 장애로 취급하고 배포 전에 원인을 규명한다.
- 동글은 USB serial number를 제공하지 않는다(`iSerial=0`). 1차 preflight는 `1a86:5523` 동글이 정확히 한 대일 때만 통과하며 다중 동글을 지원하지 않는다.
- 현재 `mqtt_error`는 assignment의 `.lan` broker 이름이 host와 container에서 `ENOTFOUND`인 DNS 단계 장애다. 의도된 hostname을 API/설치 원장과 대조한 뒤 DNS → TCP 8883 → TLS SAN/mTLS → MQTT CONNACK 순으로 복구를 확인한다.

## 범위

### 1차 포함

- CH34x serial open/close와 attach/reconnect
- `55 AA` CRC-16 frame과 `GS` checksum frame의 stream parsing
- 동글 정보 probe와 protocol 자동 선택
- 조명 검색과 vendor identity 수집
- 검색 결과의 기존 등록 세션 노출
- 등록 시 vendor 주소 설정 또는 기존 주소 확인
- 개별 밝기 제어와 실제 상태 read-back
- 등록 후 점멸 식별
- Gateway restart 뒤 identity/address mapping 복구
- adapter별 health와 명시적인 오류 코드
- 특정 USB device만 container에 전달하는 non-root 배포
- codec, queue, adapter, container contract 자동 테스트
- 단일 모듈 실장비 HIL

### 1차 제외

- BlueZ와 BIO 동글의 동시 운전 및 자동 failover
- BIO native group broadcast 최적화
- cloud 차량 센서 telemetry와 vendor sensor event scaling
- OTA, factory reset, 비밀번호 변경, AI 학습, RF channel tuning
- APK 실행 또는 APK의 원격 서버 기능 재사용
- ESP32-H2 firmware 변경

제외 기능은 조명 등록·개별 제어의 성공 조건이 아니다. BIO 모듈 자체의 현장 센서 자동 점등은 기존 firmware 설정대로 유지하며, Gateway가 sensor event를 cloud automation input으로 소비하지는 않는다.

## 고려한 접근

### A. Gateway 내장 adapter — 채택

TypeScript Gateway 안에 serial transport, frame codec과 `BioUsbDongleAdapter`를 추가한다. 기존 MQTT journal/outbox와 registration session을 그대로 사용해 변경 범위와 운영 구성요소를 최소화한다.

### B. 별도 USB bridge sidecar — 보류

별도 process가 serial을 소유하고 Gateway와 Unix socket/gRPC로 통신한다. 장애 격리는 좋지만 별도 protocol, health, image, upgrade와 재연결 상태를 운영해야 하므로 단일 동글 1차 적용에는 과하다.

### C. BlueZ/BIO hybrid adapter — 보류

fixture마다 adapter 소유권을 저장하고 두 transport를 동시에 운전한다. 장기적으로 가능하지만 routing persistence, 이중 명령 방지, failover 정책과 DB 변경이 먼저 필요하다.

## 컴포넌트 설계

### `BioFrameCodec`

순수 함수 중심의 protocol 계층이다.

- `encodeCrcFrame(command, payload)`
- `encodeGsFrame(command, payload)`
- incremental `push(chunk)` parser
- frame split/merge, noise prefix, CRC/checksum 오류 후 resynchronization
- payload 길이 상한 `63`
- CRC 초기값 `0xffff`, polynomial `0xa001`, low byte first
- GS checksum은 command부터 payload까지 합산하고 carry를 1 byte에 접은 뒤 보수를 취한다. APK에서 복원한 golden vector로 산식을 고정한다.
- protocol probe는 encoder 결과가 아니라 APK의 고정 literal `55 AA 82 00 00 00`, `47 53 82 00 00`을 그대로 보내며 예상 응답 command는 `0x83`이다.

주소/word와 short/int의 endian 규칙을 타입별 encoder로 분리한다. 호출부가 임의 byte offset을 직접 조립하지 않는다.

### `BioSerialTransport`

`serialport`를 이용해 stable device path를 `115200 8N1`, flow control 없음으로 연다.

- 기본 경로: `/dev/serial/by-id/usb-1a86_CH57x-if00-port0`
- 허용 VID/PID: `1a86:5523`을 실장비 기준으로 사용하고 다른 APK 후보 PID는 명시 설정 없이는 거부한다.
- 한 번에 하나의 request만 in-flight로 유지한다.
- 요청 command `+1` 응답을 correlation한다.
- 기본 protocol 응답 timeout은 `300ms`지만 Linux scheduling과 RF 왕복을 측정할 수 있게 설정 가능하게 한다.
- timeout, malformed frame, disconnect, late response를 서로 다른 오류로 반환한다.
- reconnect는 2초에서 시작해 최대 32초까지 지수 증가한다.
- reconnect 뒤 probe와 mapping validation 전에는 write command를 받지 않는다.

### `BioDongleClient`

상위 기능을 raw opcode/DPID로부터 분리한다.

- `probe()`
- `scan()` / `stopScan()`
- `startIdentify(nativeDeviceId)` / `stopIdentify(nativeDeviceId)`
- `assignAddress(nativeDeviceId, logicalAddress)`
- `setBrightness(logicalAddress, brightness)`
- `readBrightness(logicalAddress)`
- `readDeviceInfo(logicalAddress)`

APK 정적 분석으로 확정되지 않은 scan/set/read frame은 실장비 write를 하기 전에 golden trace로 확정한다. trace가 없는 opcode는 production code에 추정값으로 넣지 않는다.

### `BioUsbDongleAdapter`

다음 기존 port를 구현한다.

- `BleMeshAdapter`
- `ProvisioningScannerAdapter`
- `ProvisioningAdapter`

`applyMeshGroup()`은 BIO native group broadcast를 사용하지 않고 전달받은 fixture 목록을 bounded parallel unicast로 실행해 fixture별 결과를 그대로 반환한다. `syncGroupSubscriptions()`은 confirmed mapping이 있는 member만 adapter-local virtual membership으로 수락하고 나머지는 실패로 반환한다. native RF subscription을 적용했다고 표현하지 않는다. 상태 성공은 transport ACK가 아니라 `readBrightness()` 결과가 요청값과 일치할 때만 `outcome=applied`로 반환한다.

BIO sensor cloud capability는 지원하지 않는다. `VehicleSensorMeshPort`에는 명시적인 `BioSensorCapabilityUnavailablePort`를 제공해 source 목록을 비워 반환하고, configure/send 요청이 오면 `bio_sensor_cloud_unsupported`로 fail-closed 한다. BIO provisioning 완료 뒤 기존 vehicle capability refresh를 enqueue하지 않는다. mock 성공이나 가짜 bind 결과는 만들지 않는다.

### discovery identity와 address mapping

APK가 제공하는 6-byte UUID를 lower-case hex로 정규화하고 cloud `deviceUuid`에는 `bio:<12-hex>` 형식으로 보존한다. 이를 DFK UUID처럼 위장하지 않는다.

현재 shared schema와 DB의 `deviceUuid`는 non-empty string을 허용하므로 1차 DB migration은 하지 않는다. `startProvisioningScan()`의 전역 DFK filter를 adapter 소유 판정으로 이동한다.

- BlueZ adapter는 기존 `parseDfkDeviceUuid()` 조건을 유지한다.
- BIO adapter는 정확히 `bio:[0-9a-f]{12}`만 허용한다.
- 다른 identity는 publish 전에 거부하고 진단 event를 남긴다.

API가 예약하는 `0x0001..0x7fff` address를 BIO의 16-bit 조명 주소로 사용한다. adapter는 scan 중 관측한 native UUID/address를 로컬 mapping journal에 저장하고, provisioning 성공 전 새 주소로 read-back하여 동일 UUID가 응답하는지 확인한다.

mapping journal은 `/var/lib/led-control/bio-device-mappings.json`에 atomic write/rename으로 저장하고 다음을 포함한다.

- `fixtureId`
- `nodeId`
- `deviceUuid`
- `nativeUuid`
- `logicalAddress`
- 마지막 확인 firmware/protocol
- `status: reserved | confirmed`
- `updatedAt`

확인되지 않은 mapping은 제어에 사용하지 않는다. 동일 UUID 또는 주소 충돌은 fail-closed 한다.

## 등록·제어 흐름

### 검색

```text
Web 등록 세션
→ API provisioning/scan-start
→ Gateway durable scan journal
→ BioUsbDongleAdapter.scan
→ BIO 동글 broadcast/query
→ UUID/RSSI/address 응답
→ bio:<uuid> identity 검증
→ 기존 provisioning scan-found MQTT event
→ Web 목록
```

### 등록

```text
API가 logical address 예약
→ durable provisioning command
→ adapter가 UUID로 대상 확인
→ 주소 설정 또는 기존 주소 검증
→ 새 주소로 device info read-back
→ mapping journal confirmed
→ provisioning terminal event
→ API ingest/application ACK
```

API의 V2 `events/provisioning/device-terminal` ingest/application ACK 경로를 먼저 완성한다. legacy completed/failed event만으로 새 adapter의 성공을 확정하지 않는다.

API는 기존 `ProcessedGatewayEvent`, `ProvisioningDeviceOutbox`, generic `MqttOutbox`를 재사용하며 DB migration을 만들지 않는다. ACK key는 `provisioning-device-terminal:<gatewayId>:<commandId>`로 고정해 한 command의 altered terminal을 거부한다. production/dev MQTT ACL에는 Gateway가 `acks/provisioning/device-terminal-ingested`를 읽기만 할 수 있도록 추가한다.

### 제어

```text
Web 밝기 명령
→ API transaction/outbox
→ MQTT QoS 1
→ Gateway command journal
→ adapter setBrightness
→ outer response
→ readBrightness
→ 요청값 일치 시 device-status applied
→ fixture-state event
→ API DB commit/application ACK
```

USB timeout, 동글 ACK 후 read-back 불일치, 장치 무응답은 각각 다른 fault code로 기록한다.

## Gateway startup와 health

`createProductionAdapters()`는 `bluez`와 `bio-usb`를 명시적으로 선택한다. 누락·알 수 없는 값은 기존처럼 fail-closed 한다.

- `bluez`: 현재 Company ID, D-Bus, bluetooth-meshd 조건을 그대로 유지한다.
- `bio-usb`: Company ID와 BlueZ attach를 요구하지 않고 USB descriptor, serial open, protocol probe, mapping validation을 요구한다.

health JSON에는 `adapterKind`, `transportConnected`, `protocolReady`, `mappingValid`를 추가한다. BlueZ 전용 `dbusOwner`, `bluezAttached`는 `bluez`에서만 평가한다. MQTT와 heartbeat는 adapter와 무관하게 계속 필수다.

현재 실장비의 `mqtt_error`는 adapter 배포 전 `systematic-debugging` 절차로 원인을 분리한다. MQTT를 복구하지 못한 상태에서는 등록·제어 HIL을 시작하지 않는다.

## Container와 host 권한

- `/dev` 전체 mount와 `privileged=true`는 금지한다.
- Compose `devices`에는 실장비 stable link 한 개만 `/dev/bio-dongle`로 전달한다.
- host `dialout` GID를 container supplementary group으로 전달한다.
- entrypoint는 `bio-usb`일 때 bluetooth-meshd를 시작하거나 HCI를 조작하지 않는다.
- USB path, expected VID/PID가 일치하지 않거나 `1a86:5523`가 정확히 한 대가 아니면 container는 fail-closed 한다.
- 동글 재연결 뒤 device node가 복구되는지 HIL로 검증하며, 복구되지 않으면 udev stable symlink와 container restart 정책을 명시한다.

## 안전과 보안

- APK의 HTTP, WebSocket, MQTT, AI, 음성, 로그 업로드 코드는 Gateway에 포함하지 않는다.
- 동글 시험 중 Gateway 외부 인터넷 egress는 기존 MQTT endpoint만 허용한다.
- raw frame에는 현장 비밀번호나 식별값이 포함될 수 있으므로 기본 로그에는 payload 전체를 남기지 않는다.
- debug hex trace는 HIL에서만 opt-in하고 권한 `0600`, 보존시간 제한을 적용한다.
- protocol/SDK의 상용 구현·재배포 권한을 제조사에서 서면 확인한다.
- 주소 변경, factory reset, 비밀번호 변경은 별도 명시 승인 없이는 HIL에서도 수행하지 않는다. 1차 등록에 주소 설정이 필요할 때는 대상 UUID와 변경 전후 주소를 사용자에게 표시하고 한 장치만 변경한다.

## 오류 처리

표준 fault code:

- `BIO_USB_NOT_FOUND`
- `BIO_USB_IDENTITY_MISMATCH`
- `BIO_USB_PERMISSION_DENIED`
- `BIO_SERIAL_OPEN_FAILED`
- `BIO_PROTOCOL_PROBE_FAILED`
- `BIO_FRAME_INVALID`
- `BIO_RESPONSE_TIMEOUT`
- `BIO_DEVICE_NOT_FOUND`
- `BIO_ADDRESS_CONFLICT`
- `BIO_STATE_MISMATCH`
- `BIO_SENSOR_CLOUD_UNSUPPORTED`

late response는 다음 command의 응답으로 소비하지 않는다. disconnect 중 수락된 write는 자동 재실행하지 않고 결과를 unknown/timed-out으로 종료한다. Gateway MQTT command idempotency가 USB 물리 명령의 중복 실행도 막아야 한다.

## 테스트 전략

### 자동 테스트

- CRC/checksum golden vector
- fragmented/coalesced/noisy/corrupt frame parsing
- request+1 correlation, timeout, late response, reconnect
- brightness set 뒤 read-back 일치/불일치
- scan identity allowlist와 DFK/BIO 분리
- duplicate UUID/address와 mapping atomic recovery
- provisioning terminal ingest/application ACK
- `bluez | bio-usb` factory fail-closed 선택
- adapter별 health
- Compose의 단일 device, non-root, no privileged/no `/dev` mount contract
- 기존 Gateway 전체 test, typecheck, build

### 실장비 HIL

1. 기존 MQTT health 복구
2. USB descriptor와 protocol probe read-only 확인
3. 인터넷이 차단된 별도 Android 단말에서 UI 동작별 golden trace 수집 또는 제조사 protocol 문서 대조
4. 단일 미등록 모듈 검색과 점멸 식별
5. 사용자에게 표시한 대상 한 대만 주소 등록
6. 0/20/60/90/100% 제어와 육안 밝기·read-back 일치
7. Gateway container restart와 USB 탈착 후 mapping/제어 복구
8. MQTT QoS 1 duplicate에서 물리 명령 중복 실행 없음
9. 2-node 개별/parallel-unicast 부분 성공 3회
10. 72시간 soak

## 완료 기준

- 기본 `bluez` 경로의 자동 테스트와 동작 계약이 유지된다.
- `bio-usb`가 실제 `1a86:5523` 동글을 non-root로 연다.
- Web 등록 화면에서 실제 모듈 하나를 발견하고 중복 없이 Fixture로 등록한다.
- Web 제어에서 밝기 5단계를 실제 적용하고 read-back과 상태 DB가 일치한다.
- Gateway/동글 재시작 뒤 같은 Fixture mapping을 복구한다.
- MQTT duplicate, USB timeout, 장치 무응답을 성공으로 오인하지 않는다.
- 실장비 미검증·sensor cloud 제외 범위를 상태판과 설정 메뉴 문서에 정확히 기록한다.

## 관련 문서

- `docs/superpowers/plans/2026-09-12-bio-usb-dongle-compatibility-review.md`
- `docs/project-status.md`
- `docs/menus/settings.md`
- `docs/menus/control.md`
- `docs/menus/monitoring.md`
- `docs/runbooks/raspberry-pi-gateway-appliance.md`
