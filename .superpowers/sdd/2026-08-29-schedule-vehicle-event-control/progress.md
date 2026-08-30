# SDD ledger — plan: docs/superpowers/plans/2026-08-29-schedule-vehicle-event-control.md

## 실행 결정

- 현재 branch `codex/mvp1-cloud-web`에서 작업한다. 기존 사용자 지시에 따라 별도 worktree를 만들지 않는다.
- Spec `docs/superpowers/specs/2026-08-29-schedule-vehicle-event-control-design.md`를 최종 권위로 사용한다.
- 새 동작은 TDD의 RED → GREEN → REFACTOR를 지키고, Tasks 1~3의 기존 dirty 변경은 새 구현이 아니라 선행 변경 검증·분리로 취급한다.
- 구현자는 task별 fresh agent, task reviewer는 구현자와 다른 fresh agent를 사용한다.

## 사전 충돌 점검

| Task | 자체 일관성 | 판정 |
|---|---|---|
| 1 | 기존 PKI/TLS 변경과 focused test/commit 범위 일치 | 진행 가능 |
| 2 | container/BlueZ 변경과 contract test/commit 범위 일치 | 진행 가능 |
| 3 | 제조 등록·배포·identity 변경과 test/commit 범위 일치 | 진행 가능 |
| 4 | shared 타입, schema, topic test와 구현 일치 | 진행 가능 |
| 5 | recurrence/overlap API와 월말·DST test 일치 | 진행 가능 |
| 6 | 본문에서 `automation-schema.spec.ts` 생성을 요구하지만 Files 목록에서 누락 | Ruling: 명시된 test 파일을 Task 6 write scope에 포함한다. 비용은 없음 |
| 7 | CRUD, Site lock, snapshot, overlap test 일치 | 진행 가능 |
| 8 | event CRUD와 source/target/hold 제약 test 일치 | 진행 가능 |
| 9 | full snapshot hash, ACK, execution dedupe test 일치 | 진행 가능 |
| 10 | manual override 기본/validation과 command 연동 일치 | 진행 가능 |
| 11 | atomic store/hot reload와 rollback test 일치 | 진행 가능 |
| 12 | scheduler/arbiter/clock trust/restart test 일치 | 진행 가능 |
| 13 | OR/hold/max brightness/telemetry cap test 일치 | 진행 가능 |
| 14 | Sensor Status/vendor dedupe/startup Get test 일치 | 진행 가능 |
| 15 | GPIO edge/boot/queue/pin validation test 일치 | 진행 가능 |
| 16 | Sensor Server/vendor retry/model composition test 일치 | 진행 가능 |
| 17 | schedule tab/CRUD/viewer UI test 일치 | 진행 가능 |
| 18 | event CRUD/manual override UI test 일치 | 진행 가능 |
| 19 | test-only simulator와 production guard, Chromium flow 일치 | 진행 가능 |
| 20 | 실제 test 결과와 HIL 미실행 경계를 문서에 반영 | 진행 가능 |

## 공유 파일·인터페이스 점검

| 생산 Task → 소비/변경 Task | 공유 지점 | 판정 |
|---|---|---|
| 1 → 19 | Lab CA/API/broker TLS bundle | Task 19 software E2E의 mTLS 기반으로 사용 |
| 2 → 11,14,19 | Gateway container, BlueZ adapter/application | 후속 task는 Task 2 production fail-closed 계약을 유지 |
| 3 → 19,20 | Gateway identity/deploy scripts | E2E/HIL 준비에 재사용 |
| 4 → 5,7,8,9,10,11,13,14,17,18 | automation 타입/schema/topic | 모든 후속 payload 이름은 Task 4 계약을 정본으로 사용 |
| 5 → 7,12 | recurrence/overlap engine | API와 Gateway가 같은 occurrence 의미를 사용 |
| 6 → 7,8,9,10 | Prisma models | 각 mutation은 Site lock transaction과 revision/outbox 원자성을 유지 |
| 7 → 8,9,17 | target snapshot/revision helper와 schedule API | Task 8은 helper 재사용, Task 17은 route 응답 사용 |
| 8 → 9,18 | event rule snapshot/API | Task 9 full snapshot, Task 18 UI가 소비 |
| 9 → 11,13,17,18 | MQTT snapshot/ACK/execution 원장 | Gateway application ACK 전 UI는 적용 완료로 표시하지 않음 |
| 10 → 12,18 | `overrideUntil`, ManualOverride | Gateway arbiter와 Web 입력이 동일한 ISO instant를 사용 |
| 11 → 12,13 | `AutomationRuntime`, config store | scheduler/event runtime은 hot-reloaded immutable snapshot을 소비 |
| 12 → 13 | durable state와 priority arbiter | event runtime은 arbiter 외부에서 직접 밝기 전송 금지 |
| 13 → 14 | normalized sensor event input | BLE client는 dedupe 뒤 runtime에 한 번만 전달 |
| 14 → 16 | vendor payload/ACK 및 Sensor property | Gateway decoder와 firmware encoder byte layout을 shared protocol fixture로 교차 검증 |
| 15 → 16 | `vehicle_sensor_edge_t` | BLE task만 edge를 소비하며 ISR은 전송하지 않음 |
| 17 → 18 | `ControlView`, tabs, target picker, automation API | Task 18은 기존 탭/공통 picker를 확장하고 schedule regression 유지 |
| 11~18 → 19 | production API/Gateway/Web paths | simulator는 sensor edge 입력만 대체하고 CRUD/MQTT/arbiter를 우회하지 않음 |
| 1~19 → 20 | 실제 구현/test 결과 | 문서는 검증 증거만 반영하고 HIL을 software test로 대체하지 않음 |

## 진행 기록

### Task 1

- Base: `3709a11b5f57302e16a942d8ee23a8fb461cf9ec`
- Implementer: `01a04df8-f657-7171-ab96-ec9c9353ab5c` (Tesla, gpt-5.6-terra/high)
- Brief: `task-1-brief.md`
- Implementer status: `DONE_WITH_CONCERNS`
- Commit: `be225ee7df781517f62a54cd41396daa6a3594e2`
- Test evidence: PKI 40 passed, 0 failed, 1 skipped; API TLS 9 passed; API typecheck passed.
- Concern ruling: Real Vault 1.17.6 smoke와 HIL 미실행은 Task 1의 script contract 완료를 막지 않는다. Task 19/20에서 환경 통합 검증과 미실행 경계를 다시 기록한다.
- Reviewer: `01a04e00-4640-7303-8ac2-c69e84482d50` (Dalton, gpt-5.6-terra/high)
- Review verdict: spec FAIL, code quality Important findings 2개.
- Fix round 1 ruling: 두 finding 모두 유효하다. Vault 실제 CA chain endpoint/field 계약으로 수정하고, CRL 전체 입력을 strict parse 및 TLS context validation으로 fail-closed 처리한다.
- Fix round 1 commit: `9488f9b2548409fae71e39db7606db8b9404aaf2`
- Fix round 1 evidence: API TLS 16/16, PKI 40 passed/0 failed/1 skipped, API typecheck passed.
- Re-review: RESOLVED, 두 Important finding 모두 해소.
- Task 1: complete

### Task 2

- Base: `9488f9b2548409fae71e39db7606db8b9404aaf2`
- Implementer: `01a04e10-19a0-7b53-b637-9010998007da` (Nash, gpt-5.6-terra/high)
- Brief: `task-2-brief.md`
- Implementer status: `DONE_WITH_CONCERNS`
- Commit: `cd22f6395c1d7621d7cbaf1c714ba275b032032e`
- Test evidence: focused contracts 11/11, focused Gateway 9/9, full Gateway 292/292, typecheck passed.
- Concern ruling: Raspberry Pi/BlueZ/MQTT/ESP32-H2 HIL은 Task 20까지 미실행으로 유지한다.
- Reviewer: `01a04e13-58fc-7b72-819e-bed41b3ede18` (Banach, gpt-5.6-terra/high)
- Review verdict: spec NOT APPROVED, code quality CHANGES REQUIRED, Important findings 2개.
- Fix round 1 ruling: 두 finding 모두 유효하다. `starting-unassigned`는 status로만 관찰하고 Docker health는 실패시킨다. HCI readiness는 rfkill 대신 BlueZ `Adapter1.Powered` D-Bus property로 확인하며 rfkill은 진단 정보로만 유지한다.
- Fix round 1 commit: `f9f66ee`.
- Re-review: `starting-unassigned` 해결, HCI check 1개 Important 잔존.
- Fix round 2 ruling: appliance는 `bluetooth-meshd`만 실행해 private D-Bus에 `org.bluez.Adapter1`이 없다. Docker image에 BlueZ `btmgmt`를 포함하고 kernel management API의 configured controller `current settings: powered`를 readiness 기준으로 사용한다.
- Fix round 2 commit: `6632ea8`.
- Re-review: non-root Gateway process가 kernel management capability를 잃어 readiness가 항상 false인 Important 1개 잔존.
- Fix round 3 ruling: Node process에 capability를 부여하지 않는다. root image user와 제한된 compose capability로 실행되는 Docker healthcheck script가 `btmgmt`를 호출하고, application state의 MQTT identity/BlueZ attachment 조건과 결합해 최종 health를 판정한다.
- Fix round 3 commit: `7aaa418`.
- Re-review: RESOLVED.
- Task 2: complete

