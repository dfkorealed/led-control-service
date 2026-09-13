# BIO USB 동글 Gateway Adapter 설계

기준일: 2026-09-12
직접 USB/자체 등록 개정: 2026-09-13

## 목적

Raspberry Pi Gateway에 연결된 바이오일렉트로닉스 CH34x USB-UART 동글을 통해 JA58 계열 센서통신모듈을 검색·주소 할당·등록하고, 기존 LED 관제 서비스에서 개별 조명의 밝기와 점멸 식별을 제어한다. 현장 설치와 운영에는 제조사 Android 앱이나 휴대폰을 요구하지 않는다.

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
- Linux kernel CH34x + `serialport` 제품 경로는 Android startup 순서를 적용한 뒤에도 실장비에서 timeout이 발생했다. 이 경로는 BIO production transport로 사용하지 않는다.
- Android와 동일한 CH34x vendor control transfer 및 bulk endpoint를 사용한 Gateway direct-USB 진단은 `0x03`, `0x0b`, 두 control ACK를 수신했고 사용자가 2초 실제 점등을 확인했다.
- direct-USB endpoint는 interface `0`, bulk OUT `0x02`, bulk IN `0x82`, max packet `32`다.

## 범위

### 1차 포함

- libusb 기반 CH34x direct-USB open/claim/release와 attach/reconnect
- `55 AA` CRC-16 frame과 `GS` checksum frame의 stream parsing
- 동글 converter detection과 CRC16 운영 framing 확정
- 조명 검색과 vendor identity 수집
- 검색 결과의 기존 등록 세션 노출
- 제조사 앱 없이 UUID 기반 vendor 주소 할당과 동일 UUID/신규 주소 재확인
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
- Gateway 또는 사용자 단말에서 APK 실행, 제조사 앱 설치 요구, APK의 원격 서버 기능 재사용
- ESP32-H2 firmware 변경

제외 기능은 조명 등록·개별 제어의 성공 조건이 아니다. BIO 모듈 자체의 현장 센서 자동 점등은 기존 firmware 설정대로 유지하며, Gateway가 sensor event를 cloud automation input으로 소비하지는 않는다.

## 고려한 접근

### A. Gateway 내장 direct-USB adapter — 채택

TypeScript Gateway 안에 Node libusb binding을 사용하는 direct-USB connection, frame codec과 `BioUsbDongleAdapter`를 추가한다. 실장비에서 성공한 Android CH34x 초기화와 bulk transfer를 같은 process에서 재현하고 기존 MQTT journal/outbox와 registration session을 그대로 사용한다.

### B. 별도 USB bridge sidecar — 보류

별도 Python/PyUSB process가 raw USB를 소유하고 Gateway와 Unix socket/gRPC로 통신한다. 이미 검증된 진단 코드를 재사용하기 쉽지만 별도 protocol, health, image, upgrade와 재연결 상태를 운영해야 하므로 단일 동글 1차 적용에는 과하다.

### C. 제조사 Linux SDK — 보류

제조사 지원과 장기 유지보수에는 유리하지만 현재 SDK가 제공되지 않았고 일정이 외부 의존적이다. SDK를 받으면 direct-USB golden vector 및 HIL과 대조한 뒤 connection 구현만 교체할 수 있도록 경계를 유지한다.

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
- converter detection은 encoder 결과가 아니라 APK의 고정 literal `55 AA 82 00 00 00`, `47 53 82 00 00`을 순서대로 그대로 보내고 checksum-valid `0x03` info response를 기다린다. 그 뒤 `55 AA 0A 00 07 10`을 보내 checksum-valid CRC16 `0x0b`를 받아야 protocol ready다. `0x83`은 Android profile의 readiness 조건이 아니다.

주소/word와 short/int의 endian 규칙을 타입별 encoder로 분리한다. 호출부가 임의 byte offset을 직접 조립하지 않는다.

### `BioDirectUsbConnection`

Node `usb` libusb binding으로 raw USB 장치를 직접 연다. dependency는 lockfile에 고정하고 ARM64 image build에서 native addon load를 검증한다. 기존 `SerialConnection`은 wire 종류를 드러내지 않는 `BioByteConnection`으로 이름을 바꾸고 상위 transport가 direct USB와 test fake를 동일하게 소비한다.

