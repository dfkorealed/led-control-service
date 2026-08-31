# 메뉴 완성 작업 상태판

기준일: 2026-08-31

## 현재 마일스톤

**스케줄·차량 감지 이벤트 제어 구현**: shared recurrence, production schema, schedule/차량 이벤트 규칙 API CRUD, Task 9 production MQTT automation 동기화, Task 10 timed manual override, Task 11 Gateway snapshot hot reload, Task 12 offline scheduler·priority arbiter·재시작 복구, Task 13 vehicle runtime·durable execution telemetry, Task 14 Gateway BLE Mesh Sensor Client, Task 15 ESP32-H2 GPIO sensor driver, Task 16 Sensor Server/reliable vendor event와 Task 17 Web 제어 탭·스케줄 CRUD UI를 완료했다. 다음 구현은 Task 18 Web 차량 이벤트 CRUD와 수동 override UI다.

## 작업 상태

| 작업 | 상태 | 내용 |
| --- | --- | --- |
| 에이전트 운영 기반 Task 1 | 완료 | 운영 기준과 지속 갱신 상태판을 작성했다. |
| 에이전트 운영 기반 Task 2 | 완료 | 프로젝트 전용 custom agent 7개의 기본 권한 프로필과 디렉터리별 `AGENTS.md` 소유·검증 규칙을 구성했다. 실제 QA 읽기 전용 검토는 부모 세션도 읽기 전용 권한으로 실행한다. |
| 메뉴 완성 설계 작성 | 완료 | [모니터링·제어·통계 완료 설계](superpowers/specs/2026-08-26-monitoring-control-statistics-completion-design.md)에 재검토를 반영해 migration 시점 에너지 추적과 durable state outbox·application ACK까지 확정했다. |
| 메뉴 완성 구현 계획 | 완료 | [구현 계획](superpowers/plans/2026-08-26-monitoring-control-statistics-completion.md)을 12개 검증·커밋 단위로 작성했다. |
| 메뉴 완성 구현 | 완료(소프트웨어) | Task 13까지 구현·문서·전체 회귀와 실백엔드 설치·고객 운영 Chromium E2E를 통과했다. 실제 Raspberry Pi/ESP32-H2 HIL은 별도 검증으로 남아 있다. |
| 계정·설치 주체 전환 설계 | 완료 | [전역 운영자와 현장 관리자 계정 흐름 설계](superpowers/specs/2026-08-26-operator-admin-account-flow-design.md)에 로그인 아이디, 전역 단일 operator, 현장별 단일 admin, admin 최초 설치와 설정 범위를 정의했고 재설치는 제외했다. |
| 계정·설치 주체 전환 구현 계획 | 완료 | [구현 계획](superpowers/plans/2026-08-27-operator-admin-account-flow.md)을 DB·인증·권한·웹·E2E의 9개 검증·커밋 단위로 작성했다. |
| 계정·설치 주체 전환 구현 | 완료(소프트웨어) | Task 1~9와 final review fix를 완료했다. login/reset/change는 User row lock과 실제 PostgreSQL barrier로 old credential session race를 차단하고, 일반 admin의 command/group/floor write는 transaction 내부 Site lock 재인가를 사용한다. Web은 login 평문을 React Query cache에 넣지 않으며 principal 전환·강제 revoke에서 tenant Query/Mutation cache를 제거한다. service-global operator는 `/operator/site-admins`에서 현장별 assigned admin을 create/update/reset/disable하고 network allowlist는 `/api/auth/*`, `/api/operator/*`뿐이다. 격리 실백엔드 Chromium journey는 새 PostgreSQL/Redis/mTLS Mosquitto와 test-support simulator로 설치·claim·registration·제어·통계·도면·비밀번호·viewer 권한을 검증하며 사용자 개발 DB를 읽거나 초기화하지 않는다. 이는 production Gateway/BlueZ/RF 또는 Raspberry Pi/ESP32-H2 HIL 증거가 아니다. 모바일·재설치는 범위 밖이다. controller가 수동 in-app browser QA를 시도했지만 admin-enforced browser policy가 localhost 접근 전에 차단해 미실행이며 자동 Chromium E2E와 별개다. |
| 모니터링 등록 흐름 보완 | 완료(소프트웨어) | 조명 생성 후에도 유지되는 active session 복구 API·UI, 과거 attempt 미해결 노드 노출, `reconcile_required` 상태 재조회·안전 제외·세션 취소, MQTT 완료 경합 잠금, unresolved 재검색/완료 차단과 fixture benchmark 현장 범위 경로를 구현했다. 실장비 상태 자동 판정과 HIL은 포함하지 않는다. |
| 스케줄·차량 이벤트 제어 설계 | 완료(설계) | 반복 일정, overlap 차단, 수동 override·차량 이벤트·스케줄 우선순위, Gateway full snapshot 무중단 적용, offline 실행과 ESP32-H2 차량 감지 event 계약을 확정했다. Task 7~12에서 API CRUD, production MQTT config와 Gateway offline 실행을 구현했고 Web과 실제 sensor/telemetry 연결은 후속 Task다. |
| 스케줄·차량 이벤트 제어 Task 7 | 완료(소프트웨어) | assigned admin mutation/viewer read 권한, exact Fixture snapshot, 공통 engine overlap, automation advisory lock 후 Site 재인가 동시성, RepeatableRead 기반 bounded keyset 목록, schedule API CRUD와 revision/full-snapshot outbox를 구현했다. 실제 MQTT publish/application ACK는 Task 9, Gateway offline 실행과 schedule Web CRUD는 후속 Task다. |
| 스케줄·차량 이벤트 제어 Task 8 | 완료(소프트웨어) | node-local capability ledger/partial uniqueness, migration baseline reconciliation, canonical hash와 stale/conflict 처리, 3종 `MqttOutbox` row shape, node-scoped durable ACK identity와 lease-safe exact replay revival까지 5차 review fix를 완료했다. Production Gateway report journal은 후속 Task 범위다. |
| 스케줄·차량 이벤트 제어 Task 9 | 완료(소프트웨어, fix round 2) | exact MQTT topic/payload/current active claimed Gateway identity 결합, immutable revision snapshot 기반 execution 검증과 revision/payload 단독 UPDATE DB 재검증, rejected desired의 lower applied ACK 보존, canonical execution 원장과 immutable ingest ACK의 동일 transaction 저장, config/application-ACK 공통 10회·15분 retained deadletter와 `SKIP LOCKED` lease·revival·supersession·shutdown drain을 strict TDD로 구현했다. 실제 broker/Gateway/HIL은 후속 검증이다. |
| 스케줄·차량 이벤트 제어 Task 10 | 완료(소프트웨어) | 수동 dimming 명령의 optional ISO `overrideUntil`을 API clock 기준 기본 `now + 1 hour`, 미래·30일 이내로 검증한다. Command, `ManualOverride`, 모든 fixture snapshot과 direct Gateway payload/outbox를 automation advisory lock 및 Site 재인가가 있는 한 transaction에 저장하며, Web API 타입·생성 응답도 확정 시각을 전달한다. Gateway durable 적용·만료 arbiter는 Task 12에서 완료했고 Web 입력 UI와 HIL은 후속 범위다. |
| 스케줄·차량 이벤트 제어 Task 11 | 완료(소프트웨어) | Gateway가 full snapshot을 strict schema/scope/canonical hash/revision으로 검증하고 temp write·file fsync·rename·directory fsync 뒤 serial hot reload한다. 재시작 복구, exact idempotency/conflict/old rejection과 durable applied/rejected ACK 재전송을 production MQTT runtime에 연결했다. Scheduler·priority arbiter와 실제 BLE Mesh action은 Task 12에서 완료했고 broker/실장비 HIL은 후속 범위다. |
| 스케줄·차량 이벤트 제어 Task 12 | 완료(소프트웨어, fix round 5) | Fix round 4 re-review의 active P1 3건을 TDD로 수정했다. Clock-untrusted restart에서 recovered manual 현재 출력/최고 우선순위를 유지하고, targeted resync unresolved batch를 tail로 회전하며, broker-fresh legacy timed wire에 요청 duration 기반 monotonic deadline과 version 1 진단/30일 상한을 적용했다. Shared 74/74, API 727 passed, Gateway 417/417, Docker 17/17, Mosquitto 2/2 및 typecheck/lint/build로 검증했다. API publisher 선배포가 필수이며 Raspberry Pi/ESP32-H2 RF HIL은 별도다. |
| 스케줄·차량 이벤트 제어 Task 13 | 완료(소프트웨어, fix round 5 breaker) | Fixed journal aggregate의 durable accepted baseline을 기준으로 reimport하고, baseline에 흡수된 뒤 state/journal에서 재생 불가능한 general source receipt를 같은 outbox import commit에서 제거한다. 현재 state pending handoff/gap, current journal source, cumulative source, aggregate와 active baseline identity는 보호한다. Clear 100회 실패와 source 교체, 중간 restart, cleanup definite failure 및 previous·next commit uncertainty에서도 receipt metadata는 O(1)이고 동일 `telemetry_gap` event identity/sequence/final hash와 정확한 count로 수렴한다. 두 4 KiB block, 64 MiB outbox/headroom, local RF 독립성과 application ACK 계약은 유지한다. Gateway 499/499, shared 74/74, Docker 17/17, Mosquitto 2/2 및 Shared/Gateway typecheck·lint·build를 통과했으며 실제 Raspberry Pi power-loss/storage-wear와 ESP32-H2 RF HIL은 별도다. |
| 스케줄·차량 이벤트 제어 Task 14 | 완료(소프트웨어) | Gateway BlueZ application에 Sensor/vendor client를 등록하고 confirmed node의 Sensor Server/vendor server bind와 publication을 exact Config Status로 확인한다. Presence/Motion Status와 strict vendor event를 normalized runtime 입력으로 연결하고 manifest 기반 durable dedupe 뒤 application ACK를 보낸다. Node별 capability report는 실제 binding 상태 변경 때만 revision을 올리며 broker PUBACK과 분리된 exact application ACK 전까지 동일 event/revision/payload/hash를 bounded retry한다. Rejected/hash mismatch는 journal을 보존한다. 실제 ESP32-H2 firmware와 Raspberry Pi/BlueZ RF HIL은 별도다. |
| 스케줄·차량 이벤트 제어 Task 15 | 완료(소프트웨어/target build, fix round 3) | Production trust는 caller env override가 불가능한 고정 unprovisioned policy에서 fail-closed하고, v2 approval과 signed artifact attestation test-only fixture로 CID/source/config/partition 및 app/bootloader/partition-table/otadata exact binding을 검증한다. Sensor task notification gate, queue-empty 재확인과 stable GPIO resync가 create-before-return callback 및 stale timestamp/current overwrite를 막는다. Task 15 clean test-build는 `0xe6790`, free `0x109870`이며 실제 production root, flash, 센서 전기/cache-disabled/RF/HIL은 미실행이다. |
| 스케줄·차량 이벤트 제어 Task 16 | 완료(소프트웨어/target build, breaker) | Pinned ESP-IDF v5.5.1의 server-send 경계를 repository-managed build-only patch로 보완했다. `SERVER_MODEL_SEND` payload/context는 API thread에서 all-or-nothing snapshot하고 allocation/envelope/queue-post 실패는 handler 없이 동기 오류와 exact cleanup, queue 수락은 기존 handler deep-free 1회를 보장한다. Wrong revision/hash와 tampered overlay는 overwrite 없이 fail-closed하며 patch digest를 test manifest v3/production attestation v2에 결속한다. Client send는 유지했고 P2-14 burst/retry와 four-point allocation fault를 actual patched source/production host fake로 검증했다. Gateway 547/547, shared 75/75와 patched ESP-IDF fullclean test-build를 통과했으며 binary `0xefa30`, OTA free `0x1005d0`이다. Global IDF checkout은 pristine이고 production trust는 정상 fail-closed, 실제 flash/RF/HIL은 미실행이다. |
| 스케줄·차량 이벤트 제어 Task 17 | 완료(소프트웨어/Web unit, fix round 5) | `mode=manual|schedule|event` roving tabs, admin schedule CRUD·활성화, viewer read-only 목록, 현장 timezone 날짜·Gregorian yearly 검증·once/daily/weekly/monthly/yearly·자정 통과 한 구간·dimming·최대 1,000개 target form, Gateway sync와 production action-result 집계, pagination/polling 비차단 오류, scope 세대가 보호된 `401` principal 만료 처리를 구현했다. Fix round 2에서 narrow browser subpath/lazy-load로 shared CommonJS root 유입을 제거하고, fix round 3에서 executable `dist/esm`과 packed ESM/CJS consumer를 고정했으며, fix round 4에서 manifest cleanup의 `dist` root/parent/target symlink 추적을 fail-closed했다. Fix round 5는 colon/backslash, drive-relative, ADS, UNC/device와 terminal dot/space를 모든 host에서 mutation 전에 거부한다. Shared 96/96, Web 334/334, API/Gateway typecheck/build/import smoke와 main `1,028.66 kB / gzip 313.70 kB` bundle audit를 통과했다. Production API/Gateway Chromium E2E와 Raspberry Pi/ESP32-H2 HIL은 미실행이고 이벤트 탭은 Task 18 준비 상태다. |