### Task 3

- Base: `7aaa418`
- Implementer: `01a04e30-c2be-7460-8f1e-7621873c9ca8` (Sartre, gpt-5.6-terra/high)
- Brief: `task-3-brief.md`
- Implementer status: DONE
- Commit: `c3faf52`
- Test evidence: typecheck, script 12/12, MQTT identity 19/19, KeyMaterialStore 10/10 passed.
- Concern ruling: HIL은 Task 20까지 미실행으로 유지한다.
- Reviewer: `01a04e36-0138-7490-850f-8fd789f007a2` (Chandrasekhar, gpt-5.6-terra/high)
- Review verdict: spec/code quality needs changes, Important 2개.
- Fix round 1 ruling: 둘 다 유효하다. manufacturing TS CLI는 positional 인자 정확히 4개만 허용하고, 기존 label도 새 label과 같은 claimCode/fingerprint strict predicate를 통과할 때만 idempotent success로 인정한다.
- Fix round 1 commit: `0f6e7a9`.
- Re-review: RESOLVED.
- Task 3: complete

### Task 4

- Base: `0f6e7a93d515ca7802017df89d67e75b5be49393`
- Implementer: `01a04e3c-4da9-7d71-baec-37985a2787b8` (Mendel, gpt-5.6-terra/high)
- Brief: `task-4-brief.md`
- Implementer status: DONE
- Commit: `9ad960f`
- Test evidence: RED missing contract/topic; focused 12, shared full 64, typecheck/build passed.
- Process correction: 최초 응답에서 report 누락, 같은 implementer가 metadata report를 보완했고 code/commit은 변경하지 않음.
- Reviewer: `01a04e42-132b-7b92-af63-4357ae7ae477` (Russell, gpt-5.6-terra/high)
- Review verdict: shared dimming normalization boundary FAIL, MQTT v2 prefix FAIL.
- Ruling: dimming finding은 유효하며 shared schema는 brightness 0~100만 검증한다. MQTT finding은 plan example과 기존 deployed topic contract의 충돌이다. Spec의 MQTT v2는 현재 payload/contract generation을 뜻하며 모든 기존 ACL/subscription은 `sites/...` prefix를 사용하므로 automation만 `v2/sites/...`로 이탈시키지 않는다. 향후 전체 broker namespace migration 없이는 prefix를 변경하지 않는다.
- Fix round 1: shared action normalization finding만 수정한다.
- Fix round 1 commit: `9768679`.
- Re-review: RESOLVED, MQTT namespace ruling 기록.
- Task 4: complete

### Task 5

- Base: `9768679158a75a2a01776a56180b4c7f27eae7e4`
- Implementer: `01a04e47-02cd-7453-ac23-b72bf324e4ea` (Rawls, gpt-5.6-sol/high)
- Brief: `task-5-brief.md`
- Implementer status: DONE_WITH_CONCERNS
- Commit: `9c89cd1`
- Test evidence: package 22/22, typecheck/build, root typecheck passed. Root test has pre-existing/unrelated `manufacturing-mtls.e2e-spec.ts` TLS client certificate failure and is not green.
- Performance: 400년 월/연 recurrence no-overlap worst case 약 1.35초; exactness를 위해 horizon 축소 금지, API 다수 비교 시 iterator 최적화 후보.
- Determinism concern: Cloud/Gateway tzdata version pin/alignment를 배포 task에 반영해야 함.
- Reviewer: `01a04e57-4b3b-7f33-907c-42becd531320` (Curie, gpt-5.6-sol/high)
- Review verdict: NOT APPROVED, Important 4개.
- Fix round 1 ruling: 모두 유효하다. Gregorian 400년 horizon은 IANA transition에 적용하지 않는다. 유한 active date intersection 전체를 recurrence-kind별 candidate generator로 순회하고 two-pointer로 streaming 비교한다. `getNextOccurrence`는 첫 후보에서 즉시 반환한다. package direct scripts는 shared dist가 없는 clean checkout에서도 lifecycle pre-script로 shared를 먼저 build한다.
- Fix round 1 commit: `0e3c425`.
- Re-review: 기존 4개 해결. Pacific/Apia 2011-12-30 전체 날짜 gap에서 1일 lookback이 cross-midnight occurrence를 놓치는 Important 1개 발견.
- Fix round 2 ruling: IANA 최대 24시간 offset jump와 24시간 미만 local cross-midnight 구간을 포괄하도록 active/overlap candidate 시작을 현지 날짜 2일 전까지 확장하고 Apia regression을 고정한다.
- Fix round 2 commit: `fc11b13`.
- Re-review: RESOLVED.
- Task 5: complete

### Task 6

- Base: `fc11b134558e976306bb3dc0cd9a0efcbf4758ea`
- Implementer: `01a04e71-1990-7aa0-a9b0-dcb7374f9d4e` (Arendt, gpt-5.6-sol/high)
- Brief: `task-6-brief.md`
- Ruling carried: create `automation-schema.spec.ts`; reuse `MqttOutbox`, no duplicate automation outbox model.
- Implementer status: DONE_WITH_CONCERNS
- Commit: `58a1bf2`
- Test evidence: Prisma generate/validate, API typecheck, focused 38 passed/1 opt-in skipped, PostgreSQL schema 6/6, fresh DB migrations 34/34.
- Concerns carried: Task 9 handles MQTT ACK; Tasks 7/8 enforce Fixture tenant consistency; pre-existing long index-name drift is not introduced by Task 6.
- Reviewer: `01a04e84-b781-7e90-8652-ebdaaaa77873` (Ramanujan, gpt-5.6-sol/high)
- Review verdict: NOT APPROVED, Important 6개.
- Fix round 1 ruling: 모두 유효하다. Gateway owner update는 automation/history/pending outbox가 있으면 DB에서 제한한다. join row에 owner scope를 보존하고 composite FK/trigger로 Fixture Site/Gateway 및 이후 재배치를 차단한다. execution/manual source는 owner-aware FK와 kind/rule coherence를 강제한다. required child cardinality는 deferred constraint trigger, weekday uniqueness는 immutable DB function/check로 보장한다. sync 상태와 terminal fixture result도 state-dependent CHECK로 제한한다.
- Fix round 1 commit: `9fdd090`.
- Re-review: findings 1/3/5/6 해결. Floor.siteId/MeshNode.gatewayId 간접 scope 변경과 concurrent last-child deletion 두 Important 잔존.
- Fix round 2 ruling: Floor와 MeshNode owner 변경에도 참조 Fixture 존재를 검사하는 trigger를 추가한다. deferred cardinality 함수는 parent row를 `FOR UPDATE`로 잠근 뒤 count해 concurrent deletion을 직렬화한다.
- Fix round 2 commit: `99c25dc`.
- Re-review: REPEATABLE READ stale snapshot과 multi-parent lock ordering/deadlock Important 2개 잔존.
- Fix round 3 ruling: owner scope는 Fixture에 derived `siteId/gatewayId`를 저장하고 Floor/MeshNode composite FK cascade 및 automation join→Fixture composite FK restrict로 선언적으로 강제한다. 최소 cardinality는 parent count column을 child trigger가 원자 갱신하고 deferred check가 count를 검사한다. old/new parent 이동은 정렬된 advisory lock 또는 canonical row order를 사용한다.
- Fix round 3 commit: `b2eeaa6`.
- Re-review: Fixture scope/counter 정확성 해결. multi-row opposite move transaction deadlock Important 1개 잔존.
- Fix round 4 ruling: automation membership INSERT/DELETE/UPDATE trigger는 동일한 고정 transaction-level PostgreSQL advisory lock을 먼저 획득해 transaction 전체를 직렬화한다. 규칙 설정 write는 저빈도라 전역 직렬화 비용보다 deadlock 제거가 우선이다. Fresh implementer로 교체한다.
- Fix round 4 implementer: `01a04ed6-664a-7232-865e-dbdf97dedbe1` (Beauvoir, gpt-5.6-sol/xhigh)
- Fix round 4 commit: `ab43c23`.
- Re-review: advisory lock을 BEFORE ROW에서 획득해 child tuple→advisory와 cascade parent→advisory cycle 가능성 Important 1개 잔존.
- Fix round 5 ruling: top-level membership DML은 BEFORE STATEMENT trigger에서 advisory lock을 먼저 획득한다. parent cascade에서 실행된 nested trigger는 global lock과 곧 삭제될 parent counter 갱신을 건너뛰어 parent lock→advisory cycle을 제거한다. Fresh implementer로 교체한다.
- Fix round 5 implementer: `01a04ee4-f087-7f42-9030-820f0dfeb04b` (Singer, gpt-5.6-sol/xhigh)
- Fix round 5 commit: `8c7bfdb`.
- Breaker re-review: parent UPDATE가 이전 statement에서 row lock을 잡은 뒤 membership lock을 요청하는 parent→advisory cycle Important 1개 잔존.
- Breaker ruling: load-bearing finding이다. LightingSchedule/VehicleEventRule/ManualOverride top-level INSERT/UPDATE/DELETE에도 동일 global advisory lock BEFORE STATEMENT trigger를 적용해 parent row lock보다 먼저 transaction order를 고정한다. nested counter UPDATE와 FK cascade는 depth guard로 재획득/부수효과 없이 통과한다.
- Breaker commit: `67d4b0a`.
- Breaker re-review: RESOLVED.
- Task 6: complete

