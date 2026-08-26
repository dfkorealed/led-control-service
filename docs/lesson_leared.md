# 프로젝트 오답 노트 (Lessons Learned)

## 2026-08-26 / application ACK 수렴과 MQTT ACL producer 권한
- **발생했던 문제/실수**: scan terminal을 MQTT connect 시점에만 재발행해 DB transaction 또는 ACK publish가 한 번 실패한 동일 연결에서는 journal이 영구 undelivered로 남았고, Gateway의 광범위한 `write .../acks/#` 권한이 API 전용 commit ACK self-publish도 허용했다.
- **원인**: reconnect를 유일한 retry trigger로 보았고 ACK namespace를 consumer 관점의 wildcard로 열어 실제 producer별 권한을 구분하지 않았다.
- **해결 및 예방책**: terminal을 durable journal에 저장한 직후 최초 publish 결과를 기다리기 전에 scheduler를 깨우고, 1초~30초 exponential bounded backoff와 exact application ACK로 수렴시킨다. close는 timer와 active publish를 취소하고 reconnect는 generation fence 뒤 즉시 재시작한다. Gateway ACL은 `acks/acceptance`, `acks/device-status` write만 열고 `acks/state-ingested`, `acks/provisioning/scan-terminal-ingested`는 read-only로 고정한다.
- **반복 방지 체크**: transaction 실패·ACK publish 실패 뒤 동일 연결 duplicate 수렴, ACK 뒤 무발행, backoff 상한, concurrent single-flight, close/reconnect와 Gateway certificate의 application ACK publish 거부 테스트를 함께 유지한다.

## 2026-08-26 / 검색 outbox 재발행과 Gateway 논리 실행 중복
- **발생했던 문제/실수**: API durable outbox가 PUBACK 기록 전 crash 뒤 같은 scan-start를 재발행할 수 있는데 Gateway가 이를 새 BlueZ scan으로 매번 실행했고, callback이 멈춘 publish는 lease만 만료될 뿐 retry 횟수가 증가하지 않았다.
- **원인**: broker 전달 멱등성과 물리 scanner 실행 멱등성을 같은 것으로 보았고, outbox lease보다 짧은 publish 종료 경계를 두지 않았다.
- **해결 및 예방책**: API publisher는 30초 lease보다 짧은 10초 timeout으로 timeout/reject를 backoff/dead-letter terminal로 전환한다. Gateway는 logical scan key와 terminal payload를 0600 atomic journal에 보존해 running duplicate를 차단한다. restart는 running을 publish 전 정제 failed terminal로 원자 전환하고, command/application ACK subscription 뒤 connect-ready에서 미전달 terminal만 same eventId/sequence로 직렬 재시도한다. broker PUBACK은 delivered 근거로 사용하지 않고 API의 scan terminal transaction commit 뒤 exact application ACK만 `deliveredAt`을 기록한다. 미전달 terminal은 retention/capacity eviction에서 제외하고 한도 초과는 fail-closed 한다. recovery publish는 10초 timeout과 disconnect cancellation으로 다음 reconnect의 fresh drain을 보장한다.
- **반복 방지 체크**: migration rehearsal에는 historical session duplicate를 migration 전에 넣고, publisher에는 stalled callback/lease 경계 테스트를 유지한다. Gateway에는 pre-connected startup, PUBACK-only journal 보존, exact ACK, duplicate ACK, 24시간 미전달 보존, capacity fail-closed, never-callback timeout/disconnect, reconnect fresh drain, concurrent drain과 corrupt journal 테스트를 유지한다.

