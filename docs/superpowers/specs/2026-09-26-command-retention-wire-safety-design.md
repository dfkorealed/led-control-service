# 중앙 명령 3개월 보관의 MQTT 전송 안전 설계

기준일: 2026-09-26
상위 설계: [Final Atlas 제품 적용과 API 확장](2026-09-25-final-atlas-product-api-extension-design.md)

## 목적과 승인 범위

중앙 DB 서버의 `Command` 원본 및 상세를 생성 시각으로부터 최근 3 calendar months가 지나면 물리 삭제하되, 삭제된 Set이 MQTT 지연 발행·중복 전달·재연결 때문에 이후 조명을 움직이지 않게 한다. 사용자는 중앙 DB의 원본도 삭제하고, 기존 제어·모니터링 기능은 살리며, 담당 에이전트별 구현을 요청했다. 이 문서는 기존 보관·복구 설계 중 **발행기와 Gateway 사이의 마지막 안전 경계**만 구체화한다. DB 초기화 허용은 개발용 disposable DB 검증 범위이며 운영 DB 초기화·migration·배포 승인으로 해석하지 않는다.

사용자가 승인한 정책은 다음과 같다. **중앙 DB Command에서 발행한 MQTT dimming Set**은 Gateway가 중앙 DB 기준 시각의 보수적 상한을 확인하지 못하면 RF 실행을 금지한다. Gateway 로컬 일정·센서/이벤트 자동화는 별도의 기존 시계·안전 정책을 유지한다. Get/status-check, 모니터링 수집, 장치 heartbeat도 이 Set 차단 정책의 대상이 아니다. Gateway 로컬 journal·telemetry outbox·automation state의 기존 보관/삭제 정책은 변경하지 않는다.

## 현재 반례와 불변 조건

현재 API의 PostgreSQL shared advisory transaction lock은 MQTT publish callback까지 유지되지만 DB 세션이 끊기면 lock이 먼저 해제된다. 이미 MQTT.js에 넘긴 QoS1 packet은 그 뒤 브로커에 처음 수락될 수 있다. 브로커의 `messageExpiryInterval`은 그 첫 수락 시점부터 계산되므로 원본 purge 이전에 만든 10초 Set이라는 사실만으로 안전하지 않다. 반대로 브로커가 미리 받은 packet도 Gateway persistent session의 지연 전달/DUP이 가능하다. Gateway의 현 `clockTrust.isTrusted(now) && isGatewayCommandExpired(...)`는 시계가 불신뢰일 때 절대 만료 검사를 생략한다. 기존 systemd marker와 5분 rollback 감지는 API/DB 시각과 Gateway의 ±2초 상한을 보증하지 않는다.

따라서 실제 원본 삭제 전까지 다음을 모두 만족해야 한다.

1. 삭제된 명령 세대의 API 인스턴스가 새 Set을 브로커에 수락시키지 못한다. DB 세션 유실, 프로세스 재시작, MQTT reconnect와 deferred outgoing store도 같은 조건을 따른다.
2. 삭제 전에 이미 수락되거나 Gateway에 전달된 Set은 DB가 지정한 `expiresAt` 이후 RF를 시작하지 않는다. Gateway 시각 증거가 없거나 손실되면 실행하지 않는다.
3. RF 송신이 이미 시작된 뒤의 시간 초과·연결 손실은 `not_applied`로 단정하지 않고 기존 partial/unknown·상태 확인 경로로 수렴한다. Set 재발행으로 복구하지 않는다.
4. 이 증거가 없거나 관련 구버전 API/Gateway가 남아 있으면 protected retention worker의 운영 purge는 계속 OFF다. 읽기 하한과 backlog 경보는 별개로 유지한다.
5. Central DB 시각이 전진/후퇴하거나 DB 주 노드가 바뀌는 동안에는 보관 경계와 Set 만료를 신뢰하지 않는다. 시각 건전성 재확립과 새 epoch의 drain 전에는 purge가 진행되지 않는다.

## 접근법과 선택

앱 프로세스의 `Date.now()` 또는 systemd 동기화 marker만 신뢰하는 방식은 DB와의 실제 편차 상한을 증명하지 못한다. MQTT TTL만 의존하는 방식은 늦은 첫 publish와 이미 전달된 QoS1을 막지 못한다. 선택한 방식은 **DB 시각을 상한으로 환산하는 Gateway 실행 경계**와 **브로커가 구세대 발행을 거부하는 API 발행 경계**를 함께 두는 것이다. 어느 한쪽만 완성되어도 purge를 활성화하지 않는다.

## Gateway의 Set 시간 증명