### Task 7

- Base: `67d4b0aae22e0ff385aa8f3299e3c19b35507397`
- Implementer: `01a04f07-c71e-7d63-8bc7-96a9f489266d` (Leibniz, gpt-5.6-sol/high)
- Brief: `task-7-brief.md`
- Implementer status: DONE_WITH_CONCERNS
- Commit: `0db8776`
- Test evidence: focused unit/PostgreSQL E2E 14/14; API lint/typecheck/build passed; API full 639 passed/109 skipped/3 existing failures.
- Existing failures tracked: manufacturing mTLS 2, MeshControlGroup schema text assertion 1. Task 7 diff does not touch those paths.
- Ruling: offline schedule target controllability uses completed MeshNode/Gateway mapping, not transient online state.
- Reviewer: `01a04f21-38d2-7571-8c6e-ad5356d2c763` (Goodall, gpt-5.6-sol/high)
- Review verdict: NOT APPROVED, Important 4/Minor 3.
- Fix round 1 ruling: 모두 처리한다. automation advisory lock을 write transaction 첫 statement로 획득하고 그 뒤 Site lock/재인가한다. equal start/end는 shared/API에서 거부한다. schedule list는 cursor pagination/default 25/max 100과 total/nextCursor를 제공하고 latest execution 복합 index를 forward migration으로 추가한다. AutomationClock을 주입해 nextOccurrence/E2E를 고정한다. Snapshot revision/hash/outbox는 별도 injectable service로 추출해 Tasks 8/9가 재사용한다. 문서와 누락 경계 tests도 보강한다.
- Fix round 1 commit: `b781f70`.
- Re-review: prior findings 대부분 해결. equal-time DB/upgrade policy, anchor-dependent cursor/snapshot consistency, query validation-before-auth Important 3 및 docs Minor 1 잔존.
- Fix round 2 ruling: forward migration은 equal-time schedule 또는 invalid pending automation outbox를 발견하면 precise remediation error로 배포를 중단하고 이후 DB inequality CHECK를 추가한다. cursor는 Site/createdAt/id를 담은 self-contained keyset으로 삭제 anchor와 무관하게 작동한다. count/page는 Repeatable Read transaction에서 읽는다. raw query는 Site read auth 이후 service에서 parse한다.
- Fix round 2 commit: `c8cc882`.
- Re-review: keyset/snapshot/auth/docs 해결. migration preflight와 ALTER 사이 concurrent write 경쟁 Important 1, cursor pre-decode size Minor 1 잔존.
- Fix round 3 ruling: forward migration을 explicit transaction으로 감싸고 LightingSchedule/MqttOutbox write-blocking locks를 preflight 전에 획득한다. cursor는 base64 regex/Buffer/JSON 전에 512자 최대 길이를 거부한다.
- Fix round 3 commit: `d3b2b67`.
- Re-review: RESOLVED.
- Task 7: complete

### Task 8

- Base: `d3b2b676a121db3307033f80253b6be309b21ae7`
- Implementer: `01a04f6f-321d-7dd1-88dc-f3b1cee0a0b6` (Kant, gpt-5.6-sol/high)
- Brief: `task-8-brief.md`
- Implementer status: DONE_WITH_CONCERNS
- Commit: `96857da`
- Test evidence: focused PostgreSQL/service 12/12, Prisma generate/validate/migrate/status, lint/typecheck/build; full API 724 passed/73 skipped/3 unrelated failures.
- Reviewer: `01a04f80-3ecd-7801-b7a2-7c69e7507a0c` (Helmholtz, gpt-5.6-sol/high)
- Review verdict: NOT APPROVED, Important 2/Minor 2.
- Fix round 1 ruling: sensor capability는 machine-verifiable하게 MeshNode enum `unknown|supported|unsupported`와 verifiedAt으로 저장하고 source는 supported+verified만 허용한다. Gateway provisioning/model-binding이 값을 갱신하는 경로는 Task 14에 carry한다. latest detection partial index를 forward migration으로 추가한다. enable/disable, actual schedule preservation, cross-kind concurrency E2E와 neutral automation-list diagnostic을 보강한다.
- Fix round 1 commit: `8599c85`.
- Re-review: index/E2E/diagnostic 해결. existing unknown source migration, direct source DML, downgrade race, concrete Gateway→Cloud capability contract Important 잔존.
- Fix round 2 ruling: forward migration은 unsupported/unknown existing source를 precise remediation으로 차단한다. VehicleEventSource DML과 MeshNode capability update는 같은 automation statement lock을 사용하고 DB trigger가 supported+verified 및 active references를 강제한다. shared capability report/topic과 API capability service를 정의하며 downgrade report는 영향받는 활성 event rule을 비활성화하고 full snapshot revision을 원자 생성한 뒤 unsupported를 저장한다. Task 9 consumer/Task 14 publisher가 이 계약을 연결한다.
- Fix round 2 commit: `6861c9b`.
- Re-review: DB/source/downgrade 처리 해결. applyReport eventId/freshness·ordering 및 Task9/14 concrete handoff Important/Minor 잔존.
- Fix round 3 ruling: report에 node별 positive `capabilityRevision`을 추가하고 Gateway가 영속 증가한다. MeshNode는 revision과 두 model-bound 값을 저장한다. API는 ProcessedGatewayEvent payloadHash + `(gateway,eventType,revision)`으로 same replay/stale/conflict를 구분하고 최신 revision만 적용한다. shared ingested ACK topic/payload를 정의한다. Task9은 authenticated topic binding/consumer/ACK, Task14는 persistent revision/eventId publish/retry/reconnect를 구현한다.
- Fix round 3 commit: `c4247a7`.
- Re-review: node-local revision이 gateway-wide unique ledger와 충돌, migrated revision-1 baseline, unsupported DB check, durable ACK outbox identity/schema 잔존.
- Fix round 4 ruling: ProcessedGatewayEvent에 meshNodeId를 저장하고 capability event는 partial unique `(gatewayId,meshNodeId,sequence,eventType)`, legacy events는 기존 scope를 유지한다. ledger-free equal revision exact state는 ledger를 보강하고 duplicate ACK한다. unsupported는 verifiedAt과 무관하게 model flag 하나 이상 false를 강제한다. MqttOutbox에 deterministic applicationAckKey variant를 추가해 revision Int를 사용하지 않고 first ACK payload/ingestedAt을 재사용한다. Fresh implementer로 교체한다.
- Fix round 4 implementer: `01a04fd9-4e5f-7852-8dac-c48895eeae9e` (Aquinas, gpt-5.6-sol/xhigh)
- Fix round 4 commit: `21ca861`.
- Re-review: node ledger/ACK schema 해결. cross-node same eventId ACK overwrite, published-lost/deadletter ACK revival, Task9 publisher semantics 잔존.
- Fix round 5 ruling: applicationAckKey에 gatewayId+meshNodeId+eventId를 포함해 conflicting node ACK를 분리한다. exact redelivery는 동일 stored payload를 유지한 채 published/deadletter row를 lease-safe하게 재큐잉한다. Task9은 ACK/config variant claim, QoS1, lease, exact payload publish, retry/dead-letter 및 redelivery revival과 shutdown drain을 구현한다. Fresh implementer로 교체한다.
- Fix round 5 implementer: `01a05001-1450-7462-adb9-085cbd55019e` (Faraday, gpt-5.6-sol/xhigh)
- Fix round 5 commit: `e89c365`.
- Breaker review: same-node same eventId conflicting payload가 기존 applied ACK를 받아 변조 report를 accepted로 오인하는 P1 잔존.
- Breaker ruling: ACK schema에 canonical `reportPayloadHash`를 필수 추가하고 applicationAckKey를 gateway+meshNode+eventId+hash로 scope한다. Gateway terminal match도 hash를 포함한다. exact original/conflict replay는 각각 immutable applied/rejected ACK로 수렴한다.
- Breaker commit: `36eb71d`.
- Breaker re-review: RESOLVED.
- Task 8: complete