## 2026-08-26 / 동일 membership row의 operation 실패 덮어쓰기
- **발생했던 문제/실수**: 동일 `meshNodeId`의 주소 교체에서 old-address Delete 실패 뒤 new-address Add 성공을 같은 `MeshControlGroupMember` row에 순차 기록해, 마지막 성공이 실패를 지우고 group을 `ready`로 승격할 수 있었다.
- **원인**: operation 단위 ACK와 member 단위 최신 상태를 같은 집계 근거로 사용했고, group 실패 여부를 최종 member row에서만 다시 계산했다.
- **해결 및 예방책**: 검증된 subscription result의 전체 operation을 별도로 집계해 하나라도 실패하면 member row의 마지막 write와 관계없이 group `failed`와 operation error를 보존한다. 모든 operation 성공과 현재 member version 일치를 함께 만족할 때만 `ready`로 전환한다.
- **반복 방지 체크**: 동일 node의 old-address Delete 실패와 new-address Add 성공 조합을 API MQTT 회귀 테스트로 유지하고, Gateway의 `(action, meshNodeId, meshAddress)` exact diff 검증을 함께 실행한다.

## 2026-07-15 / Gateway PKI와 원자적 identity
- **발생했던 문제/실수**: API server CA를 Device issuing CA처럼 사용했고, enrollment token을 빠른 hash로 저장했으며, OpenSSL key 생성 직후 권한 노출과 current pointer fsync 실패 시 dangling 가능성이 있었다.
- **원인**: CA 용도, 1회용 secret lookup, multi-file identity 활성화를 각각 독립된 계약으로 분리하지 않고 정상 경로 테스트에 집중했다.
- **해결 및 예방책**: API/Device/MQTT/Manufacturing CA를 별도 파일과 DTO로 구분한다. token은 `<UUID>.<고엔트로피 secret>`으로 만들고 DB에는 salted scrypt hash만 저장하며 serial별 활성 token은 partial unique index로 제한한다. key 파일은 OpenSSL 전에 `0600`으로 선생성하고 immutable generation과 원자 current pointer를 사용한다.
- **반복 방지 체크**: pointer rename 후 fsync 실패, rollback 실패, serial mismatch 후 token 재사용, 잘못된 CA, private key 권한의 생성 순간을 부정 테스트로 유지한다. 실제 Vault/ARM64/Pi/ESP32 증거 없이는 양산 E2E 완료로 기록하지 않는다.

## [날짜 / 태스크명] - 예시
- **발생했던 문제/실수**: 서브 에이전트 리뷰 반영 중 토큰 초과로 끊겼을 때 구문 에러가 방치됨.
- **원인**: 이전 컨텍스트 확인 없이 무작정 코드 빌드부터 실행함.
- **해결 및 예방책**: 재개 시 반드시 린터와 계획서(`writing-plans`)를 먼저 로드할 것.

## 2026-07-03 / 모니터링 화면 실제 연동
- **발생했던 문제/실수**: 모니터링 화면에 층 선택, 조명 상세, 통신 품질, 게이트웨이 상태 UI가 있었지만 일부는 mock 데이터 또는 고정 텍스트에 가까웠고, API 조회도 사용자 조직 범위로 제한되지 않았다.
- **원인**: 화면 구현과 장비/MQTT 계약 구현이 별도 흐름으로 진행되어 `Fixture` 최신 상태, `Gateway` heartbeat, dashboard API, 웹 상세 패널 사이의 연결 검증이 부족했다.
- **해결 및 예방책**: UI 기능을 확정할 때는 항상 `UI 동작 -> API 응답 필드 -> DB 필드 -> MQTT/펌웨어 이벤트` 순서로 미구현 목록을 먼저 작성하고, 서비스 테스트와 화면 테스트를 함께 추가한다.
- **반복 방지 체크**: 인증이 필요한 조회 API는 controller guard, module import, service 조직 필터 테스트를 한 세트로 확인한다.