- Gateway는 기존 mTLS MQTT 연결에서 자기 `siteId/gatewayId`와 무작위 nonce가 포함된 비보존 시간 질의를 보낸다. broker ACL은 해당 Gateway principal만 자기 scope의 질의 topic에 발행하도록 제한한다. API는 topic scope와 payload scope가 일치할 때에만 primary PostgreSQL `clock_timestamp()`와 active `CommandPublishEpoch`를 같은 primary DB에서 읽고, 동일 nonce·scope·DB UTC 시각·epoch를 비보존 응답으로 보낸다. 응답 topic은 API 발행 principal만 쓸 수 있고 해당 Gateway만 읽을 수 있어야 한다. 응답은 화면/다른 현장/타 Gateway 데이터와 섞이거나 cache되어서는 안 된다. DB 조회·MQTT 연결·시각 건전성 검사에 실패하거나 epoch가 quiescing/fenced면 유효한 새 Set 표본을 주지 않는다.
- Gateway는 요청 직전과 응답 직후의 동일 부팅 세대의 suspend 포함 단조 시각을 기록한다. nonce·scope·응답 형식·순서를 검증한 뒤 DB 응답 시각에 전체 왕복시간과 단조 시계 오차 예산을 더한 값을 **현재 DB 시각의 상한**으로 사용한다. 이후 경과시간도 같은 단조 시각에서 더한다. 표본 최대 사용 나이는 10초, 왕복시간 상한은 1초, 해당 10초 동안의 단조 시계 오차 예산은 100ms다. 왕복시간이 상한을 초과하거나 누적 불확실성이 기존 `GATEWAY_COMMAND_EXPIRY_CLOCK_SKEW_GUARD_MS` 2초에 닿거나 부팅/단조 시계 연속성을 잃으면 표본은 즉시 무효다. 이 수치는 보수적인 출시 상한이며 완화에는 측정/HIL 근거와 별도 설계 변경이 필요하다.
- MQTT dimming Set wire에는 발행 `epoch`를 포함한다. Gateway는 최초 수신, durable journal 수락 직전, queue dequeue, 각 실제 BlueZ/BIO RF 송신 직전에 `표본 epoch = Set epoch` 및 `DB 상한 < expiresAt - 2초`를 다시 검사한다. 수신 시 만들어진 짧은 상대 TTL도 별도로 적용해 둘 중 더 이른 제한을 따른다. 시간 확인을 기다리는 동안 packet을 무기한 보류하지 않는다. 증거 없음/만료 시 terminal refusal을 journal과 ACK에 내구적으로 기록하고 RF/수동 자동화 handoff/fixture state 성공 기록을 만들지 않는다. 기존 만료 ACK의 `COMMAND_EXPIRED`는 그대로 쓰고, 시각/epoch 증거 없음만 새 `GATEWAY_CLOCK_UNTRUSTED`로 구분한다. shared ACK schema와 API 상태 매핑을 함께 검증한다. 동일 packet DUP은 journal의 같은 terminal 결과를 재전달하며 재실행하지 않는다.
- `journal.accept` 뒤이지만 RF 전인 거부에서도 성공 handoff를 하지 않는다. `manualControlCoordinator.prepare`가 이미 `pendingManualControls`를 영속화했다면, 별도 내구적 abort/rollback을 기록해 그 pending 상태를 해제하고 로컬 일정·센서 자동화의 기존 실행을 복구한다. 재시작 중간에도 terminal refusal과 abort를 재생해 미해결 pending이 남지 않도록 한다. RF가 시작됐거나 여부를 모르면 abort로 성공/비적용을 단정하지 않고 기존 unknown/partial·status-check로 보낸다. ACK는 이 상태 전이 뒤 내구적으로 재전달한다.
- RF 시작 뒤 신뢰가 사라진 경우에는 송신 가능성을 보존하는 기존 unknown/partial 결과와 status-check를 사용한다. Gateway의 로컬 일정·센서 자동화는 이 DB 시각 질의를 호출하지 않고 기존 `ClockTrustProvider` 정책을 그대로 사용한다. Get/status-check와 상태 수집은 Set 전용 거부 코드로 막지 않는다.
- 구형 바이너리 또는 suspend 포함 단조 시각을 제공하지 않는 Gateway는 purge 안전 대상으로 인증하지 않는다. 배포 목록에서 모든 활성 subscriber의 업그레이드 또는 구세대 세션 차단을 확인해야 하며, 단순 오프라인은 안전 증거가 아니다.