### Task 9

- Base: `36eb71d4e699f65b291d7175a73c99023a244c97`
- Implementer: `01a0502a-c84b-7d40-a0d2-17a59bd35458` (Ptolemy, gpt-5.6-sol/xhigh)
- Brief: `task-9-brief.md`
- Carried contracts: capability report topic/payload identity binding, hash-scoped immutable ACK outbox, config retry/supersession, execution ingest application ACK.
- Implementer status: DONE
- Commit: `6072430`
- Test evidence: shared 68/68, Task 9 focused 107/107, PostgreSQL automation constraints 49/49, full API 709 passed/155 skipped/0 failed; lint/typecheck/build와 Prisma 검증 통과.
- Reviewer: `01a05050-d047-7510-8c5a-9e4973dedc17` (Kierkegaard, gpt-5.6-sol/xhigh)
- Review verdict: CHANGES_REQUIRED, P1 1개/P2 2개.
- Fix round 1 ruling: 세 finding 모두 유효하다. 실행 수집은 mutable rule이 아니라 보고 revision의 immutable stored config snapshot으로 source/target을 검증하고, snapshot이 보존되는 한 rule 수정·삭제 뒤의 이전 revision 실행도 수집한다. 낮은 applied ACK는 appliedRevision만 단조 전진시킬 수 있고 exact desired REJECTED/error를 지우지 않는다. brief의 명시 계약에 따라 config와 application ACK 모두 10회 또는 15분 실패 시 payload/topic/hash를 보존한 채 deadletter한다.
- Fix round 1 commit: `4d6f3e4`.
- Fix round 1 test evidence: shared 68, focused 112, PostgreSQL 51, full API 715 passed/0 failed; lint/typecheck/build 통과.
- Fix round 1 re-review: 기존 3건 해결, snapshot-backed execution의 revision/payload UPDATE trigger 우회 P2 1개 잔존.
- Fix round 2 ruling: finding은 유효하다. `AutomationExecution` snapshot 검증 trigger가 revision/payload 변경에도 발화하도록 forward migration에서 재생성하고, revision-only 및 payload source-only UPDATE가 거부되는 PostgreSQL 회귀를 추가한다.
- Fix round 2 commit: `a9f29d9`.
- Fix round 2 test evidence: PostgreSQL 55/55, focused 128, full API 716 passed; lint/typecheck/build 통과.
- Fix round 2 re-review: RESOLVED.
- Task 9: complete

### Task 10

- Base: `a9f29d914ee3bb50b94d38b485be4e2e483953f0`
- Implementer: `01a05073-cacb-7a72-9d7e-37b25a29771c` (Pasteur, gpt-5.6-terra/high)
- Brief: `task-10-brief.md`
- Carried contracts: 기존 synchronous command와 Site lock을 유지하고 `Command`/`ManualOverride`/target rows를 원자 저장하며 Gateway/Web까지 `overrideUntil`을 전달한다.
- Implementer status: DONE
- Commit: `9bfa96b`
- Test evidence: shared 68/68, API focused 21/21, API/Web typecheck, Web 5/5 통과.
- Reviewer: `01a0507d-7269-7861-8124-284f9fb35533` (Fermat, gpt-5.6-terra/high)
- Review verdict: CHANGES_REQUIRED, P1 2개.
- Fix round 1 ruling: 모두 유효하다. 배포 전 `ManualOverride`가 없는 기존 Command의 동일 clientRequestId 재시도는 기존 응답으로 호환한다. 권한과 payload fingerprint를 확인한 기존 command 재조회는 현재시각 기반 override 검증보다 먼저 수행하고, 미래/30일 제한은 새 command 생성에만 적용한다.
- Fix round 1 commit: `ca353d0`.
- Fix round 1 test evidence: shared 68/68, API focused 23/23, API/Web typecheck, Web 5/5 통과.
- Fix round 1 re-review: RESOLVED.
- Task 10: complete

### Task 11

- Base: `ca353d0ca7585bf3c87107cfaab5568774f7b248`
- Implementer: `01a05086-73e4-71d0-9734-0e5b1709dc1b` (Mill, gpt-5.6-sol/high)
- Brief: `task-11-brief.md`
- Carried contracts: Task 9 exact revision/hash config와 applied/rejected ACK, existing Gateway MQTT lifecycle을 유지하며 process restart 없이 atomic hot reload한다.
- Implementer status: DONE_WITH_CONCERNS
- Commit: `61506b7`
- Test evidence: focused 61/61, Gateway 312/312, Docker 16/16, typecheck/lint/build 통과.
- Concern ruling: Task 12 arbiter 미연결은 예정된 다음 범위이며 HIL은 Task 20까지 미실행 경계로 유지한다.
- Reviewer: `01a05095-3923-72a0-9a0e-128a3d3f65e9` (Kuhn, gpt-5.6-sol/xhigh)
- Review verdict: CHANGES_REQUIRED, P1 3개/P2 3개.
- Fix round 1 ruling: 모두 load-bearing finding으로 처리한다. QoS1 inbound PUBACK은 applied/rejected durable result 저장 전 완료되지 않게 한다. recompute/apply 실패는 persisted active snapshot과 memory를 함께 이전 revision으로 유지한다. rename 후 directory fsync 실패처럼 commit 결과가 불확실한 경계는 disk read-back/명시적 commit protocol로 active snapshot과 ACK 판정을 일치시킨다. reconnect generation마다 ACK drain을 보장하고 unrelated recovery 실패와 ACK publisher 시작을 분리한다. production wiring 통합 테스트로 MQTT/BLE process 무중단을 검증한다.
- Fix round 1 commit: `9f6971a`.
- Fix round 1 test evidence: Gateway 321/321, Docker 16/16, Mosquitto 2/2, typecheck/lint/build 통과.
- Fix round 1 re-review: 기존 6건 중 5건 해결, 연속 parent fsync 실패 시 commit-uncertain을 rejected로 확정하는 P1 1개 잔존.
- Fix round 2 ruling: finding은 유효하다. rename 후 parent fsync가 재시도까지 실패하면 commit-uncertain으로 분류하고 durable rejected ACK 및 inbound PUBACK을 만들지 않는다. 현재 target read-back 결과와 runtime memory를 모순 없이 다루고 broker redelivery/restart가 same revision/hash로 수렴하도록 회귀 테스트를 추가한다.
- Fix round 2 commit: `8c3a9f9`.
- Fix round 2 test evidence: Gateway 323/323, Docker 16/16, Mosquitto 2/2, typecheck/lint/build 통과.
- Fix round 2 re-review: RESOLVED.
- Task 11: complete

### Task 12