## 2026-07-05 / 빈 DB 상태 로그인 실패
- **발생했던 문제/실수**: 조명/현장 데이터를 모두 삭제한 뒤 mock 게이트웨이가 과거 fixture ID로 상태 이벤트를 계속 발행했고, API가 존재하지 않는 fixture를 `update`하려다 크래시했다.
- **원인**: 장비 이벤트는 DB 초기화, 장비 교체, mock 데이터 삭제 이후에도 늦게 도착할 수 있는데, MQTT 수신 로직이 대상 row 존재를 전제로 했다. 또한 조직에 `Site`가 0건인 최초 가입 상태를 dashboard API가 처리하지 못했다.
- **해결 및 예방책**: MQTT 상태 반영은 `updateMany`처럼 대상이 없어도 실패하지 않는 방식으로 처리하고, 현장이 없는 조직은 빈 dashboard를 반환한다.
- **반복 방지 체크**: DB를 초기 상태로 만들 때 gateway를 중지하고, 실제 장비의 지연 이벤트가 삭제된 장비 ID를 포함해도 API가 죽지 않는 테스트를 유지한다.

## 2026-07-05 / 조명 등록 전 선행 설정 누락
- **발생했던 문제/실수**: 빈 DB 상태에서 조명 등록을 시작하려 했지만 `Site`, `Floor`, `Gateway`가 없어 등록 세션을 만들 수 없었다.
- **원인**: 조명 등록 UX는 층과 게이트웨이가 이미 있다고 가정했지만, 최초 가입 사용자가 직접 현장과 층을 만드는 온보딩 흐름이 없었다.
- **해결 및 예방책**: 빈 현장 상태에서는 조명 등록 버튼보다 `초기 설치 설정`을 먼저 보여준다. 현장과 층을 생성한 뒤 제조 원장 기반 gateway claim이 성공해야 조명 검색을 연다.
- **반복 방지 체크**: 기능 진입점마다 필요한 선행 데이터가 무엇인지 문서와 empty state에 함께 표시한다.

## 2026-07-06 / 인증 Guard가 있는 신규 API 모듈 부팅 실패
- **발생했던 문제/실수**: `FloorEditorController`에 `SessionAuthGuard`를 적용했지만 `FloorEditorModule`이 `AuthModule`을 import하지 않아 Nest 앱 부팅 시 `AuthService` 의존성 해석이 실패했다.
- **원인**: 서비스 단위 테스트와 타입체크는 통과했지만 실제 Nest module graph 부팅 검증이 빠져 있었다.
- **해결 및 예방책**: `SessionAuthGuard`를 사용하는 신규 module은 `AuthModule`을 imports에 추가한다. API 기능 추가 후에는 관련 서비스 테스트뿐 아니라 로컬 API 서버 부팅 또는 module graph를 검증한다.
- **반복 방지 체크**: `@UseGuards(SessionAuthGuard)`를 추가한 controller가 있으면 같은 module의 `imports`에 `AuthModule`이 있는지 확인한다.

## 2026-07-07 / 도면 에디터 캔버스 이벤트 대상 불일치
- **발생했던 문제/실수**: 에디터 좌측 도구를 선택해도 도면 위 클릭이 내부 `world` 레이어에서 발생하면 도형이 추가되지 않았고, 조명 드래그는 이동량 누적 방식이라 포인터 중심을 정확히 따라오지 않았다.
- **원인**: 테스트가 바깥 캔버스 클릭만 검증했고, 실제 사용자가 클릭하는 배경 이미지/월드 레이어와 조명 드래그 시작점을 충분히 재현하지 못했다.
- **해결 및 예방책**: 도형/조명 객체 클릭은 이벤트 전파를 막고, 빈 도면 영역 클릭은 도구 객체 생성으로 처리한다. 조명 드래그는 누적 delta가 아니라 현재 포인터의 world 좌표를 직접 조명 좌표로 반영한다.
- **반복 방지 체크**: 캔버스 기능 테스트는 바깥 캔버스뿐 아니라 내부 레이어, 배경 이미지, 객체, 조명 각각의 이벤트 전파 경로를 포함한다.