DB 주 노드의 시각 동기화/step 감시가 건강하고 허용 오차 100ms 이내인 경우에만 시간 응답과 purge cutoff를 사용한다. 감시 실패, 100ms 초과 step, primary failover 또는 DB 세션 세대 변경은 전체 Set 시간 표본·발행 epoch를 무효화하고 새 세대로 재동기화한다. 이미 Gateway가 cache한 표본은 최대 10초 동안 남을 수 있으므로 purge는 아래의 독립 단조 대기/실행 drain을 지나야 한다. 이 대기는 DB wall clock을 기준으로 단축하지 않으며 프로세스 재시작 시 처음부터 다시 시작한다.

## API 발행 세대와 브로커 차단

- 중앙 DB에 단일 active `CommandPublishEpoch`와 인스턴스별 generation member/ack를 둔다. epoch는 `active → quiescing → fenced → retired`로만 전진한다. Set 발행기는 시작 시 등록하고, 기존 shared DB permit 안에서 현재 세대/상태·DB cutoff·lease·payload를 다시 확인한다. 등록되지 않은 인스턴스나 DB 확인 불능 인스턴스는 새 Set을 발행하지 못한다. 기존 한 worker에 섞인 `dimming`과 legacy `status_check`의 **claim·prepare·publish 전 경로**를 kind/topic별로 분리해 Set epoch/quiesce가 원본 만료 전 Get을 막지 않도록 한다. 원본 만료 후 Get-only recovery publisher도 독립 상태를 유지한다. 기존 공용 `MqttService.publishTopic`을 실수로 Set topic에 호출해도 broker ACL이 거부해야 한다. Get/상태 수집의 기존 연결은 유지한다.
- Command Set 발행은 기존 API 전체 MQTT 수신/발행 클라이언트와 분리한 generation-scoped mTLS client를 사용한다. 명령 topic에 대한 publish ACL은 해당 세대 identity에만 부여한다. 현재 개발/운영 ACL의 `api-service` `sites/#` 광역 허가는 필요한 수신·비Set 발행 topic의 명시적 권한으로 좁히고, 구 API identity의 dimming publish 거부와 기존 비Set 기능 보존을 함께 검증한다. 복구 Get까지 같은 identity를 공유하더라도 Set quiesce가 Get의 정상 동작을 불필요하게 차단하지 않도록 topic 권한을 분리한다. 구세대 identity의 ACL 제거, 연결 강제 종료, persistent session/outgoing queue 폐기와 **새 publish 거부 확인**을 broker-side fence의 필수 증거로 기록한다. 클라이언트의 `end()` callback이나 API의 DB ack만으로 broker fence를 선언하지 않는다.
- Purge 준비는 exclusive DB permit 아래 active epoch를 `quiescing`으로 전환해 새 Set claim/prepare를 막는다. 연결된 등록 인스턴스는 in-flight publish 중지 및 명령 전용 MQTT egress 종료를 ACK한다. 응답 없는 member는 시간 초과만으로 안전 처리하지 않고, 그 identity의 broker-side 거부·세션 폐기와 배포 목록 확인을 별도 증거로 남긴다. 모든 broker 노드에서 구세대 identity의 새 publish 거부, 기존 연결 종료, session/queue 폐기를 확인해야 `fenced`로 전진한다. 보호된 attempt envelope가 모든 미확정 Set의 최대 absolute `expiresAt`을 제공해야 하며, 누락·구형 packet·검증 불능이면 purge를 중단한다. fence 시 primary DB 시각과 그 최대 만료 시각의 차이(기존 publisher 2초 lead 포함), Gateway 표본 최대 나이 10초 중 **더 긴 시간**에 실장비로 측정한 submit→RF 상한을 더해 **DB wall clock과 독립적인 단조 대기**를 수행한다. 배포된 Gateway마다 BlueZ/BIO 제출 대기열과 이미 제출한 명령의 실제 RF 종료/취소를 확인하고, 오프라인 subscriber도 구세대 session 폐기·Gateway 버전 증빙 또는 물리 격리를 확인한다. DB failover/시각 step/worker 재시작 시 barrier를 폐기하고 새 fence·최대 만료 검증·전체 대기를 처음부터 반복한다. 하드웨어 상한이나 drain을 증명하지 못하는 Gateway가 있으면 purge는 계속 OFF다. 그 뒤 protected worker가 같은 epoch·시각 건전성·broker/Gateway drain 증거를 재검증하며 `createdAt < cutoff` 원본을 삭제한다. 새로운 epoch는 삭제 거래와 충돌하지 않게 그 뒤 활성화한다.
- broker ACL/세션 조작이 실패하거나 세대별 identity provisioning이 준비되지 않으면 purge는 OFF로 유지하고 만료 backlog를 경보로 보인다. 누락된 member를 자동 만료시키거나 DB lease만 믿어 삭제하지 않는다. 기존 전역 `clean:false` MQTT client의 24시간 persistent session과 lenient close timeout은 구세대 차단 증거가 아니다.
- broker 설정은 재시작/롤백 후에도 구세대 identity가 되살아나지 않도록 **broker admission 단계의 단조 최소 세대**와 해당 구세대 mTLS 인증서의 되돌릴 수 없는 폐기 원장을 유지한다. broker 프로세스는 ACL/CRL 파일만 과거 버전으로 복원되어도 최소 세대보다 오래된 identity를 거부하거나 기동을 거부해야 한다. 모든 broker 노드에서 이를 검증하며, 검증 불능·노드 불일치·이전 ACL 복원은 새 epoch 및 purge를 중지한다. 이미 완료된 purge 뒤에는 구세대 credential을 다시 허가하지 않는다. 운영 broker가 이 반롤백 경계를 제공하지 못하면 소프트웨어 테스트 통과와 관계없이 purge는 계속 OFF다.
- epoch/멤버/브로커 증명 기록에는 명령 payload·원문 idempotency key를 저장하지 않는다. 모델 추가 시 `docs/database-schema.md`를 갱신한다. 중앙 DB Command 상세의 3개월 물리 삭제와 최소 safety digest/hold 보존은 상위 설계 그대로다.

