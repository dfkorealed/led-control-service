# SDD ledger — plan: docs/superpowers/plans/2026-08-26-monitoring-control-statistics-completion.md

## 사전 충돌 검사

| Task | 공유 파일·인터페이스 | 판정 |
| --- | --- | --- |
| 1 → 2,4,5,6,8,9 | Prisma와 shared MQTT/API 계약 | Task 1을 먼저 커밋하고 소비 Task를 순차 진행한다. |
| 2 → 3 | scan lifecycle API/MQTT → Web | 계약과 API 검증 뒤 Web을 적용한다. |
| 4 → 5 → 7 | group CRUD/desired state → Gateway reconcile → Web | 세 Task를 순차 진행한다. |
| 5 → 6 | `mqtt.service.ts` ACK 처리와 command 멱등성 | Task 5 커밋 후 Task 6이 최신 파일을 기준으로 작업한다. |
| 8 → 9 → 10 | energy aggregate → query API → Web | 세 Task를 순차 진행한다. |
| 3,7,10 → 11 | 기능별 browser QA → 전체 E2E | 기능별 QA가 통과한 뒤 전체 journey를 작성한다. |
| 1~11 → 12 | 메뉴 문서·상태판·전체 검증 | 마지막에 실제 증거로만 완료 상태를 갱신한다. |

각 Task의 테스트·구현·문서 범위는 Spec과 일치한다. production mock 금지와 실장비 HIL 분리 원칙을 모든 Task에 적용한다.

## 진행 기록