- Base: `8c3a9f910cacd07b8cee071470f4797a16323dc7`
- Implementer: `01a050b8-76f0-7d20-afd2-eb6e0c561cec` (Anscombe, gpt-5.6-sol/xhigh)
- Brief: `task-12-brief.md`
- Carried contracts: Task 11 atomic store/hot reload seam, common recurrence engine, manual overrideUntil, existing mesh executor와 clock trust boundary를 연결한다.
- Implementer status: DONE_WITH_CONCERNS
- Commit: `9fb7989`
- Test evidence: focused 72/72, Gateway 352/352, Docker 17/17, Mosquitto 2/2, typecheck/lint/build 통과.
- Concern ruling: sensor/telemetry는 Task 13~14 예정 범위이며 HIL은 Task 20까지 미실행 경계로 유지한다.
- Reviewer: `01a050dc-dcf1-7931-9635-ad11d20647a1` (Volta, gpt-5.6-sol/xhigh)
- Review verdict: CHANGES_REQUIRED, P1 4개/P2 4개.
- Fix round 1 ruling: 8건 모두 유효하다. RF 실행은 telemetry capacity와 분리하고 실패 이력은 gap metadata로 보존한다. Desired transition은 durable pending→terminal phase로 기록해 pre-send/crash 실패를 완료로 오인하지 않는다. 수동 override 단독 만료는 마지막 수동 밝기를 유지한다. timesync는 marker file이 나중에 생길 수 있는 directory mount로 바꾸고 rollback 이후 marker fence를 새로 잡는다. manual expiry는 current process에서 monotonic deadline을 사용한다. Command journal과 scheduler handoff는 replay 가능한 phase를 저장하며 scheduler는 async stopAndDrain으로 intake를 차단하고 in-flight를 완료한다.
- Fix round 1 commit: `536d959`.
- Fix round 1 test evidence: focused 100/100, Gateway 373/373, Docker 17/17, Mosquitto 2/2, typecheck/lint/build 통과.
- Fix round 1 re-review: 기존 5건 해결, 기존 3건 잔존 및 새 3건으로 active P1 2개/P2 4개.
- Fix round 2 ruling: 6건 모두 유효하다. V1 upgrade는 legacy lastDesired를 완료 증거로 신뢰하지 않고 fixture observed state resync 또는 replay-safe transition identity로 수렴한다. V2 pending은 실제 observed brightness가 desired와 같으면 terminal 처리하고 다를 때만 재전송한다. Manual handoff는 active schedule/event의 pre-state를 보존한다. 현재 process가 untrusted여도 command의 확정 duration으로 monotonic deadline을 만든다. Startup은 snapshot/runtime 초기화 뒤 pending handoff를 복구한다. Pending handoff journal은 완료까지 TTL/max eviction에서 보호하며 in-flight guard는 durable terminal commit 이후에만 제거한다.
- Fix round 2 commit: `7fe5356`.
- Fix round 2 test evidence: focused 115/115, Gateway 388/388, Docker 17/17, Mosquitto 2/2, typecheck/lint/build 통과.
- Fix round 2 re-review: 기존 5건 해결, 기존 1건 잔존 및 새 3건으로 active P1 4개.
- Fix round 3 ruling: 모두 유효하다. Automation recovery는 Health 완료가 아닌 Lightness/OnOff observation callback으로 fence를 해제한다. RF terminal commit 실패 시 현재 process도 즉시 observation fence를 세운다. 대량 fixture resync는 MQTT/control plane을 먼저 기동한 뒤 bounded background worker로 실행하고 개별 실패를 격리한다. Cloud command publisher는 overrideUntil 이후 발행/재발행을 금지하고 broker message expiry를 absolute deadline에 제한하며, Gateway untrusted 수신은 verified message-age/expiry 기반의 짧은 bounded monotonic anchor만 사용해 stale command를 장기간 부활시키지 않는다.
- Fix round 3 commit: `f92df38`.
- Fix round 3 test evidence: shared 30/30, API 49/49, Gateway focused 160/160, full 400/400, Docker 17/17, Mosquitto 2/2, typecheck/lint/build 통과.
- Fix round 3 re-review: 기존 4건 해결, 새 P1 3개/P2 2개 active.
- Fix round 4 ruling: 5건 모두 유효하다. Persisted journal과 mixed-version wire는 legacy-compatible parser로 읽고 strict expiry invariant는 새 producer에만 강제한다. Same-process observation fence는 즉시 targeted lighting resync를 예약한다. 새 publisher는 wire payload에 publish 시점의 absolute override remaining duration과 delivery window를 durable하게 확정하고 broker remaining TTL을 Gateway handler에 전달해 untrusted에서도 정상 override duration과 delivery freshness를 별도 monotonic deadline으로 관리한다. Untrusted restart에서는 wall expiry를 추정하지 않고 trust 회복 전 새 자동 전환을 보류한다. Handler는 receipt-relative monotonic execution deadline을 항상 재검사한다. Background resync shutdown은 AbortSignal/fixture boundary와 bounded timeout으로 종료한다. Fresh implementer로 교체한다.
- Fix round 4 implementer: `01a0514b-4b50-7833-8635-b8609e599b48` (Avicenna, gpt-5.6-sol/max)
- Fix round 4 commit: `1970738`.
- Fix round 4 test evidence: shared 74/74, API 727 passed, Gateway 411/411, focused 34/49/159, Docker 17/17, Mosquitto 2/2; typecheck/lint/build/diff-check 통과.
- Fix round 4 re-review: 기존 4건 해결, 기존 1건 잔존 및 새 2건으로 active P1 3개.
- Fix round 5 ruling: 3건 모두 유효하다. Clock-untrusted restart에서는 expiry 판정 불가 manual을 arbiter에서 제거하지 않고 기존 manual priority/output을 유지하며 event/schedule takeover를 보류한다. Targeted resync queue는 실패 batch를 tail로 회전시키고 한 cycle에서 pending 전체에 공정한 기회를 준다. Rolling legacy timed command는 authenticated fresh broker delivery를 전제로 `overrideUntil-startedAt` duration에서 packet transit age를 차감한 monotonic deadline을 사용해 정상 duration을 보존한다. Production rollout은 API publisher를 Gateway보다 먼저 배포해 stale legacy outbox를 normalize/expire하며 호환 모드는 bounded release window와 운영 진단을 남긴다. Fresh implementer로 교체한다.
- Fix round 5 implementer: `01a05175-12c7-7033-aaf3-15892a060656` (Lorentz, gpt-5.6-sol/max)
- Fix round 5 commit: `80bdaae`.
- Fix round 5 test evidence: focused shared 34/34, API 49/49, Gateway 165/165; full shared 74/74, API 727 passed, Gateway 417/417; Docker 17/17, Mosquitto 2/2; typecheck/lint/build/diff-check 통과.
- Fix round 5 breaker re-review: 기존 2건 해결, queue capacity overflow와 pre-broker delayed legacy expiry P1 2건 load-bearing 잔존.
- Breaker ruling: targeted queue capacity가 넘으면 fence를 고립시키지 않고 guaranteed full-resync rerun으로 승격하며 pending fence 자체는 durable state에 남겨 관측 전까지 추적한다. Legacy wire는 untrusted clock에서 absolute remaining을 증명할 정보가 근본적으로 없으므로 RF 실행을 거부하고 명시적 `legacy_timing_unverifiable` terminal 진단을 남긴다. Trusted clock legacy와 새 generation untrusted manual은 정상 지원한다. Production rollout은 API publisher 선배포→old publisher 종료→broker max expiry 10초 drain→Gateway 배포 순서로 고정한다. 호환 구간의 untrusted legacy 수동 제어 불가 비용보다 최대 30일 stale override 부활 방지가 우선이다.
- Breaker commit: `f93018b`.
- Breaker test evidence: focused shared 34/34, API 49/49, Gateway 170/170; full shared 74/74, API 727 passed/159 skipped, Gateway 422/422; Docker 17/17, Mosquitto 2/2; typecheck/lint/build/diff-check 통과.
- Breaker re-review: legacy timing 해결, overflow fixture one-shot full resync 이후 retry 단절 P1 1개 load-bearing 잔존.
- Breaker continuation ruling: ScheduleRuntime의 durable `pendingObservationFixtures`를 recovery source of truth로 노출하고 full/targeted pass 후 실제 observation으로 해제되지 않은 fixture를 capacity-sized chunk로 다시 targeted queue에 넣는다. Full pass 실패/timeout도 capped backoff rerun을 예약하며 permanent offline은 자동제어 fence를 유지하되 다른 fixture 진행을 막지 않는다. Restart에서도 durable pending 목록으로 재구성하고 shutdown cancellation은 유지한다.
- Breaker continuation commit: `63659e5`.
- Breaker continuation test evidence: Gateway focused 162/162, full 428/428, Docker 17/17, Mosquitto 2/2; typecheck/lint/build/diff-check 통과.
- Final breaker continuation re-review: RESOLVED, active 0, residual load-bearing 0.
- Task 12: complete