## 배포 및 실패 시 동작

순서는 (1) additive 공유 wire schema와 DB 시각 query/응답, (2) 새 epoch Set을 이해하는 Gateway 코드와 generation-scoped 발행기 배포, (3) 모든 구 API/Gateway 연결의 확인·drain과 broker ACL/세션 fence, (4) 현장별 fail-closed cutover와 disposable DB+broker fault 검증, (5) 운영 credential·HIL 확인, (6) 보호 worker 운영 활성화다. 전환 전 Gateway는 기존 wire를 기존 방식으로 처리하지만 purge는 OFF다. 전환 후에는 epoch 없는 legacy Set도 terminal 거부하며, 구 API/Gateway가 하나라도 남은 현장에는 cutover/purge를 켜지 않는다. API/DB/broker 시간 서비스 장애에는 Set이 정제된 실패/재시도 가능 상태로 남고, 안전하다고 추정해 RF로 우회하지 않는다. 명령 원본 삭제는 지연되고 backlog가 보이지만, 이미 지운 원본을 되살리지 않는다.

모니터링 로그 최근 3개월과 제어 명령 이력 최근 3개월의 사용자 표시/조회는 기존 설계를 유지한다. 이번 Set 차단의 운영 상태와 오류는 제어 화면에 기존 명령 결과/상태 확인 affordance로 표시하고, 별도 위험 승인 없이 자동 재실행하지 않는다. 화면 변경 시 `docs/menus/control.md`, 모니터링 상태 표시를 바꾸면 `docs/menus/monitoring.md`를 같은 작업에서 갱신한다.

## 검증과 완료 판정

- Gateway unit/integration: 정상 DB 표본과 2초 경계, 오래되거나 다른 nonce/scope/epoch 응답, 1초 초과 왕복, DB 시간 step/failover, boot/suspend/monotonic discontinuity, journal fsync·queue·각 RF 직전 만료, 24시간 journal 정리 뒤 QoS1 DUP의 RF 0을 검증한다. `journal.accept` 뒤 refusal에서 `prepare`가 저장한 pending 수동 상태의 내구적 abort·재시작 복구를 확인한다. 기존 로컬 일정·센서 자동화, 원본 만료 전후 Get/status-check, 수집은 회귀 테스트로 보존한다.
- API disposable PostgreSQL+Mosquitto: API 2개 이상에서 DB backend kill로 permit 유실, deferred QoS1, PUBACK 손실, offline Gateway queue, old generation reconnect/publish, missing member ack, broker ACL reload/재시작/롤백·강제 종료, quiesce와 purge 동시성을 반증한다. legacy Get과 recovery Get은 Set quiesce 동안 계속 동작해야 한다. **purge commit 뒤 old Set broker 수락 0, 조명으로 새 RF 송신 시작 0**이 핵심 assertion이다.
- API/Gateway contract: terminal refusal ACK의 site/gateway/dispatch/target 귀속, late ACK와 hold의 일관성, raw Set 재시도 0, 원본 삭제 뒤 Get-only recovery의 정상 동작을 확인한다. 전체 API/Gateway 단위·통합·빌드와 관련 Web Chromium을 재실행한다.
- 실제 중앙 DB 및 장비에서 migration/worker/ACL을 켜기 전 운영 권한·자격증명·구버전 연결 목록과 Raspberry Pi/BlueZ/BIO HIL이 별도로 통과해야 한다. 이 문서와 disposable 검증만으로 production purge, recovery POST 또는 하드웨어 동작을 활성화했다고 주장하지 않는다.