- 허용 VID/PID: `1a86:5523`을 실장비 기준으로 사용하고 다른 APK 후보 PID는 명시 설정 없이는 거부한다.
- 해당 VID/PID가 정확히 한 대일 때만 open하고 descriptor를 다시 검증한다.
- interface `0`의 kernel driver를 분리하고 claim한 뒤 Android 앱에서 확인한 CH34x vendor control transfer와 `115200 8N1` 설정을 순서대로 실행한다.
- bulk OUT `0x02`에 write하고 bulk IN `0x82`를 연속 poll해 받은 chunk를 상위 frame codec에 전달한다.
- close, timeout, abort, disconnect 모든 경로에서 IN poll을 중지하고 interface를 release한 뒤 kernel driver reattach를 시도한다. release/reattach 확인 실패는 성공으로 숨기지 않는다.
- 동글의 serial number가 없으므로 다른 동일 VID/PID 동글이 추가되면 즉시 fail-closed 한다.

CH34x 초기화는 성공한 격리 HIL과 동일한 다음 순서를 사용한다. 각 단계는 timeout과 반환 길이를 검증하고 하나라도 실패하면 interface를 정리한 뒤 open 실패로 종료한다.

1. vendor OUT `0xA1`, value/index `0x0000/0x0000`
2. vendor IN `0x5F`, value `0x0000`, 2 bytes
3. vendor OUT `0x9A`, `0x1312/0xD982`
4. vendor OUT `0x9A`, `0x0F2C/0x0004`
5. vendor IN `0x95`, value `0x2518`, 2 bytes
6. vendor OUT `0x9A`, `0x2727/0x0000`
7. vendor OUT `0xA4`, `0x00FF/0x0000`
8. vendor OUT `0xA1`, `0xC39C/0xCC8B`

### `BioUsbTransport`

기존 codec/queue/reconnect 설계를 direct-USB connection 위에서 유지한다.

- 한 번에 하나의 request만 in-flight로 유지한다.
- 요청 command `+1` 응답을 correlation한다.
- 기본 protocol 응답 timeout은 `300ms`지만 Linux scheduling과 RF 왕복을 측정할 수 있게 설정 가능하게 한다.
- startup은 두 converter literal → valid `0x03` → `0x0a` → valid CRC16 `0x0b` 순서로만 ready가 된다.
- request 전 시작된 partial frame은 이후 request의 응답으로 소비하지 않는다. 특히 `0x0a` 전에 시작된 partial `0x0b`는 readiness를 만들 수 없다.
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

APK 정적 분석은 `Network.setUnicastAddressByUuid()`가 DPID `0x81`, 6-byte UUID와 16-bit unicast address를 사용함을 확인했다. 제조사 앱의 Auto Number 흐름도 장치별 호출, 최대 3회 재확인, 주소 변경 관측 후 다음 장치 진행을 사용한다. 구현은 decompiled command serializer에서 byte vector를 독립 복원하고 단일 대상 HIL에서 ACK와 동일 UUID/신규 주소 재관측을 확인한 뒤에만 production allowlist에 추가한다. trace와 실장비 확인이 없는 password/network/factory opcode는 계속 거부한다.

밝기 percent는 선형 `percent * 2.55`로 추정하지 않는다. APK의 `Scene.DEEP_VALUES`와 `deep_all` 표시 배열을 index로 결합한 고정 mapping을 사용한다. `0/20/60/90/100%` 대표점은 byte fixture와 단일 장치 HIL을 통과해야 production allowlist에 들어간다.

`startIdentify()`는 이미 HIL로 확인한 해당 주소의 force-ON을 사용하고 `stopIdentify()`는 sensor mode 복귀를 사용한다. Gateway는 identify deadline이 만료되거나 등록이 취소돼도 sensor mode 복귀를 최종 시도하며, 복귀 ACK가 없으면 UI에 경고하고 등록 성공으로 진행하지 않는다. `readBrightness()`와 `readDeviceInfo()`도 decompiled getter serializer에서 독립 복원한 vector와 실장비 response가 일치하기 전에는 fail-closed 한다.

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