## 2026-07-07 / Konva 에디터 테스트 환경
- **발생했던 문제/실수**: `react-konva` 전환 후 jsdom에는 실제 `canvas.getContext`가 없어 Stage 마운트가 실패했고, 기존 DOM 객체 선택 테스트도 더 이상 유효하지 않았다.
- **원인**: Konva는 실제 canvas context를 전제로 렌더링하며, 도형/조명은 DOM 노드가 아니라 canvas 픽셀로 그려진다.
- **해결 및 예방책**: `apps/web/src/test/setup.ts`에 최소 canvas context mock을 두고, 단위 테스트는 DOM 도형 조회 대신 툴바, 속성 패널, Zustand editor state, 저장 payload를 기준으로 검증한다.
- **반복 방지 체크**: Canvas 기반 라이브러리로 전환할 때는 테스트 setup의 브라우저 API mock과 기존 DOM selector 테스트의 전환 범위를 먼저 점검한다.

## 2026-07-08 / 워크스페이스 스크립트 의존성 해석
- **발생했던 문제/실수**: 루트 `scripts` 디렉터리에 둔 게이트웨이 smoke test가 `pnpm --filter @led-control/gateway exec`로 실행되어도 `mqtt` 패키지를 찾지 못했다.
- **원인**: ESM import의 패키지 해석은 실행 명령의 작업 디렉터리가 아니라 스크립트 파일 위치를 기준으로 상위 `node_modules`를 탐색한다.
- **해결 및 예방책**: 특정 워크스페이스 패키지 의존성을 사용하는 실행 스크립트는 해당 패키지 내부(`apps/gateway/scripts`)에 둔다.
- **반복 방지 체크**: 루트 스크립트에 패키지별 dependency import를 추가할 때는 루트 의존성으로 승격할지, 패키지 내부 스크립트로 둘지 먼저 결정한다.

## 2026-07-08 / ESP-IDF BLE Mesh 모델 옵션 누락
- **발생했던 문제/실수**: ESP32-H2 펌웨어에 Generic OnOff Server와 Light Lightness Server 코드를 추가했지만 링크 단계에서 `esp_ble_mesh_register_generic_server_callback`, `esp_ble_mesh_register_lighting_server_callback` 심볼을 찾지 못했다.
- **원인**: `CONFIG_BLE_MESH=y`와 `CONFIG_BLE_MESH_NODE=y`만으로는 SIG model server 구현이 링크되지 않고, `CONFIG_BLE_MESH_GENERIC_SERVER=y`, `CONFIG_BLE_MESH_LIGHTING_SERVER=y`가 별도로 필요했다.
- **해결 및 예방책**: BLE Mesh model을 추가할 때는 ESP-IDF 예제의 `sdkconfig.defaults`를 같이 확인하고 model별 Kconfig 옵션을 명시한다.
- **반복 방지 체크**: 펌웨어 기능 추가 후에는 반드시 `scripts/esp32-h2-build.sh`로 실제 target build를 돌려 컴파일뿐 아니라 링크까지 확인한다.

## 2026-07-09 / ESP-IDF flash 스크립트 Python 버전 불일치
- **발생했던 문제/실수**: `scripts/esp32-h2-flash.sh /dev/cu.usbmodem1301` 실행 시 Homebrew 기본 `python3` 3.14.6을 잡아 `idf5.5_py3.14_env`를 찾다가 실패했다.
- **원인**: ESP-IDF v5.5.1 설치는 Python 3.12로 진행되어 실제 venv는 `idf5.5_py3.12_env`였지만, flash/build 스크립트가 Python 3.12 PATH를 직접 보정하지 않았다.
- **해결 및 예방책**: `scripts/esp32-h2-build.sh`, `scripts/esp32-h2-flash.sh`에서 `/opt/homebrew/opt/python@3.12/libexec/bin`을 PATH 앞에 자동 추가한다.
- **반복 방지 체크**: ESP-IDF 스크립트 실행 전 로그에서 `Checking "python3" ... Python 3.12.x`와 `idf5.5_py3.12_env` 사용 여부를 확인한다.