- 기준 커밋: `dc33614`
- Task 1: 구현 커밋 `29c4130`, 독립 리뷰 결과 수정 필요
- Task 1 Fix round 1: API/Gateway 빌드 회귀, desired-set 계약, migration 불변식·실동작 테스트, v2 scan envelope, 공유 group/energy 계약 보완 진행 중
- Task 1 Fix round 1 커밋 `5e435a4`: 재리뷰에서 4건 해결, scan strict payload·provision topic·입력 diff 완전성·energy schema·실 DB 추가 사례·오류 복구/노출 관련 8건 잔존
- Ruling: PostgreSQL integration test는 기본 단위 테스트에서 env-gated를 유지한다 — CI의 외부 DB 의존성을 강제하지 않되 명시적 로컬 명령으로 실제 적용을 검증한다 — 잘못 판단하면 CI용 ephemeral DB 구성이 추가로 필요하다.
- Task 1 Fix round 2: 잔존 Critical/Important finding 수정 진행 중
- Task 1 Fix round 2 커밋 `8b2639e`: 9건 중 7건 해결, 주소 변경 delete/add 표현과 부분 성공 durable applied snapshot 2건 잔존
- Task 1 Fix round 3: 잔존 group reconciliation 두 건 수정 진행 중
- Task 1 Fix round 3 커밋 `69749a8`: 기존 두 건 해결, API가 주소 교체 부분 실패를 마지막 성공으로 덮는 새 Important 1건 발견
- Task 1 Fix round 4: fresh 상위 모델 구현자가 API fail-closed aggregate 판정 수정 진행 중
- Task 1 Fix round 4 커밋 `360e26d`: 독립 재리뷰 승인, 새 Critical/Important 없음
- Task 1: complete (`29c4130`, `5e435a4`, `8b2639e`, `69749a8`, `360e26d`)
- Task 2: 구현 커밋 `1d3709b`, 독립 리뷰 결과 수정 필요
- Task 2 Fix round 1: scan 전용 durable outbox, terminal 완료 guard, create 409, event ordering/dedupe, identify access, negative test와 문서 정합성 보완 진행 중
- Task 2 Fix round 1 커밋 `ed9b058`: 기존 finding 해결, legacy session migration·publisher timeout·Gateway durable replay 멱등성 3건 새로 발견
- Task 2 Fix round 2: legacy backfill, bounded MQTT publish, Gateway logical scan journal 구현 진행 중
- Task 2 Fix round 2 커밋 `5c52d50`: 기존 3건 해결, broker redelivery 없는 Gateway 재시작 journal 자동 drain 1건 잔존
- Task 2 Fix round 3: connect-ready startup recovery와 terminal publish drain 구현 진행 중
- Task 2 Fix round 3 커밋 `adc3c33`: startup race와 broker ACK/API commit 경계, undelivered retention, stalled publish 4건 잔존
- Task 2 Fix round 4: fresh 상위 모델 구현자가 scan terminal application ACK와 recovery 수명 보완 진행 중
- Task 2 Fix round 4 커밋 `c1a9aa2`: application ACK 기반으로 전환했으나 same-connection 재전달과 Gateway ACL self-publish 2건 잔존
- Task 2 Fix round 5: connected retry scheduler와 ACK ACL 최소 권한 수정 진행 중
- Task 2 Fix round 5 커밋 `93eb55c`: ACL 해결, 최초 terminal publish stall 전 scheduler wake-up 1건 load-bearing 잔존
- Ruling: Round 5 breaker의 load-bearing finding은 journal persist 직후 scheduler wake-up을 직접 추가해 해소한다 — 최초 publish 결과를 기다리지 않고 recovery retry가 소유권을 가진다 — 잘못 판단하면 동일 logical terminal의 추가 duplicate가 생기지만 API event idempotency와 exact ACK가 이를 수렴시킨다.
- Task 2 breaker 해결 커밋 `f0c2259`: 독립 확인에서 finding 해결, 새 Critical/Important 없음
- Task 2: complete (`1d3709b`, `ed9b058`, `5c52d50`, `adc3c33`, `c1a9aa2`, `93eb55c`, `f0c2259`)
- Prerequisite `575a563`: Task 1 `clientRequestId` 계약으로 깨진 Web typecheck를 UUID 제출로 복구; 응답 유실 재사용은 Task 6에서 완성
- Task 2 Fix round 5 커밋 `93eb55c`: 동일 연결 bounded terminal retry와 Gateway application ACK read-only ACL을 구현하고 실제 host Mosquitto negative ACL을 통과했다. 독립 재리뷰 대기 중.
- Task 4: 구현 커밋 `59dbbcf`: operator/admin 저장 구역 CRUD, viewer read-only와 site 경계, floor/gateway/fixture lock 및 15개 한도, full desired membership/version, retiring empty set/ACK retired와 resync를 API에 구현했다. API 전체 452 tests, typecheck/build, isolated PostgreSQL migration rehearsal을 통과했다. Task 5에서 Gateway Config Model Delete HIL과 ACK 전체성 검증을 이어 간다.
- Task 3: 구현 커밋 `faa3a74`, 독립 리뷰에서 P0 1건, P1 2건, P2 2건으로 수정 필요 판정
- Task 3 Fix round 1: 실제 retry 응답 shape, 새 attempt 중 stale 후보 차단, 기본 dashboard key invalidation, 층별 지도 오류 상태와 polling 회귀 테스트를 Web 범위에서 수정 진행 중
- Task 3 Fix round 1 커밋 `48e6812`: 기존 P0/P1/P2 대부분 해결, 서로 다른 API/Gateway wall-clock으로 attempt를 추론하는 Important 1건 잔존
- Ruling: scan candidate의 current-attempt 판별은 timestamp가 아니라 API가 검증한 `scanCorrelationId`와 `scanAttempt` exact match로 고정한다 — 장비 clock skew/correction과 무관하게 stale 후보를 차단한다 — 잘못 판단하면 legacy node가 숨겨지지만 재검색으로 현재 identity를 다시 얻을 수 있다.
- Task 3 Fix round 2: DiscoveredMeshNode attempt identity 영속화와 API/Web exact-match 회귀 테스트 진행 중
- Task 4: 구현 커밋 `59dbbcf`, 계획 기록 `ed56d37`; 독립 리뷰에서 P1 4건, P2 2건으로 수정 필요 판정
- Task 4 Fix round 1 대기: Task 3 Fix round 2와 `mqtt.service.ts`가 겹치므로 해당 커밋 완료 뒤 ACK 완전성, retiring resync, legacy/gateway 변경, dashboard metadata, P2002 transaction, SiteAccess 우선순위를 수정한다.
- Task 4 Fix round 1 커밋 `28ee298`: dashboard/P2002/SiteAccess는 해결, reconnect operation reset, gateway 이동 old cleanup 소유권, address replacement 2-operation exact ACK의 P1 3건 잔존
- Task 4 Fix round 2 대기: Outbox Fix round 2가 `mqtt.service.ts` 수명을 먼저 정리한 뒤 version별 operation tuple과 cleanup ownership을 수정한다.
- Task 3 Fix round 2 커밋 `5196e8e`: scan identity를 DiscoveredMeshNode에 영속화하고 Web exact correlation/attempt match로 전환; 독립 재리뷰 진행 중
- 실제 브라우저 QA 중 API background `MqttOutbox` claim transaction의 P2028 timeout이 unhandled rejection으로 process를 종료하는 현상을 재현했다. 두 outbox worker의 single-flight/error containment TDD 수정 진행 중이다.
- Outbox crash fix 커밋 `84fba86`, Fix round 1 `eae91dc`: rejection 격리, single-flight, 로그 정제와 worker hook drain을 구현했으나 Nest provider 병렬 destroy에서 MQTT client가 먼저 종료될 수 있는 Important 1건 잔존
- Outbox Fix round 2 대기: Task 4가 같은 `mqtt.service.ts`를 수정 중이므로 해당 커밋 뒤 명시적 drain/close coordinator와 실제 Nest lifecycle 회귀 테스트를 추가한다.
- Outbox Fix round 2 커밋 `9382979`: `MqttShutdownCoordinator`가 두 worker drain 뒤 bounded MQTT close를 직렬화; 독립 재리뷰 진행 중
- Outbox Fix round 2 재리뷰: 두 outbox는 해결됐으나 `MeshGroupSyncWorker` active run과 inbound MQTT handler가 shutdown close와 경쟁하는 Important 1건 잔존
- Outbox Fix round 3 대기: Task 4 Fix round 2 뒤 coordinator가 모든 MQTT producer를 drain하고 inbound handler를 detach/contain하도록 production module lifecycle test로 보완한다.
- Outbox Fix round 3 구현: `MqttShutdownCoordinator`가 command/scan outbox, Mesh group sync와 inbound handler를 모두 drain한 뒤 MQTT client를 닫도록 수명 주기를 일원화했다. production `MqttModule` close 회귀 테스트로 active mesh publish와 resync ACK handler가 끝나기 전 `client.end()`가 호출되지 않고 inbound rejection이 process 경계 밖으로 새지 않음을 검증했다.
- Task 4 Fix round 2: reconnect operation reset, current gateway cleanup ownership, 동일 node address replacement의 version별 두 operation exact ACK 영속화를 진행 중
- Task 8 사전 조사 완료: `.superpowers/sdd/2026-08-26-monitoring-control-statistics-completion/task-8-preflight.md`
- Ruling: Task 8 범위에 Gateway state producer(`index.ts`), sticky health/capacity reservation, Floor Editor ratedWatt 경계, timezone 의존성, PostgreSQL integration을 추가한다 — runtime 파일만 바꾸면 상태 유실과 잘못된 적산이 남는다 — 잘못 판단하면 작업 범위가 커지지만 양산 데이터 정합성 요구를 충족한다.
- Ruling: fixture-state QoS 1은 API DB commit 뒤 MQTT 5 success ACK, 실패 시 redelivery 가능한 persistent session 경계를 구현한다 — broker PUBACK만으로 Gateway durable record를 지우지 않는다 — 잘못 판단하면 duplicate delivery가 늘지만 eventId/sequence idempotency로 수렴시킨다.
- Task 3 실제 브라우저 QA: 로컬 DB migration 적용 후 API/Web/MQTT를 재기동했고 잘못된 로그인 거부, 실제 DB 계정 로그인, 게이트웨이·조명 미등록 empty state, console error 없음까지 확인했다. 실제 scan 성공/실패/0건은 HIL 장비 경계로 미실행이다.
- Task 10 사전 조사 완료: `.superpowers/sdd/2026-08-26-monitoring-control-statistics-completion/task-10-preflight.md`
- Ruling: Task 9는 series 응답 wrapper와 `from`/`to` 포함 경계를 shared/API 테스트로 먼저 고정한다 — Web과 API의 기간 경계 불일치를 방지한다 — 잘못 판단하면 마지막 일/월이 중복 또는 누락될 수 있다.
- Ruling: Task 10은 계획 파일 목록에 없던 `App.tsx`, `App.test.tsx`, `mvp1.spec.ts`도 수정 범위에 포함한다 — 새 energy API가 site-scoped이므로 기본 `/statistics`와 기존 회귀를 유지하는 데 필수다 — 잘못 판단하면 기본 현장 통계가 조회되지 않는다.
- Task 6: 동일 canonical 요청 재사용, payload conflict 409, 동시 P2002 새 transaction 재조회와 Web `sessionStorage` 응답 유실 재시도를 구현했다. API 490 tests/typecheck/build, Web focused 52 tests/typecheck/build를 통과했다. 전체 Web은 기존 `App.test.tsx`의 테스트 간 sessionStorage 미초기화로 215개 중 1개가 실패하며 해당 파일은 독립 write scope 밖이라 상위 통합 단계로 넘긴다. 실장비 HIL과 실제 브라우저 네트워크 응답 차단은 Task 7에서 수행한다.