### Task 13

- Base: `63659e5e8da1d24e5e654cf84a2625d922c9273b`
- Implementer: `01a051b8-cb8c-7da2-a1a5-40214d15b5d9` (Sagan, gpt-5.6-sol/xhigh)
- Brief: `task-13-brief.md`
- Carried contracts: Task 12 arbiter/durable state/telemetry gap와 Task 9 execution event/ingested ACK hash·sequence 계약을 연결한다.
- Implementer status: DONE
- Commit: `23b0e87`
- Test evidence: focused 135/135, Gateway 448/448, Docker 17/17, Mosquitto 2/2, shared 74/74; typecheck/lint/build 통과.
- Reviewer: `01a051da-2457-7733-ae3f-fea72c74fb4c` (Cicero, gpt-5.6-sol/xhigh)
- Review verdict: CHANGES_REQUIRED, P1 3개/P2 2개.
- Fix round 1 ruling: 모두 유효하다. Automation state transition과 같은 transaction에 idempotency key를 가진 pending telemetry handoff를 저장하고 outbox가 batch를 원자·멱등 수락한 뒤 state에서 완료 처리한다. Telemetry outbox는 appendBatch로 부분 commit을 금지하고 실제 dropped record만 반환한다. Hold deadline Map은 durable state commit 성공 후 갱신한다. Full disk 경계는 startup에 미리 할당한 고정 크기 in-place gap journal과 명시적 filesystem headroom으로 분리하며 outbox ENOSPC/corruption은 degraded telemetry mode로 격리해 scheduler를 중단하지 않는다. State gap→outbox도 durable handoff identity로 중복 합산을 막는다.
- Fix round 1 commit: `764276e`.
- Fix round 1 test evidence: Gateway focused 119/119, full 464/464, shared 74/74, Docker 17/17, Mosquitto 2/2; typecheck/lint/build/diff-check 통과.
- Fix round 1 re-review: 기존 4건 해결, full-disk state commit·reserve write amplification·commit uncertainty taxonomy P1 3개 active.
- Fix round 2 ruling: reserve는 state/outbox가 공유하는 `StorageHeadroomManager`로 승격하고 startup에 한 번만 preallocate한다. 정상 commit에서는 reserve를 쓰거나 재생성하지 않으며 실제 ENOSPC에서 한 번 release 후 typed retry한다. Reserve 재생성은 disk free-space가 회복된 때 background low-priority로만 수행한다. Automation state ENOSPC가 retry 후에도 실패하면 in-memory state/control을 계속하고 preallocated gap journal에 degraded-state loss를 기록해 RF를 막지 않는다. AtomicJsonCommitUncertainError는 headroom 부수 실패와 합쳐도 원래 taxonomy/visible target reconciliation을 보존하며 같은 handoff를 records와 gap으로 이중 분류하지 않는다.
- Fix round 2 commit: `3fc82f9`.
- Fix round 2 test evidence: Gateway focused 130/130, full 475/475, shared 74/74, Docker 17/17, Mosquitto 2/2; typecheck/lint/build/diff-check 통과.
- Fix round 2 re-review: 기존 P1 3건 해결, coordinator cleanup이 memory-only state clear를 durable로 오인하는 P1 1개 active.
- Fix round 3 ruling: state store mutation은 `durable|memory_only` outcome을 명시한다. RF/local control transition만 memory_only를 허용하고, telemetry handoff/gap clear 같은 protocol cleanup은 durable-required API를 사용해 ENOSPC 시 memory와 disk 모두 pending을 유지하고 coordinator batch를 중단·backoff 재시도한다. Outbox receipt는 source state durable clear 전 삭제하지 않으며 handoffId replay는 동일 eventId/sequence/hash로 멱등 수렴한다.
- Fix round 3 commit: `3a78929`.
- Fix round 3 test evidence: Gateway focused 136/136, full 481/481, shared 74/74, Docker 17/17, Mosquitto 2/2; Shared/Gateway typecheck/lint/build/diff-check 통과.
- Fix round 3 re-review: 기존 P1 해결, 최초 telemetry gap 생성이 durable state ENOSPC에서 journal fallback 전 유실되는 P1 1개 active.
- Fix round 4 ruling: 최초 gap 생성은 protocol cleanup과 달리 telemetry 수용 경계다. durable state 저장이 ENOSPC이면 preallocated fixed gap journal에 동일 gap identity/count를 원자 수용하고, journal 수용 성공만 호출 성공으로 간주한다. state와 journal 양쪽 실패는 명시적 degraded health와 retained in-memory retry source로 격리하며 조명 RF는 계속한다. 회복 후 동일 identity를 outbox/state로 멱등 병합하고 실제 durable 수용 전 dropped count를 폐기하지 않는다.
- Fix round 4 commit: `5d24e9f`.
- Fix round 4 test evidence: Task 13 focused 161/161, Gateway 488/488, shared 74/74, Docker 17/17, Mosquitto 2/2; Shared/Gateway typecheck/lint/build/diff-check 통과.
- Fix round 4 re-review: 기존 P1 해결, journal clear 실패 뒤 general source 교체 시 이미 import된 count가 재합산되는 P2 1개 active.
- Fix round 5 ruling: fixed journal은 bounded source metadata에 의존해 delta를 역산하지 않고, journal aggregate 중 outbox가 durable 수용한 누적 기준값과 그 수용 identity/hash를 in-place로 보존한다. 재import는 `aggregate - acceptedBaseline`만 처리하며, outbox commit 뒤 baseline journal commit 또는 journal clear가 불확실하면 기존/신규 visible state를 조정해 최소 at-least-once가 아니라 정확한 cumulative count로 수렴한다. clear 실패 중 source 교체와 restart를 테스트한다.
- Fix round 5 commit: `bdc3104`.
- Fix round 5 test evidence: Task 13 focused 175/175, Gateway 494/494, shared 74/74, Docker 17/17, Mosquitto 2/2; Shared/Gateway typecheck/lint/build/diff-check 통과.
- Fix round 5 breaker re-review: 기존 P2 해결, journal clear 장기 실패 중 교체된 general source receipt가 outbox에 O(n) 누적되는 P2 1개 load-bearing 잔존.
- Breaker ruling: aggregate baseline이 durable outbox와 fixed journal 양쪽에서 수용된 순간, 그 baseline에 흡수되어 더 이상 state/journal에서 재생될 수 없는 general source receipt는 같은 durable outbox commit 또는 재시작 reconciliation에서 제거한다. 현재 state pending handoff, current journal source, cumulative source, active aggregate baseline identity는 보호한다. 64 MiB 상한·O(1) recovery metadata를 장기 clear failure와 restart에서 검증하며, receipt 정리 commit uncertainty는 visible previous/next reconciliation으로 정확히 수렴한다.
- Breaker commit: `6cbb17f`.
- Breaker test evidence: focused 42/42, Gateway 499/499, shared 74/74, Docker 17/17, Mosquitto 2/2; typecheck/lint/build/diff-check 통과.
- Breaker re-review: RESOLVED, 잔존 finding 0, O(1) durable receipt retirement와 count/id/hash 수렴 확인.
- Task 13: complete

### Task 14