## 2026-07-10 / 조명 검색 MQTT 이벤트 생산자 누락
- **발생했던 문제/실수**: 웹에서 조명 검색 세션과 MQTT `provisioning-scan-start` 명령은 생성됐지만, 실제 gateway가 해당 명령을 구독해 `unprovisioned-device-found` 이벤트를 만들지 않아 검색 결과가 0개였다.
- **원인**: API/UI의 등록 세션 구현과 gateway의 BLE Mesh scan/provisioning adapter 구현이 분리되어 있었고, mock gateway도 고정 `MOCK_SITE_ID`만 구독해 실제 DB 현장 ID와 맞지 않았다.
- **해결 및 예방책**: gateway가 `provisioning-scan-start`, `identify-device`, `provision-device`를 구독하고 stub/command adapter를 통해 발견/완료/실패 이벤트를 발행하도록 했다.
- **반복 방지 체크**: MQTT 기반 기능은 command 발행 테스트와 event 생산자 테스트를 같은 작업 범위에 포함하고, 실제 DB의 site/gateway ID와 gateway 환경변수가 일치하는지 확인한다.

## 2026-07-11 / MQTT topic과 tenant 범위 검증
- **발생했던 문제/실수**: 기존 상태 이벤트는 topic의 site ID보다 payload의 fixture ID를 중심으로 갱신해, 인증된 gateway라도 다른 현장 식별자를 섞은 이벤트를 보낼 여지가 있었다.
- **원인**: broker ACL과 topic 문자열을 애플리케이션의 최종 권한 검증으로 간주했다.
- **해결 및 예방책**: topic의 site/gateway, payload의 site/gateway, DB의 Site-Gateway-MeshNode-Fixture 관계가 모두 일치할 때만 이벤트를 반영한다. `eventId`와 영속 sequence로 QoS 1 중복 및 역전도 차단한다.
- **반복 방지 체크**: 모든 장비 이벤트 테스트에 정상 범위, 다른 tenant 위조, 중복 event ID, 낮은 sequence를 포함한다.

## 2026-07-11 / 제조 credential 원문 저장 금지
- **발생했던 문제/실수**: 기존 수동 gateway 등록은 serial만 알면 DB Gateway를 만들 수 있어 제조 identity 소유권과 실제 장비를 연결하지 못했다.
- **원인**: 개발용 환경변수의 site/gateway ID 입력 방식을 양산 흐름에도 확장하려 했다.
- **해결 및 예방책**: 제조 원장에는 serial, scrypt claim code hash, certificate fingerprint만 저장한다. claim 성공 시 hash를 폐기하고 private key와 claim code 원문은 DB, Git, assignment에 저장하지 않는다.
- **반복 방지 체크**: credential 기능 리뷰 시 원문 저장 위치, 로그 노출, 재사용 차단, rate limit, 감사 로그를 함께 검사한다.

## 2026-07-11 / ACK 의미 분리와 transactional outbox
- **발생했던 문제/실수**: gateway가 MQTT 메시지를 받았다는 ACK를 실제 조명이 밝기를 적용했다는 성공으로 표시할 수 있었다.
- **원인**: Command 하나에 전송 접수와 fixture별 장비 결과를 함께 저장했다.
- **해결 및 예방책**: 사용자 Command를 gateway별 Dispatch로 분할하고 acceptance ACK와 device-status ACK를 별도 계약으로 관리한다. Command, Dispatch, fixture result, MQTT outbox는 같은 DB transaction에 생성한다.
- **반복 방지 체크**: 그룹 제어 테스트에 여러 gateway, 부분 실패, timeout, 중복 idempotency key를 포함하고 상위 Command는 모든 dispatch 종료 후 확정한다.