API가 예약하는 `0x0001..0x7fff` address를 BIO의 16-bit 조명 주소로 사용한다. 아직 등록되지 않은 장치는 현재 주소를 그대로 채택하지 않고 API가 예약한 주소를 UUID 대상으로 할당한다. adapter는 scan 중 관측한 native UUID/address를 로컬 mapping journal에 `reserved`로 저장하고, provisioning 성공 전 새 주소에서 동일 UUID가 응답하는지 확인한다.

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

주소 write timeout은 무조건 재전송하지 않는다. 명령이 장치에 적용됐지만 ACK만 유실됐을 수 있으므로 기존 주소와 신규 주소를 대상으로 동일 UUID를 재검색해 결과를 판정한다. 신규 주소에서만 같은 UUID가 보이면 confirmed, 기존 주소에서만 보이면 bounded retry 가능, 둘 다 또는 어디에도 없으면 `BIO_ADDRESS_STATE_UNKNOWN`으로 종료한다.

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
→ adapter가 UUID/현재 주소로 대상 확인
→ 2초 점등 후 sensor mode 복귀로 현장 대상 확인
→ mapping journal reserved 저장
→ UUID 대상 DPID 0x81 주소 설정
→ ACK와 무관하게 신규 주소로 재검색
→ 동일 UUID/신규 주소 확인
→ mapping journal confirmed
→ provisioning terminal event
→ API ingest/application ACK
```

API의 V2 `events/provisioning/device-terminal` ingest/application ACK 경로를 먼저 완성한다. legacy completed/failed event만으로 새 adapter의 성공을 확정하지 않는다.

API는 기존 `ProcessedGatewayEvent`, `ProvisioningDeviceOutbox`, generic `MqttOutbox`를 재사용하며 DB migration을 만들지 않는다. ACK key는 `provisioning-device-terminal:<gatewayId>:<commandId>`로 고정해 한 command의 altered terminal을 거부한다. production/dev MQTT ACL에는 Gateway가 `acks/provisioning/device-terminal-ingested`를 읽기만 할 수 있도록 추가한다.

### 제어

```text
Web 밝기/on/off/sensor-mode 명령
→ API transaction/outbox
→ MQTT QoS 1
→ Gateway command journal
→ adapter가 percent를 검증된 raw brightness 또는 control mode로 변환
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
- `bio-usb`: Company ID와 BlueZ attach를 요구하지 않고 exact-one raw USB descriptor, interface claim, Android-equivalent CH34x init, protocol readiness, mapping validation을 요구한다.

health JSON에는 `adapterKind`, `transportConnected`, `protocolReady`, `mappingValid`를 추가한다. BlueZ 전용 `dbusOwner`, `bluezAttached`는 `bluez`에서만 평가한다. MQTT와 heartbeat는 adapter와 무관하게 계속 필수다.

현재 실장비의 `mqtt_error`는 adapter 배포 전 `systematic-debugging` 절차로 원인을 분리한다. MQTT를 복구하지 못한 상태에서는 등록·제어 HIL을 시작하지 않는다.

## Container와 host 권한

- `/dev` 전체 mount와 `privileged=true`는 금지한다.
- preflight는 `lsusb`에서 exact-one 동글의 현재 `/dev/bus/usb/<bus>/<device>`를 계산하고 Compose runtime override에 같은 경로로 장치 한 개만 전달한다. `/dev/bus/usb` 전체 mount는 금지한다.
- raw USB node의 host GID를 container supplementary group으로 전달한다.
- entrypoint는 `bio-usb`일 때 bluetooth-meshd를 시작하거나 HCI를 조작하지 않는다.
- container 안에서도 현재 raw node descriptor와 expected VID/PID를 다시 대조한다.
- USB 재연결로 bus/device 번호가 바뀌면 stale bind를 재사용하지 않는다. health를 실패시키고 host preflight가 새 exact node로 Gateway container만 recreate한다. 운영 image, env, data volume은 유지한다.

## 안전과 보안