## 다음 단계

**다음 구현은 Task 18 Web 차량 이벤트 CRUD와 수동 override UI다.** 이후 software E2E와 HIL 순서로 진행한다. Native/target build와 Docker Mosquitto, Web unit 결과를 production Gateway identity·BlueZ/RF·실장비 완료로 확대 해석하지 않는다.

## 알려진 미해결 항목

### 모니터링

- 진행 중인 조명 검색·등록 세션은 브라우저 새로고침 뒤 자동 복구된다. `reconcile_required`는 자동 재시도하지 않으며 실제 장비 상태의 자동 질의·정리는 Raspberry Pi/ESP32-H2 HIL과 함께 후속 검증해야 한다.

### 제어

- 저장 구역 CRUD, ready 차단, 요청 멱등성, ACK 대상·종합 상태 검증과 개별·다중·층·구역 동기 제어는 구현됐다.
- Gateway Config Model Subscription Add/Delete와 실제 조명 제어는 Raspberry Pi/ESP32-H2 HIL에서 검증해야 한다.
- 스케줄 규칙은 Web admin CRUD·활성화와 viewer read-only, Gateway 동기화·fixture 결과 집계·pagination/polling 복구·세션 만료까지 연결했다. 차량 이벤트 규칙 Web CRUD와 수동 override 종료 시각 입력은 Task 18 범위로 아직 구현되지 않았다.
- 차량 센서 capability report/ACK, Gateway exact ACK와 ESP32-H2 GPIO/Sensor/vendor model은 소프트웨어와 target build에서 연결됐다. 실제 Raspberry Pi/BlueZ와 ESP32-H2 사이 provisioning, Sensor Get/Status, vendor packet loss·retry·ACK, reboot/reprovision 및 Health fault RF 왕복 HIL은 아직 실행하지 않았다.

### 통계

- 상태 이벤트 기반 오늘·월·년 집계, 일·월 차트, 180초 projection, 예상 비용과 24시간 100% 기준 절감량을 구현했다.
- 실제 ESP32-H2 상태 publication을 장시간 수집하는 HIL은 실행하지 않았다.

### 계정 인계

- viewer 초대 토큰 소비 API는 호환으로 유지하지만 공개 회원가입 UI는 제거됐다. 운영자용 고객 관리자 CRUD 웹 UI는 Task 7에서 완료했으며 viewer 초대 발급 UI는 후속 범위다. 현재 제조·운영 절차에서 필요한 viewer record를 준비해야 한다.

### 실장비 검증

- Raspberry Pi, MQTT broker, ESP32-H2를 연결한 검색·등록·제어·상태 수집 HIL은 아직 실행하지 않았다.

## 기록 원칙

이 문서는 현재 상태 요약의 정본이다. 활성 작업의 세부 실행 단계는 `writing-plans` 체크리스트에서 관리하며, 상태가 바뀌면 두 기록을 함께 일치시켜 갱신한다. 장기 설계와 미구현 계획은 기존 설계·계획 문서를 유지하며, 완료 여부를 실제 자동 검증과 HIL 증거에 맞춰 갱신한다.