## 2026-07-11 / 하드웨어 검증 수준 구분
- **발생했던 문제/실수**: Mac stub 테스트나 ESP-IDF build 성공을 Raspberry Pi BlueZ Mesh 및 실제 RF 성공과 혼동할 가능성이 있었다.
- **원인**: 코드 완료, target build 완료, 단일 보드 검증, 2-node 현장 검증의 완료 용어가 분리되지 않았다.
- **해결 및 예방책**: 상태를 `자동 검증 완료`, `Raspberry Pi Phase 0 완료`, `2-node HIL 3회 완료`로 분리한다. 상위 수준의 로그가 없으면 양산 준비 완료로 기록하지 않는다.
- **반복 방지 체크**: 하드웨어 기능 문서에는 사용 장비, firmware hash, 실행 명령, 반복 횟수, 실제 status와 journald 로그 경로를 남긴다.

## 2026-07-13 / 운영 MQTT 보안 전환 후 로컬 개발 실행 계약 불일치
- **발생했던 문제/실수**: API는 모든 환경에서 MQTT mTLS 인증서를 강제하도록 변경했지만 루트 `.env`, Docker 기본 서비스, mock gateway와 README는 평문 1883 실행 방식을 유지해 `pnpm dev`가 `MQTT_CA_PATH is required`로 종료됐다.
- **원인**: 런타임 보안 정책만 변경하고 루트 개발 오케스트레이션, 인증서 발급, mock client identity, 고정 포트와 문서를 하나의 실행 계약으로 함께 검증하지 않았다. 상대 인증서 경로도 workspace별 현재 디렉터리에 따라 잘못 해석될 수 있었다.
- **해결 및 예방책**: 루트 `pnpm dev`가 절대 인증서 경로를 주입하고 개발 PKI, mTLS Mosquitto, DB migration과 자식 프로세스 수명주기를 관리하도록 했다. 런타임 mock identity는 제거하고 실제 claim된 `DEV_GATEWAY_ID`만 허용한다.
- **반복 방지 체크**: 인증·전송 정책을 강화할 때 API, 실제 gateway, compose, `.env.example`, 루트 실행 명령을 같은 테스트 단위로 확인하고 실제 루트 명령으로 로그인까지 검증한다.

## 2026-07-13 / Raspberry Pi 호스트 패키지와 pnpm store 불일치
- **발생했던 문제/실수**: Debian 13에서 `rfkill` 명령을 `util-linux` 패키지로 설치하려 했고, 로컬 의존성 갱신은 기존 pnpm store v11과 현재 pnpm 9 store v3가 달라 실패했다.
- **원인**: macOS와 Debian의 패키지 구성을 일반화했고, workspace의 기존 `node_modules`가 어떤 pnpm/store로 설치됐는지 확인하기 전에 add 명령을 실행했다.
- **해결 및 예방책**: Pi host preflight는 Debian의 `rfkill` 패키지를 직접 설치한다. pnpm 의존성 변경 전에는 `node_modules/.modules.yaml`의 store 경로와 실행 pnpm 버전을 확인하고 기존 설치를 임의로 재생성하지 않는다.
- **반복 방지 체크**: 실제 OS package 이름은 대상 OS의 `apt-cache show`로 검증하고, appliance build는 clean container의 frozen lockfile 설치로 재현한다.

## 2026-07-13 / private D-Bus 실기 호출과 64비트 token
- **발생했던 문제/실수**: fake D-Bus 테스트는 통과했지만 Pi에서는 bus 접속 정책, callback 메서드의 `this` 손실, Promise/callback 호출 규약, uint64 정밀도 문제로 `CreateNetwork`와 `Attach`가 차례로 실패했다.
- **원인**: 테스트 double이 실제 `@homebridge/dbus-native`의 callback API와 Long.js 반환 형식을 재현하지 않았고, system bus 정책에서 연결 허용과 daemon 응답 수신을 별도 권한으로 보지 않았다.
- **해결 및 예방책**: root/gateway만 private bus 접속을 허용하고 DBus/BlueZ 응답 수신을 명시했다. introspected 메서드는 원 interface에 bind해 callback을 Promise로 변환하며 `ReturnLongjs`의 low/high를 bigint로 저장하고 Attach에는 10진 문자열을 사용한다.
- **반복 방지 체크**: D-Bus wrapper 테스트에는 callback 방식, `this` 의존 메서드, 다중 반환, 64비트 최대 범위를 포함하고 실제 Pi Phase 0를 자동 테스트와 별도 관문으로 유지한다.