- Base: `6cbb17f3bf47144736daaeb077848723e7ced4bf`
- Implementer: `01a052a3-c430-7360-bd8f-9e9c88541559` (Aristotle, gpt-5.6-sol/high)
- Brief: `task-14-brief.md`
- Carried contracts: Task 13 normalized vehicle events와 Task 9 capability report/ingested ACK hash·revision 계약을 실제 BlueZ/MQTT 경로에 연결한다.
- Implementer status: RUNNING
- Implementer status: DONE
- Commit: `7705366`.
- Test evidence: native/build gate/ESP-IDF v5.5.1 target build 통과, binary `0xe6370`, app free `0x19c90`.
- Review verdict: CHANGES_REQUIRED, P1 4개/P2 4개.
- Fix round 1 ruling: `CONFIG_GPIO_CTRL_FUNC_IN_IRAM=y`와 linked-section audit로 ISR의 모든 외부 호출이 IRAM-safe임을 강제한다. Boot sample은 interrupt 비활성 상태에서 queue에 먼저 넣고 critical section 안에서 interrupt enable·즉시 reconciliation을 수행해 boot보다 ISR edge가 앞서지 않게 한다. Queue overflow는 atomic resync-needed를 세우고 task가 queue drain 뒤 GPIO authoritative level을 읽어 수렴시킨다. UART0 console 사용 시 GPIO 23/24를 제외한다. Sensor callback 내부 stop은 명시적 invalid-state로 거부하고 외부 control context cleanup만 허용한다. 실제 queue/ISR/lifecycle 경로는 host fake 또는 ESP-IDF component test로 실행한다. Test build는 BLE/sensor 초기화 전에 fail-stop하며 raw flash 우회를 해도 RF가 동작하지 않는다. Production build는 Bluetooth SIG 자사 할당값과 서명된 제조 승인 manifest의 exact match를 검증하지 못하면 실패하고, 저장소 임의 숫자만으로 통과할 수 없게 한다. OTA app partition과 release free-margin gate를 Task 16 전 확장·강제하고 문서 수치를 build 산출물과 일치시킨다.
- Fix round 1 implementer status: DONE_WITH_CONCERNS.
- Fix round 1 implementation: GPIO control IRAM default/compile guard와 linker-map address audit, ordered boot critical reconciliation, overflow dropped/resync flag와 task authoritative convergence, 기본 UART0 GPIO23/24 및 custom console configured GPIO exclusion, callback self-stop invalid-state와 complete external cleanup을 구현했다. Test image는 app 첫 분기에서 NVS/Bluetooth/sensor side effect 없이 fail-stop한다. Production은 exact CID signed manufacturing approval와 trusted key fingerprint 없이는 시작하지 않으며 artifact manifest가 binary/CID/mode/sdkconfig/map/generated flash args/partition/approval hash를 결속한다. 4 MiB flash는 `0x1f0000` two-OTA slot과 `max(20%, 256 KiB)` production free gate를 사용한다.
- Fix round 1 TDD: Native GPIO helper RED, actual `ESP_PLATFORM` driver host fake의 boot/ISR interleaving·33번째 overflow High·resync race·self-stop·failure/repeated lifecycle, test runtime side-effect 0회, IRAM unsafe map, unsigned/mismatched/bad-signature/untrusted-key CID, artifact binary/sdkconfig/CID tamper와 OTA margin RED/GREEN을 검증했다.
- Fix round 1 test evidence: Native/actual-driver host fake/artifact/build gate와 기존 firmware host 회귀, shell syntax/diff-check를 통과했다. ESP-IDF v5.5.1 clean `esp32h2` test-build와 map audit는 binary `0xe64f0`(`943,344`), slot `0x1f0000`(`2,031,616`), free `0x109b10`(`1,088,272`, 54%), production minimum `406,324`를 기록했다. ISR/GPIO/timer/queue-send는 모두 `0x408...` IRAM이다.
- Fix round 1 concerns: 실제 자사 CID/제조 승인 key·manifest가 없어 real production build는 의도적으로 fail-closed다. 실제 ESP32-H2 flash, cache-disabled edge, 센서 전압/rise-fall/noise/ESD, real queue timing/power-cycle과 Raspberry Pi BLE Mesh RF HIL은 미실행이다.
- Fix round 1 commit: self (`fix(firmware): close task 15 review gaps`).
- Implementer status: DONE
- Commit: `5d17f16`.
- Test evidence: Gateway 523/523, shared 74/74, Docker 17/17, Mosquitto 2/2; Shared/Gateway typecheck/lint/build/diff-check 통과.
- Review verdict: CHANGES_REQUIRED, P1 3개/P2 4개.
- Fix round 1 ruling: Espressif Company Identifier 하드코딩은 제거하고, production은 Bluetooth SIG가 자사에 할당한 Company Identifier를 명시적 deployment/build config로 주입하지 않으면 fail-closed한다. 테스트 전용 reserved fixture 값은 production 경로에서 허용하지 않는다. Source별 durable current boot와 bounded recent boot high-water를 저장해 이미 관측한 이전 boot packet은 ACK만 하고 runtime에 재적용하지 않는다. Normalized sensor identity는 automation state transition과 같은 durable transaction에 inbox receipt로 포함해 runtime/dedupe 두 저장소 간 crash window를 없앤다. Provisioning terminal publish는 capability refresh와 분리하고 refresh 실패는 별도 durable retry/health로 격리한다. Motion Sensed는 0~100 Percentage 8로 decode해 0 초과를 active로 정규화한다. Capability commit uncertainty는 target read-back으로 기존/신규 identity를 채택하거나 모호하면 fail-closed한다. Sensor intake는 차단 후 in-flight queue까지 bounded drain한다.
- Fix round 1 commit: `2ac5dda`.
- Fix round 1 test evidence: focused 189/189, Gateway 535/535, shared 75/75, Docker 17/17, Mosquitto 2/2; typecheck/lint/build/diff-check 통과.
- Fix round 1 re-review: 기존 7건 중 6건 해결, 최초 refresh journal write 실패 유실과 multi-node O(N²) journal I/O P2 2개 active.
- Fix round 2 ruling: capability refresh enqueue 최초 durable write가 실패하면 controller는 bounded in-memory pending set과 retry backoff를 즉시 유지하고 shutdown drain에 포함한다. Process crash 뒤에는 configured source 전체 startup refresh가 source of truth로 복구한다. Startup/reconnect multi-node refresh는 pending node ID batch를 1회 durable commit하고 Config 결과 전체를 수집한 뒤 binding 변경·pending completion을 1회 batch commit하여 journal rewrite 횟수와 bytes를 O(N)으로 제한한다. 개별 provisioning refresh도 같은 batch API를 재사용한다.
- Fix round 2 commit: `f42189b`.
- Fix round 2 test evidence: focused 199/199, Gateway 545/545, shared 75/75, Docker 17/17, Mosquitto 2/2; typecheck/lint/build/diff-check 통과.
- Fix round 2 re-review: RESOLVED, 잔여 P1/P2 0건.
- Task 14: complete

### Task 15