- APK의 HTTP, WebSocket, MQTT, AI, 음성, 로그 업로드 코드는 Gateway에 포함하지 않는다.
- 동글 시험 중 Gateway 외부 인터넷 egress는 기존 MQTT endpoint만 허용한다.
- raw frame에는 현장 비밀번호나 식별값이 포함될 수 있으므로 기본 로그에는 payload 전체를 남기지 않는다.
- debug hex trace는 HIL에서만 opt-in하고 권한 `0600`, 보존시간 제한을 적용한다.
- protocol/SDK의 상용 구현·재배포 권한을 제조사에서 서면 확인한다.
- 주소 변경 HIL은 대상 UUID의 redacted fingerprint와 변경 전후 주소를 사용자에게 표시하고 명시 확인을 받은 한 장치만 수행한다. production 등록은 사용자가 UI에서 점등 대상을 확인하고 등록을 확정한 행위가 해당 한 장치의 주소 할당 승인이 된다. factory reset과 비밀번호 변경은 지원하지 않는다.

## 오류 처리

표준 fault code:

- `BIO_USB_NOT_FOUND`
- `BIO_USB_IDENTITY_MISMATCH`
- `BIO_USB_PERMISSION_DENIED`
- `BIO_USB_OPEN_FAILED`
- `BIO_USB_CLAIM_FAILED`
- `BIO_USB_RELEASE_FAILED`
- `BIO_PROTOCOL_PROBE_FAILED`
- `BIO_FRAME_INVALID`
- `BIO_RESPONSE_TIMEOUT`
- `BIO_DEVICE_NOT_FOUND`
- `BIO_ADDRESS_CONFLICT`
- `BIO_ADDRESS_STATE_UNKNOWN`
- `BIO_STATE_MISMATCH`
- `BIO_SENSOR_CLOUD_UNSUPPORTED`

late response는 다음 command의 응답으로 소비하지 않는다. disconnect 중 수락된 write는 자동 재실행하지 않고 결과를 unknown/timed-out으로 종료한다. Gateway MQTT command idempotency가 USB 물리 명령의 중복 실행도 막아야 한다.

## 테스트 전략

### 자동 테스트

- CRC/checksum golden vector
- fragmented/coalesced/noisy/corrupt frame parsing
- request+1 correlation, timeout, late response, reconnect
- Android-equivalent CH34x control transfer 순서, bulk endpoint 선택, kernel detach/release/reattach cleanup
- converter literal/`0x03`/`0x0a`/`0x0b` readiness와 pre-request partial response ownership
- UUID 기반 주소 frame, ACK 유실 뒤 old/new address reconciliation, 중복 등록 idempotency
- APK `deep_all` label과 `Scene.DEEP_VALUES`의 percent-to-raw mapping
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
2. 제품 direct-USB connection으로 descriptor, CH34x init과 `0x03`/`0x0b` read-only readiness 확인
3. APK 정적 분석과 기존 격리 trace에서 주소/밝기 byte fixture를 독립 복원한다. 제조사 앱은 개발 증거 보강에만 선택적으로 사용하며 production 설치·등록 의존성은 만들지 않는다.
4. 단일 미등록 모듈 검색과 점멸 식별
5. 사용자에게 표시한 대상 한 대만 UUID 기반 주소 할당, 재검색 및 등록
6. 0/20/60/90/100% 제어와 육안 밝기·read-back 일치
7. Gateway container restart와 USB 탈착 후 mapping/제어 복구
8. MQTT QoS 1 duplicate에서 물리 명령 중복 실행 없음
9. 2-node 개별/parallel-unicast 부분 성공 3회
10. 72시간 soak

## 완료 기준

- 기본 `bluez` 경로의 자동 테스트와 동작 계약이 유지된다.
- `bio-usb`가 실제 `1a86:5523` 동글을 non-root direct USB로 열고 Android-equivalent startup을 통과한다.
- 제조사 앱이나 휴대폰 없이 Web 등록 화면에서 실제 모듈 하나를 발견하고, 점등 확인 후 UUID 기반 주소를 할당해 중복 없이 Fixture로 등록한다.
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