## 2026-07-14 / 기본 개발 실행에 mock 장비 혼입
- **발생했던 문제/실수**: 사용자가 실제 조명 검색을 시험하려고 `pnpm dev`를 실행했지만 mock gateway가 함께 시작되어 하드웨어가 꺼진 상태에서도 가짜 후보 4개가 즉시 검색됐다.
- **원인**: 일반 개발 실행과 cloud pipeline 시뮬레이션 실행을 같은 명령으로 묶었고 mock producer의 기본 발견 개수 4가 실제 BLE scan 결과처럼 API DB에 저장됐다.
- **해결 및 예방책**: `pnpm dev`는 API와 Web만 실행하고 실제 gateway MQTT 이벤트만 받는다. 실행 가능한 Mock gateway와 `dev:mock` 경로는 제거하고, 테스트 데이터는 `src/test` 또는 `*.spec.ts` 내부의 불변 fixture로만 격리한다.
- **반복 방지 체크**: 양산 장비 시험 명령에는 mock/stub/simulator process를 포함하지 않고, 가짜 장비 이벤트에는 mock firmware 식별자를 유지해 DB 정리와 감사 시 구분 가능하게 한다.

## 2026-07-14 / 테스트 전용 런타임과 양산 E2E 경로 혼재
- **발생했던 문제/실수**: 웹 mock API, mock gateway, 파괴적 demo seed, legacy MQTT v1이 실제 장비 경로와 같은 workspace와 실행 설정에 남아 있었고 고정 통계·설정 문구가 실제 기능처럼 표시됐다.
- **원인**: 초기 MVP 시뮬레이션 자산을 실제 BlueZ/MQTT v2 구현 뒤에도 제거하지 않았고, 현장 생성과 제조 gateway claim을 별도 흐름으로 구현하면서 전체 온보딩 E2E를 다시 연결하지 않았다.
- **해결 및 예방책**: 제품 런타임의 mock 선택지를 제거하고 테스트 fixture/stub은 test directory로 격리했다. demo seed는 빈 DB 전용 operator bootstrap으로 교체하고 MQTT v1을 제거했다.
- **반복 방지 체크**: 실장비 완료 판정은 `operator -> site/floor -> inventory claim -> assignment -> scan -> provision -> monitor -> v2 ACK control` 전체가 한 번에 실행된 증거가 있을 때만 한다. claim UI 구현만으로 완료 처리하지 않고 Raspberry Pi와 ESP32-H2의 연속 로그를 증거로 남긴다.

## 2026-07-15 / 제조 등록과 배포의 인증서 순환 의존성
- **발생했던 문제/실수**: 배포 스크립트가 claim 뒤에 발급되는 MQTT 인증서를 실행 전에 요구해, image를 올리고 제조 device identity를 생성하는 최초 절차 자체가 막혔다.
- **원인**: 제조 identity, claim, MQTT identity의 발급 순서를 배포 사전 조건과 함께 검증하지 않았다.
- **해결 및 예방책**: image를 먼저 load한 뒤 제조 device identity만 확인하고, MQTT key·CSR·인증서는 claim과 assignment 이후 gateway가 자동 발급한다.
- **반복 방지 체크**: 온보딩 배포 테스트는 `image load -> 제조 등록 -> claim -> bootstrap -> MQTT 발급` 순서를 기준으로 각 단계가 다음 단계 산출물을 미리 요구하지 않는지 검사한다.