- Base: `f42189ba5ba3180aa5ef55667699072c7f945629`
- Implementer: `01a05320-5671-7640-b6e5-f49d711ea71d` (Bernoulli, gpt-5.6-sol/high)
- Brief: `task-15-brief.md`
- Ruling: software debounce는 사용자 요구에 따라 금지하고 동일 level 중복만 제거한다. 실제 자사 Bluetooth SIG Company ID가 없으므로 production build fail-closed를 유지하며 자동 target build는 명시적 test-build gate의 reserved fixture만 사용하고 HIL/양산 flash 불가로 표시한다.
- Implementer status: RUNNING
- Task 14 fix round 2 implementer status: DONE_WITH_CONCERNS.
- Task 14 fix round 2 implementation: 최초 enqueue 전 bounded volatile pending set, 1초~30초 capped retry와 health 진단, active retry shutdown drain, pending enqueue 1회와 successful binding/completion 1회의 atomic batch API를 production controller/journal/reconnect에 연결했다. Partial Config failure는 해당 node pending을 유지하고 serial queue와 stale timer 취소로 starvation/parallel duplicate를 막는다.
- Task 14 fix round 2 TDD: 최초 enqueue ENOSPC 자동 회복과 active retry drain, 100/1,000 node write 2회·bytes 선형, partial failure/restart/unchanged revision, batch previous/next/unknown uncertainty, queued stale retry 중복과 last-pending health 복구를 검증한다.
- Task 14 fix round 2 test evidence: Gateway focused 199/199, full 545/545, shared 75/75, Docker 17/17, Mosquitto 2/2; Shared/Gateway typecheck/lint/build와 diff-check 통과.
- Task 14 fix round 2 commit: self (`fix(gateway): batch capability refresh journal writes`).
- Task 14 fix round 2 concerns: 실제 Raspberry Pi filesystem ENOSPC/sudden power loss, 10,000-node appliance startup latency와 flash wear, BlueZ/ESP32-H2 RF HIL은 미실행이다.
- Task 14 fix round 1 implementer status: DONE_WITH_CONCERNS.
- Task 14 fix round 1 implementation: shared Company ID deployment/build 계약과 fail-closed production wiring, automation state v5 atomic sensor inbox, current/recent boot high-water, strict Presence/Motion codec, terminal-first provisioning과 durable capability refresh retry/health, capability identity uncertainty reconciliation, accepted sensor promise bounded drain을 구현했다. Sensor production 모듈은 codec/controller/capability failure boundary로 분리했다.
- Task 14 fix round 1 TDD: boot oscillation/restart, previous boot ACK-only, runtime transition+receipt commit failure/uncertainty/restart, active/hold 회귀, Motion 0/100/101과 Presence 0/1/2, capability previous/next/unknown read-back, provisioning production handler, startup refresh pending, parser byte/session bounds, shutdown timeout을 검증했다.
- Task 14 fix round 1 test evidence: Gateway focused 189/189, full 535/535, shared 75/75, Docker 17/17, Mosquitto 2/2; Shared/Gateway typecheck/lint/build와 diff-check 통과.
- Task 14 fix round 1 commit: self (`fix(gateway): close vehicle sensor review gaps`).
- Task 14 fix round 1 concerns: 실제 자사 Company ID를 주입한 Raspberry Pi BlueZ/ESP32-H2 RF, packet loss, sudden power loss, bootId entropy/oscillation과 flash wear HIL은 미실행이다.
- Breaker implementation: coordinator가 현재 durable state의 pending handoff/gap ID를 journal recovery 보호 집합으로 전달한다. Outbox는 accepted aggregate baseline이 있는 import commit에서 보호 집합 밖으로 밀려난 general source receipt만 제거하며 current journal source, cumulative source, aggregate와 active baseline identity를 유지한다. Definite cleanup failure는 이전 state를 유지하고 commit uncertainty는 기존 visible previous/next reconciliation을 그대로 사용한다.
- Breaker TDD: clear 100회 실패와 source 교체에서 receipt 최대 2개, 50회 지점 restart 뒤에도 최대 2개와 total 100, pending/current/cumulative/aggregate 보호, cleanup definite failure 및 previous/next uncertainty, clear 회복 뒤 동일 event ID/sequence/final hash를 검증했다. RED에서는 각각 101개, restart 101개, obsolete receipt 1개와 cleanup 후 3개가 재현됐다.
- Breaker test evidence: Gateway focused 2파일 42/42, full 56파일 499/499, shared 74/74, Docker 17/17, Mosquitto 2/2; Shared/Gateway typecheck/lint/build와 diff-check 통과.
- Breaker commit: self (`fix(gateway): bound telemetry recovery receipts`).
- Task 13: complete (software, fix round 5 breaker).
- Fix round 4 implementer status: DONE_WITH_CONCERNS.
- Fix round 4 commit: self (`fix(gateway): retain initial telemetry gaps`).
- Fix round 4 implementation: 최초 gap 후보를 state write 전에 stable identity/count로 만들고 definite state ENOSPC에서 같은 후보를 fixed journal에 수용한다. 양쪽 실패는 하나의 cumulative memory source와 degraded health로 유지하고 coordinator가 같은 source를 bounded retry한다. Journal은 일반 last source와 별도로 cumulative gap source receipt 하나를 고정 저장해 interleaving과 stale state replay를 delta 0으로 수렴시키며, retry가 outbox를 바꾸면 publisher를 깨운다. Transient outbox recovery 실패도 다음 bounded retry를 다시 예약하고 commit uncertainty는 journal success로 재분류하지 않는다.
- Fix round 4 test evidence: Task 13 focused 8파일 161/161, Gateway 56파일 488/488, shared 74/74, Docker 17/17, Mosquitto 2/2; Shared/Gateway typecheck·lint·build와 diff-check 통과.
- Fix round 4 concerns: 실제 Raspberry Pi filesystem exhaustion, sudden power loss, fixed-block storage wear와 ESP32-H2/BlueZ RF HIL은 미실행이다.
- Task 13: complete (software, fix round 4).
- Fix round 5 implementer status: DONE_WITH_CONCERNS.
- Fix round 5 implementation: fixed journal에 outbox가 durable 수용한 aggregate baseline과 acceptance handoff/hash를 in-place 저장한다. Aggregate identity는 clear까지 고정하고 reimport는 source metadata가 아니라 `aggregate - acceptedBaseline`만 반영한다. Outbox commit 뒤 baseline/clear의 previous·next visible uncertainty와 source 교체/restart에서도 같은 `telemetry_gap` event identity/sequence/hash와 정확한 cumulative count로 수렴하며 clear tombstone generation 뒤 새 source도 보존한다.
- Fix round 5 test evidence: Task 13 focused 8파일 175/175, Gateway 56파일 494/494, shared 74/74, Docker 17/17, Mosquitto 2/2; Shared/Gateway typecheck·lint·build와 diff-check 통과.
- Fix round 5 concerns: 실제 Raspberry Pi filesystem exhaustion, sudden power loss, fixed-block storage wear와 ESP32-H2/BlueZ RF HIL은 미실행이다.
- Fix round 5 commit: self (`fix(gateway): converge telemetry gap baselines`).
- Task 13: complete (software, fix round 5).
- Fix round 1 implementer status: DONE.
- Fix round 1 commit: self (`fix(gateway): harden automation telemetry handoffs`).
- Fix round 1 implementation: state schema v4 exact pending handoff, outbox atomic/idempotent appendBatch receipt, cumulative persisted-gap identity, preallocated 8 KiB two-block journal, 64 MiB rewrite reserve, degraded cold start와 post-commit monotonic deadline 교체를 production runtime에 연결했다.
- Fix round 1 test evidence: Gateway focused 119/119, full 464/464, Docker 17/17, Mosquitto 2/2, shared 74/74; Shared/Gateway typecheck/lint/build와 diff-check 통과.
- Fix round 1 concerns: Raspberry Pi filesystem exhaustion/storage-wear와 ESP32-H2/BlueZ RF HIL은 미실행이다.
- Fix round 5 implementer status: DONE_WITH_CONCERNS.
- Fix round 5 commit: `80bdaae42a2f28351262b39cfdec951a0ae10f6c` (`fix(gateway): close automation recovery gaps`).
- Fix round 5 test evidence: Shared focused 34/34, full 74/74; API focused 49/49, full 727 passed; Gateway focused 165/165, full 417/417; Docker 17/17; Mosquitto 2/2; Shared/API/Gateway typecheck/lint/build와 diff-check 통과.
- Fix round 5 concerns: API publisher 선배포를 지키지 않으면 untrusted Gateway가 stale old-API outbox delay를 복구할 수 없다. Raspberry Pi/BlueZ/ESP32-H2 HIL은 미실행이다.
- Task 12: complete (software, fix round 5)
- Fix round 5 breaker implementation: targeted queue는 capacity까지 부분 수용하고 overflow를 active/idle full-resync의 guaranteed rerun으로 승격한다. 4,097개 terminal commit failure의 마지막 fixture가 bounded full 순회에서 관측될 때까지 durable fence를 유지한다. Clock-untrusted legacy timed wire는 `legacy_timing_unverifiable` fixture terminal로 종료하고 RF/manual state를 만들지 않으며 trusted legacy와 untrusted new generation은 정상 실행한다.
- Fix round 5 breaker rollout: new API publisher 가동 -> old publisher 완전 종료 -> broker max expiry 10초 drain -> Gateway 배포.
- Fix round 5 breaker test evidence: Shared focused/full 34/74, API focused/full 49/727, Gateway focused/full 170/422, Docker 17/17, Mosquitto 2/2; Shared/API/Gateway typecheck/lint/build와 diff-check 통과.
- Fix round 5 breaker commit: `f93018b79e4a062c0cebaa0c3c928414773bcb56` (`fix(gateway): close task 12 breaker gaps`).
- Task 12: complete (software, breaker fix)
- Breaker continuation implementation: scheduler의 durable pending observation snapshot을 queryable source로 노출하고, full/targeted pass 뒤 source를 capacity-sized circular window로 targeted queue에 재삽입한다. Full error와 incomplete report는 250ms~30초 capped backoff로 rerun하고 restart pending ID는 startup worker에 seed한다. Permanent offline fence, duplicate RF 억제, `AbortSignal`과 5초 shutdown drain은 유지한다.
- Breaker continuation test evidence: Gateway focused 162/162, full 428/428, Docker 17/17, Mosquitto 2/2; Gateway typecheck/lint/build와 diff-check 통과.
- Breaker continuation commit: `63659e5e8da1d24e5e654cf84a2625d922c9273b` (`fix(gateway): retry durable observation fences`).
- Task 12: complete (software, breaker continuation)