## 2026-07-15 / Docker secret scan의 문서 예시 오탐
- **발생했던 문제/실수**: image secret scan이 실제 key가 아니라 dependency README의 예시 PEM을 private key로 감지했다.
- **원인**: 양산 runtime에 필요 없는 Markdown이 node_modules에 포함됐고, 단순 문자열 scan이 실제 secret과 문서 예시를 구분하지 못했다.
- **해결 및 예방책**: runtime image에서 dependency Markdown을 제거하고 image와 배포 archive를 다시 scan한다.
- **반복 방지 체크**: secret scan은 source, runtime image, 배포 archive를 구분해 수행하고, 오탐 제거 후에도 `BEGIN ... PRIVATE KEY` 0건을 증거로 남긴다.

## 2026-08-06 / Playwright API route glob의 source module 가로채기
- **발생했던 문제/실수**: E2E API fixture에 `**/api/**` route를 등록했더니 `/src/api/auth.ts`, `/src/api/queries.ts` Vite module 요청까지 `404`로 처리되어 React가 빈 화면으로 남았다.
- **원인**: Playwright glob은 pathname segment 경계를 강제하지 않으므로 `src/api`도 패턴에 포함된다. fixture handler가 URL pathname을 다시 검사하지 않고 모든 비매칭 요청을 API `404`로 fulfill했다.
- **해결 및 예방책**: route handler 첫 단계에서 `pathname.startsWith("/api/")`를 확인하고 그 외 요청은 `route.continue()`로 넘긴다. fixture data는 E2E support 아래에만 두고, tenant/site 범위를 벗어난 실제 API path만 `404`로 제한한다.
- **반복 방지 체크**: Vite SPA E2E route mock을 추가하면 source module과 asset 요청이 정상 `200`인지, 인증 loading 화면이 아닌 실제 React 화면이 렌더되는지 함께 확인한다.
## 2026-08-13 / Lab PKI도 제품 신뢰 흐름을 우회하지 않기

- **발생했던 문제/실수**: 실제 장비 E2E에 필요한 Vault, Root 서명, 제조 station 준비가 수동 단계로 흩어져 재현하기 어렵고 개발 CA 경로와 혼동될 수 있었다.
- **원인**: PKI 산출물의 소유 경계, 발급 순서와 reset 범위를 하나의 실행 계약으로 검증하지 않았다.
- **해결 및 예방책**: `PKI_ENV=lab` 전용 orchestrator가 persistent Vault, 목적별 intermediate, 별도 제조 CA/station, CRL, 제한 token과 실행 bundle을 생성한다. 제품의 제조 등록, claim, bootstrap, MQTT mTLS API는 그대로 사용한다.
- **반복 방지 체크**: root token/private key 비출력, secret `0600`, loopback Vault, 동일 입력 멱등성, 타 CA·폐기 station 거부와 Lab 디렉터리만 삭제하는 reset을 자동 테스트한다. 실제 Pi/ESP32 증거 없이는 양산 완료로 표시하지 않는다.

## 2026-08-21 / 동일 opcode 비동기 응답 상관관계

- **발생했던 문제/실수**: 같은 source/opcode를 공유하는 BLE Mesh Config Status를 동시에 기다릴 때, 다른 요청의 응답이나 parser 실패가 잘못된 waiter를 먼저 reject시켰다.
- **원인**: source/opcode까지만 맞으면 parser를 바로 실행했고, 요청별 element/group/model 같은 세부 상관관계를 parser 이전에 확인하지 않았다.
- **해결 및 예방책**: 공통 wait API에 request-specific raw matcher를 추가해, parser 전에 해당 요청과 일치하는 raw payload만 waiter가 소비하게 한다.
- **반복 방지 체크**: 동일 source/opcode로 동시에 발행되는 요청은 역순 응답, 타 요청 status failure, malformed payload를 포함한 상관관계 테스트를 유지한다.
