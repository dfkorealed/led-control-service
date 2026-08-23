# SDD ledger — plan: docs/superpowers/plans/2026-08-19-monitoring-control-focused-completion.md

## 재개 상태

- 현재 범위: Task 9만 구현하고 사용자 확인 Gate 9에서 중지한다.
- 기준 커밋: `0aeb239`
- 작업 위치: 사용자가 지정한 현재 브랜치 `codex/mvp1-cloud-web`의 깨끗한 checkout.
- Spec: `docs/superpowers/specs/2026-08-19-monitoring-control-focused-completion-design.md`

## 사전 충돌 점검

| 생산 Task | 소비 Task | 공유 파일/인터페이스 | 점검 결과 |
| --- | --- | --- | --- |
| Task 9 | Task 10 | `MeshControlGroup`, `MeshControlGroupMember`, `mesh-control-group.service.ts` | Task 9의 `configuring/ready/failed`, version, last error가 Task 10 sync worker 요구와 일치한다. |
| Task 9 | Task 11 | floor/fixture-group별 gateway group과 member 관계 | Task 9는 영속 모델과 allocator만 만들고 member 자동 동기화는 Task 11에 남겨 범위가 충돌하지 않는다. |
| Task 9 | Task 9 | public interface와 테스트 예시 | 계획의 interface 표기는 `tx`를 생략하지만 테스트와 기존 allocator는 TransactionClient를 첫 인자로 요구한다. |

Ruling: `ensureFloorGroup`과 `ensureFixtureGroup`은 `tx`를 첫 인자로 받는다 — 주소 예약과 그룹 생성을 호출자 transaction 하나로 묶어야 하기 때문이다 — 잘못되면 Task 10/11 호출부에서 얇은 wrapper를 추가해야 한다.

Ruling: 그룹 주소는 Gateway의 next pointer를 DB에서 원자 증가시키고 증가 전 값을 할당한다 — 기본값 `49152`가 첫 주소 `0xc000`이어야 하기 때문이다 — 잘못되면 migration 전에 allocator semantics를 조정해야 한다.

Ruling: 주소 범위는 양 끝을 포함한 `0xC000~0xFEFF`이며 초과 시 transaction을 실패시킨다 — BLE Mesh group address 범위와 계획의 명시값을 보존하기 때문이다.

## Task 9 실행

- 기준 커밋: `0aeb239`
- 구현 에이전트: `01a01f4d-5bd6-7360-a2ff-fae1dd0c0ca5` (Fermat)
- 구현 커밋: `9dbc596`
- 리뷰 에이전트: `01a01f55-a8ce-7fd1-9bbf-026566d19eb3` (Aquinas)
- Fix round 1: member의 subscription 상태/적용 version 의미를 명시하고, group과 node의 gateway가 일치하도록 DB 복합 FK를 추가한다.

Ruling: 두 리뷰 finding을 모두 수용한다 — 후속 subscription ACK가 `configurationVersion`과 `appliedVersion`을 비교해야 하고 tenant/gateway 경계를 DB가 보장해야 하기 때문이다 — 복합 unique index와 member의 `gatewayId` 컬럼이 추가된다.

- Fix round 1 커밋: `2348012`
- Fix round 1 re-review: 기존 finding은 해결했지만 child의 `@@unique([groupId, gatewayId])`, `@@unique([meshNodeId, gatewayId])`가 정상 다대다 cardinality를 막는 새 Critical 결함을 도입했다.
- Fix round 2: parent의 compound unique와 child의 compound FK는 유지하고, child 쪽 두 제약은 일반 index로 교체한다.

Ruling: compound FK의 참조 대상인 parent group/node에만 compound unique가 필요하다 — child 컬럼은 unique일 필요가 없고 복수 node/group membership을 허용해야 한다 — 잘못되면 PostgreSQL migration 검증에서 FK 생성이 실패한다.

- Fix round 2 커밋: `3271482`
- Fix round 2 re-review: 모든 finding 해결, 새 Critical/Important breakage 없음.
- 문서 정합성 커밋: `5cc693e`
- 최종 검증: Prisma generate/validate, Task 9 11개 테스트, API 전체 349개 테스트, API typecheck, diff check 통과. 기존 opt-in 테스트 26개는 skip.
- Task 9: complete
- 사용자 확인 Gate 9: 대기

## Task 10 실행

- 기준 커밋: `5cc693e`
- 사용자 확인 Gate 9 승인: 2026-08-21

### 사전 충돌 점검

| 생산 Task | 소비 Task | 공유 파일/인터페이스 | 점검 결과 |
| --- | --- | --- | --- |
| Task 10 | Task 10 | gateway MQTT runtime과 실제 command wiring | runtime은 generic handler dispatch만 제공하므로 실제 topic subscribe/handler 연결은 `apps/gateway/src/index.ts`와 adapter capability까지 수정해야 한다. |
| Task 10 | Task 10 | API worker와 Nest provider graph | worker가 실제 10초 주기로 실행되려면 `mesh-control-group.module.ts`가 `MqttModule`을 import하고 worker를 provider로 등록해야 한다. |
| Task 10 | Task 11 | `MeshControlGroupMember`와 sync worker | Task 11 전에는 member가 없을 수 있으므로 worker는 member 0개 group을 발행하지 않고 `configuring`으로 유지한다. |
| Task 10 | Task 12 이후 | group `ready` 상태 | ACK version이 현재 `configurationVersion`과 일치하고 모든 member의 적용 성공이 확인된 경우에만 `ready`가 된다. |

Ruling: 계획의 Files 목록에 `apps/gateway/src/index.ts`, 관련 index/adapter 테스트, `bluez-mesh-adapter.ts`, `adapter-factory.ts`, `apps/api/src/mesh-control-groups/mesh-control-group.module.ts`를 추가한다 — 이 파일 없이는 실제 양산 진입점과 Nest worker가 연결되지 않기 때문이다 — 잘못되면 diff 범위가 계획보다 넓어진다.

Ruling: sync command/result는 siteId와 gatewayId를 payload에도 포함하고 topic scope와 교차 검증한다 — broker ACL만 애플리케이션 권한 검증으로 신뢰하지 않는 기존 MQTT v2 원칙 때문이다 — 메시지 필드가 계획 예시보다 늘어난다.

Ruling: repeated group/version command는 표준 Config Model Subscription Add의 멱등성으로 재처리하고 동일 version ACK를 허용한다. stale version ACK는 무시한다 — API replica/worker retry에도 물리 구성이 수렴해야 하기 때문이다.

Ruling: member가 0개인 configuring group은 Task 11이 membership을 생성할 때까지 worker가 발행하지 않는다 — 빈 ACK로 group을 ready로 만드는 것을 막기 때문이다.

- 구현 에이전트: `01a021a4-21cd-7ce2-bdc3-7aeffc0b8e8b` (Franklin)
- 구현 커밋: `fadaf53`
- 리뷰 에이전트: `01a021b6-00e5-7f20-9d2d-0e310ab08d08` (Hypatia)
- Fix round 1: 공개 MQTT result를 `ready | failed`로 복원하고, worker 발행 오류를 group별로 격리하며, member `statusVersion` migration으로 현재 구성 version의 성공/실패만 집계하고, Config Status에 request-specific raw matcher를 추가한다.

Ruling: 외부 MQTT 성공 상태는 Task brief의 `ready`를 유지하고 API에서 내부 `subscriptionStatus = applied`로 변환한다 — 공개 계약과 DB 상태 이름의 역할이 다르기 때문이다 — 잘못되면 shared 계약 소비자를 함께 마이그레이션해야 한다.

Ruling: 과거 실패 혼입은 worker reset에 의존하지 않고 `statusVersion`을 영속화해 해결한다 — 다중 API worker와 늦은 ACK가 겹쳐도 결과 version을 판별해야 하기 때문이다 — DB migration과 스키마 문서 갱신이 추가된다.

- Fix round 1 커밋: `854979a`
- Fix round 1 re-review: 기존 4개 Important finding 해결, 새 Critical/Important finding 없음.
- Fix round 2: gateway 전체 테스트에서 새 subscription topic 기대값 누락을 발견해 `index.test.ts`를 실제 5개 topic 계약과 일치시킨다.
- Fix round 2 커밋: `6dd17b5`
- Fix round 2 re-review: 승인, 새 Critical/Important finding 없음.
- 최종 검증: shared 27개, gateway 189개, API 353개 테스트 통과. API opt-in 테스트 26개는 skip. gateway/API typecheck, Prisma generate/validate, diff check, clean worktree 통과.
- Task 10: complete
- 사용자 확인 Gate 10: 대기

## Task 11 실행

- 기준 커밋: `6dd17b5`
- 사용자 확인 Gate 10 승인: 2026-08-21

### 사전 충돌 점검

| 생산 Task | 소비 Task | 공유 파일/인터페이스 | 점검 결과 |
| --- | --- | --- | --- |
| Task 11 | Task 10 | `MeshControlGroupMember.statusVersion`, sync worker | membership 변경 시 group을 `configuring`으로 만들고 현재 version ACK 전에는 `ready`가 되지 않아야 한다. |
| Task 11 | Task 12 | `getReadyDestination()` | Task 12가 group delivery를 선택하기 전에 gateway/target 범위와 `ready` 상태를 검증할 API가 필요하다. |
| Task 11 | provisioning completion | MeshNode/Fixture 생성 transaction | membership 생성도 같은 transaction에 들어가야 등록 완료만 남고 group 구성이 누락되는 부분 성공을 막을 수 있다. |
| Task 11 | Nest module graph | `MqttService -> MeshControlGroupService`, sync worker | 현재 `MeshControlGroupModule -> MqttModule` 방향을 유지하면 순환 의존성이 생긴다. |

Ruling: 등록 요청 transaction에서 floor group을 선할당한다 — 주소 고갈과 site/gateway 오류를 물리 provisioning 전에 차단하기 위해서다 — 잘못되면 미사용 configuring group row가 남을 수 있으나 다음 등록에서 재사용된다.

Ruling: 새 member가 기존 ready/failed group에 추가될 때만 configuration version을 증가시키고 모든 member 상태를 pending으로 초기화한다 — 새 membership이 포함된 동일 구성 전체를 ACK해야 ready가 되기 때문이다 — 잘못되면 기존 node에 멱등 Config Subscription Add가 한 번 더 전송된다.

Ruling: configuring 빈 group의 첫 member는 초기 version 1을 유지한다 — 아직 물리 적용된 구성 version이 없기 때문이다 — 잘못되면 첫 구성 version이 2부터 시작한다.

Ruling: `MeshControlGroupModule`은 persistence service만 제공하고 `MqttModule`이 sync worker를 소유한다 — `MqttService`가 group service를 사용하면서 Nest 순환 의존성을 피하기 위해서다 — worker provider 위치가 파일 namespace와 다르지만 런타임 책임과 일치한다.

- 구현 에이전트: `01a021d0-b768-74c1-bce8-baff7694eee5` (Aristotle)
- 구현 커밋: `5d9a26c`
- 리뷰 에이전트: `01a021dc-6526-70d1-9cb3-6f670d63d325` (Ohm)
- Fix round 1: group row 선잠금과 `createMany(skipDuplicates)`로 member attach를 직렬화하고, ACK도 group->member 잠금 순서로 맞춘다. 기존 Fixture의 다른 층 재사용을 실패 처리하고 existing group fast path의 site boundary를 검증한다.

Ruling: 다른 층에 이미 연결된 Fixture는 자동 이동하지 않고 `failed`로 종료한다 — 위치, 구역 membership, 물리 subscription 제거까지 원자적으로 옮기는 기능이 현재 범위에 없기 때문이다 — 실제 층 이동은 별도 운영 기능이 필요하다.

- Fix round 1 커밋: `ab5c8dd`
- Fix round 1 re-review: 기존 3개 Important 해결. ACK join의 bare `FOR UPDATE`가 Gateway까지 잠글 수 있는 새 Important 발견.
- Fix round 2: ACK lock SQL을 `FOR UPDATE OF g`로 제한하고 SQL 문자열 회귀 테스트를 추가한다.
- Fix round 2 커밋: `f62ca34`
- Fix round 2 re-review: 승인, 새 Critical/Important finding 없음.
- 최종 검증: API 367개 테스트 통과, 기존 opt-in 테스트 26개 skip. API typecheck/build, Prisma validate, diff check, clean worktree 통과.
- 검증 한계: 실제 PostgreSQL의 두 concurrent transaction interleaving은 자동 통합 테스트로 실행하지 않았고, row-lock SQL과 원자적 `createMany(skipDuplicates)` 계약을 단위 테스트와 리뷰로 검증했다.
- Task 11: complete
- 사용자 확인 Gate 11: 대기

## Task 12 실행

- 기준 커밋: `f62ca34`
- 사용자 확인 Gate 11 승인: 2026-08-22

### 사전 충돌 점검

| 생산 Task | 소비 Task | 공유 파일/인터페이스 | 점검 결과 |
| --- | --- | --- | --- |
| Task 12 | Task 13 | Gateway dimming payload | Task 12는 delivery metadata를 계약과 outbox에 저장하고, 실제 병렬/그룹 BLE Mesh 송신은 Task 13에 남긴다. |
| Task 12 | Task 14 | 웹 제어 요청 | 현재 웹은 legacy `{ targetType, targetId }`를 사용하므로 controller에서 새 target union으로 한시 정규화해야 Gate 12에서 기존 UI가 깨지지 않는다. |
| Task 12 | Task 11 | `getReadyDestination()` | floor/group 및 임의 선택 승격은 Task 11이 보장한 ready destination만 사용한다. |
| Task 12 | Command status | 기존 Command target 표시 | `targetId`가 nullable이 되므로 다중 target은 `targetFixtureIds` snapshot으로 추적하고 status 응답의 null 처리 회귀를 확인해야 한다. |

Ruling: 서비스 내부 입력과 신규 저장 계약은 새 `target` union만 사용하고 legacy 입력은 controller 경계에서만 정규화한다 — Task 14 전 기존 UI를 유지하면서 신규 도메인 로직에 구형 분기를 퍼뜨리지 않기 위해서다 — Task 14 완료 후 adapter 제거 여부를 다시 판단한다.

Ruling: floor/group target은 ready Mesh control group이 없을 때 unicast로 fallback하지 않는다 — 물리 subscription이 확인되지 않은 group을 성공처럼 처리하지 않기 위해서다 — 설정 미완료 현장은 명확한 오류를 받는다.

Ruling: 임의 선택 exact-match 승격은 floor 후보를 우선하고 같은 종류 후보는 ID 정렬로 결정한다 — 여러 물리 주소가 같은 fixture 집합을 나타내도 결과가 재현 가능해야 하기 때문이다 — 잘못되면 다른 ready group 주소가 선택될 수 있다.

Ruling: 현재 단일 gateway 양산 범위에서는 하나의 논리 target이 여러 gateway에 걸치면 전체 요청을 거부한다 — 부분 제어나 여러 dispatch의 단일 응답 의미를 이번 범위에서 숨기지 않기 위해서다 — 다중 gateway fan-out은 별도 후속 설계가 필요하다.

### Task 12 구현

- target schema, legacy controller 정규화, delivery metadata Gateway 계약을 TDD로 확장했다.
- DB 관계 재조회와 Command/Dispatch/fixture result/outbox 생성을 하나의 transaction callback에 배치했다.
- 임의 exact match는 floor 우선과 ID 정렬을 적용하고 ready destination이 없으면 `parallel_unicast`를 유지한다.
- 공개 요청 검증 실패는 원본 Zod 상세나 500이 아니라 `invalid dimming command request` 400으로 변환한다.

Ruling: `targetFixtureIds`는 요청값이 아니라 transaction 안에서 다시 계산한 정렬 fixture ID snapshot을 저장하고 Gateway payload에도 같은 배열을 사용한다 — 명령 이력과 장비별 결과 집합이 생성 이후 floor/group 변경에 흔들리지 않게 하기 위해서다 — 잘못되면 상태 조회와 ACK 결과 수가 불일치한다.

Ruling: Gate 12에서는 Gateway payload와 DB metadata까지만 확장하고 비-unicast 실제 송신은 Task 13에 남긴다 — 계획의 생산자/소비자 경계를 보존하기 위해서다 — 따라서 Gate 12 단독 상태는 group 하드웨어 제어 배포 완료가 아니다.

- 사전 검증: shared 30개, commands 20개, API 전체 371개, Gateway 전체 189개 테스트 통과. API opt-in 26개는 skip.
- Task 12 보고서: `.superpowers/sdd/2026-08-19-monitoring-control-focused-completion/task-12-report.md`
- 구현 커밋: `9aeea66`
- Task 12: 구현, 최종 자동 검증 및 단일 작업 커밋 완료
- 사용자 확인 Gate 12: 대기

### Task 12 독립 리뷰

- 리뷰 에이전트: `01a0286e-123d-7930-afe3-473265de1cda` (Mill)
- 결과: Important 3건으로 승인 보류
- Finding 1: 이전 버전이 만든 미발행 outbox JSON에는 필수 `deliveryMode`가 없어 신규 publisher parse에서 영구 실패한다.
- Finding 2: ready group address만 snapshot하고 구성 ID/version을 저장하지 않아 group 재구성과 outbox 지연 사이에 실제 물리 대상이 달라질 수 있다.
- Finding 3: Gateway wire schema가 target type, target ID, fixture 수, delivery mode가 서로 모순인 payload를 허용한다.

Ruling: 이전 `group` outbox는 신규 의미의 Mesh group 명령으로 변환하지 않고 물리 fixture 목록 기반 `fixtures` 명령으로 migration한다 — 과거 명령은 물리 subscription ready/version 증거가 없고 기존 Gateway가 목록 unicast로 실행했기 때문이다 — fixture 수 1개는 `unicast`, 2개 이상은 `parallel_unicast`로 backfill한다.

Ruling: Mesh group delivery에는 `meshControlGroupId`와 `meshControlGroupVersion`을 Dispatch 및 Gateway payload에 함께 저장하고 publisher가 발행 직전 DB의 gateway/address/status/version을 재검증한다 — 생성 이후 재구성된 주소로 오래된 명령이 발행되는 것을 막기 위해서다 — Task 13 Gateway는 로컬 적용 version 비교를 최종 물리 경계로 추가해야 한다.

Ruling: Gateway wire schema는 target type, nullable target ID, fixture 수, delivery mode, group metadata/address 범위를 하나의 불변식으로 검증한다 — MQTT consumer가 API 구현의 정상 경로만 신뢰해서는 안 되기 때문이다 — 과거 pending group outbox는 migration에서 `fixtures`로 정규화한다.

### Task 12 재리뷰 1

- 재리뷰 에이전트: `01a0286e-123d-7930-afe3-473265de1cda` (Mill)
- 수정 커밋: `b0c794c`
- 결과: 기존 wire schema finding은 해결, outbox 호환과 Mesh TOCTOU는 미해결/부분 해결이며 새 Important 2건을 포함해 승인 보류
- Finding 1: 이전 publish 시도에서 저장된 `expiresAt`이 migration 후 남아 strict draft parse를 실패시킨다.
- Finding 2: migration preflight가 DDL 뒤에 있고 명시 transaction이 없어 guard 실패 시 부분 적용된다.
- Finding 3: timeout worker가 활성 publisher lease를 취소한 뒤 이미 준비된 MQTT publish가 계속될 수 있다.
- Finding 4: Task 13의 단순 in-memory version 비교는 subscription 적용 중 race와 Gateway 재시작 복구를 닫지 못한다.

Ruling: migration은 모든 preflight를 DDL보다 먼저 수행하고 파일 전체를 명시적 transaction으로 감싼다 — edge data와 후반 DDL 오류 모두에서 부분 schema를 남기지 않기 위해서다 — 실제 PostgreSQL 성공/실패 rehearsal을 반복 가능한 검증으로 남긴다.

Ruling: legacy outbox payload는 허용 키만 재구성하거나 최소한 publish-relative `expiresAt`을 제거해 strict draft 계약으로 되돌린다 — 이전 publish 실패 row도 신규 publisher가 새 expiry로 재발행할 수 있어야 하기 때문이다 — fresh/retry 양쪽을 실제 DB rehearsal에 포함한다.

Ruling: timeout worker는 현재 시각 기준 유효한 outbox lease가 있는 pending dispatch를 조회와 조건부 update 모두에서 제외하고, MQTT publish는 lease보다 짧은 취소 가능한 timeout을 사용한다 — timeout terminal 전이와 살아 있는 publisher의 물리 publish가 동시에 성립하지 않게 하기 위해서다 — packet 취소와 활성 lease 경쟁 테스트를 추가한다.

Ruling: Task 13 Gateway group state는 group ID/address/version별 `configuring | ready | failed`를 내구 저장하고 sync/control을 group 단위 직렬화한다 — 일부 member 적용 중 이전 version 명령과 재시작 후 상태 유실을 fail-closed로 막기 위해서다 — state 유실 시 cloud ready group 전체 resync 복구 경로도 계획에 포함한다.

### Task 12 재리뷰 2

- 재리뷰 에이전트: `01a0286e-123d-7930-afe3-473265de1cda` (Mill)
- 수정 커밋: `1c65074`
- 결과: migration 원자성/실제 rehearsal과 Task 13 durable state 계획은 해결됐으나 runtime retry/lease Important 2건으로 승인 보류
- Finding 1: 새 publisher가 첫 publish 실패 후 DB에 저장한 `expiresAt` 포함 full payload를 다음 시도에서 strict draft로 parse해 실패한다.
- Finding 2: Mesh snapshot 조회 전의 오래된 `now`로 lease를 갱신해 DB 지연 뒤 이미 만료된 lease로 publish할 수 있다.
- Orchestrator 추가 finding: pending timeout transaction이 Dispatch를 먼저 갱신하고 outbox를 lease 조건 없이 나중에 닫아, Dispatch update 뒤 publisher claim 경쟁을 차단하지 못한다.

Ruling: 저장 outbox는 strict draft 또는 strict full payload 둘 중 하나로 parse한 뒤 항상 `expiresAt`을 제거한 draft로 정규화하고 새 publish-relative expiry를 만든다 — 첫 MQTT 실패도 정상 재시도 가능해야 하기 때문이다 — 두 번 연속 publish 시도 회귀 테스트를 추가한다.

Ruling: Mesh 검증을 마친 뒤 fresh clock으로 lease를 연장하되 기존 lease가 그 시각에도 유효한 경우에만 준비하고, MQTT 호출 직전 같은 worker 소유권과 유효 lease를 다시 확인한다 — 느린 DB 조회 중 다른 worker가 lease를 회수한 명령을 발행하지 않기 위해서다 — publish timeout은 갱신 lease보다 짧게 유지한다.

Ruling: pending timeout은 transaction에서 outbox를 먼저 `inactive/expired lease` 조건으로 dead-letter 선점하고 성공한 경우에만 Dispatch/fixture/Command를 종료한다 — publisher claim과 같은 outbox row에서 직렬화하기 위해서다 — published/accepted timeout은 기존 Dispatch 조건부 종료 경로를 유지한다.

### Task 12 재리뷰 3

- 재리뷰 에이전트: `01a0286e-d7b1-7e92-b0df-d0cdb05cf342` (Mill)
- 수정 커밋: `b524c40`
- 결과: full payload 재시도와 pending timeout 선점은 해결됐으나 publish fence의 stale clock Important 1건으로 승인 보류
- Finding: MQTT 직전 ownership count를 시작하기 전 시각으로 lease를 검사해 count query가 lease보다 오래 지연되면 반환 후 만료된 lease로 publish한다.

Ruling: final fence query가 반환된 뒤 fresh clock으로 준비 단계에서 받은 lease expiry가 MQTT timeout 전체를 덮는지 다시 검사한다 — DB 조회 지연을 fence 유효 시간에 포함하기 위해서다 — 만료 또는 부족하면 MQTT를 호출하지 않는다.

Ruling: publish-relative `expiresAt`은 DB 준비 단계에서 만들지 않고 final fence 반환 직후 실제 MQTT 호출 직전에 생성한다 — DB 지연으로 장비 수신 전에 command expiry가 소진되는 것을 막기 위해서다 — 성공 후 outbox의 full payload와 `publishedAt`을 같은 transaction에 저장하고 실패/프로세스 중단 시 draft를 재사용한다.

### Task 12 최종 승인

- Fix round 3 커밋: `b524c40`
- 재리뷰 3: runtime retry와 pending timeout 선점은 해결됐으나 final fence query 지연 후 만료 lease publish Important 1건으로 승인 보류
- Fix round 4 커밋: `b0c81c7`
- 재리뷰 4: Critical 0건, Important 0건으로 승인

Ruling: 준비 transaction은 Mesh snapshot 검증과 fresh lease 연장만 수행하고 full payload를 저장하지 않는다 — DB 지연이 publish-relative expiry를 소비하지 않게 하기 위해서다 — final fence 반환 뒤 fresh clock으로 lease 잔여 시간을 검증하고 새 expiry를 만든다.

- 최종 fresh 검증: Shared 41개, API 399개, Gateway 189개, PostgreSQL migration rehearsal 3개 통과. API opt-in 29개는 기본 전체 실행에서 skip하고 migration rehearsal 3개는 별도 명령으로 실제 실행했다.
- Prisma generate/validate, API typecheck/build, Gateway typecheck, `git diff --check f62ca34..HEAD`, clean worktree 확인.
- 실제 PostgreSQL migration rehearsal은 fresh/retry legacy payload strict 정규화, preflight 실패 rollback, 후반 DDL 실패 rollback을 격리 schema에서 검증했고 잔여 임시 schema 0개를 확인했다.
- 잔여 위험: Broker가 QoS 1 PUBLISH를 받은 뒤 PUBACK만 유실한 경우 이미 전달된 물리 메시지를 취소할 수 없다. Gateway idempotency journal, MQTT expiry와 Task 13의 durable group version barrier가 중복/오래된 물리 적용을 방어해야 한다.
- Task 12: complete
- 사용자 확인 Gate 12: 대기

### Task 12 독립 리뷰 Fix round 1

- Finding 1: 기존 Command는 result fixture ID snapshot, Dispatch는 실제 result 수 기반 physical mode로 backfill한다. 기존 outbox는 동일 fixture 목록으로 strict payload를 만들고 과거 group 명령은 `fixtures`로 정규화한다. result가 없거나 1,000개를 초과하는 outbox는 migration을 중단한다.
- Finding 2: ready destination의 group ID/address/configurationVersion을 Dispatch와 payload에 snapshot하고 Publisher가 payload 준비 transaction 안에서 현재 group과 다시 비교한다. 동일 version `configuring`만 재시도하고 missing/failed/version/address/gateway mismatch는 `MESH_GROUP_STALE` terminal failure로 종료한다.
- Finding 3: Shared wire schema에 fixture unique/1,000개 제한, target 조합, Group Address 범위, Mesh metadata 필수·금지 불변식을 추가했다.

Ruling: `CommandDispatch(meshControlGroupId, gatewayId)`는 `MeshControlGroup(id, gatewayId)`를 참조하는 `ON DELETE RESTRICT` 복합 FK를 사용한다 — 잘못된 gateway 조합을 DB에서 차단하고 발행 대기 및 감사 명령의 물리 group snapshot을 삭제로 무효화하지 않기 위해서다 — 운영상 group 제거는 참조 명령 보존 정책과 함께 처리해야 한다.

Ruling: Publisher 검증과 outbox payload 준비는 하나의 DB transaction으로 묶고 실제 MQTT publish는 commit 뒤 수행한다 — stale payload를 publish하지 않으면서 DB transaction 안에 외부 I/O를 넣지 않기 위해서다 — commit과 publish 사이 극소 race는 Task 13 Gateway의 로컬 적용 version 비교로 최종 차단한다.

Ruling: Task 12 migration은 아직 실제 환경에 적용되지 않았으므로 같은 `20260819094000_extend_command_targets` 파일을 보정한다 — 이미 적용된 환경이 생긴 뒤에는 migration 이력을 수정하지 않고 별도 순방향 migration을 만들어야 한다.

- Fix round 1 RED: Shared 11건, migration 계약 4건과 전제 검사 1건, Mesh/Commands 4건, Publisher 9건 실패 확인
- Fix round 1 GREEN: Shared 41개, API 관련 56개, API 전체 383개(기존 opt-in 26개 skip), Gateway 189개 통과. Prisma generate/validate, Shared/API/Gateway typecheck와 API build 통과.
- Fix round 1 상태: 구현 및 자동 검증 완료. 실제 PostgreSQL migration rehearsal과 Task 13 Gateway 로컬 group version 비교는 후속 범위다.

### Task 12 재리뷰 1 Fix round 2

- Finding 1: Legacy outbox JSON을 strict draft 허용 키만으로 재구성해 retry `expiresAt`과 임의 과거 키를 제거했다. Fresh fixture/unicast와 retry group→fixtures/parallel_unicast payload를 실제 PostgreSQL 결과에서 shared schema로 parse한다.
- Finding 2: 모든 preflight를 DDL 전에 이동하고 migration 전체를 명시적 transaction으로 감쌌다. 무작위 임시 schema rehearsal은 성공, guard 실패, 후반 index 실패를 실행하고 실패 뒤 신규 컬럼/constraint가 0개인지 확인한다.
- Finding 3: Timeout worker가 유효 publisher lease를 초기 조회와 transaction update에서 모두 제외한다. Publisher는 prepare 시 lease를 검증·30초 갱신하고 MQTT publish를 20초로 제한해 timeout 시 해당 outgoing message ID를 제거한다.
- Finding 4: Task 13 계획/설계/제어 문서에 durable group state, configuring fsync barrier, member 전체 성공 후 ready+ACK, 부분 실패 fail-closed, group 단위 sync/control 직렬화, restart restore, state 유실·손상 시 cloud ready group full resync와 자동 테스트를 명시했다. Task 13 코드는 구현하지 않았다.

Ruling: 실제 migration rehearsal은 `COMMAND_MIGRATION_TEST_DATABASE_URL`이 지정된 경우에만 실행하고 무작위 schema만 생성·삭제한다 — 개발자 로컬 사용자 데이터를 건드리지 않으면서 PostgreSQL DDL/JSON/rollback 의미를 검증하기 위해서다 — 기본 전체 test에서는 3건 skip된다.

Ruling: OutboxPublisher의 20초 MQTT timeout은 30초 lease보다 짧고 prepare transaction에서 lease를 30초로 다시 갱신한다 — publish promise가 멈춰도 timeout worker가 먼저 terminal 전이하지 않고 packet 취소 후 lease가 해제되게 하기 위해서다 — QoS 1 PUBACK 유실은 기존 idempotency와 expiry 계약으로 방어한다.

- Fix round 2 RED: migration 계약 2건, PostgreSQL rehearsal 3건, timeout lease 3건 실패 및 MQTT timeout 계약 compile 실패/Outbox 경쟁 3건 실패 확인
- Fix round 2 GREEN: Shared 41개, migration 계약 5개, PostgreSQL 16.14 rehearsal 3개, 관련 API 92개(기본 실행에서 rehearsal 3개 skip), API 전체 391개(기존 및 opt-in 29개 skip), Gateway 189개 통과. Prisma generate/validate, Shared/API/Gateway typecheck와 API build 통과.
- Fix round 2 상태: 구현, Task 13 문서화와 전체 자동 검증 완료. 실제 Task 13 Gateway durable state/BLE 송신 및 HIL은 후속 범위다.

### Task 12 재리뷰 2 Fix round 3

- Finding 1: OutboxPublisher가 strict draft와 strict full wire를 모두 입력으로 허용한다. Full은 `expiresAt`만 제거해 strict draft로 재검증하고 매 시도 fresh expiry를 만든다. 임의 extra key는 거부하며 첫 publish 실패 후 저장 full payload의 두 번째 publish 성공을 service 단위로 검증했다.
- Finding 2: Mesh snapshot 검증 직후 주입 clock의 fresh 시각으로 현재 worker가 소유한 유효 lease만 30초 연장한다. MQTT 직전에도 worker ownership과 20초 publish timeout 전체를 덮는 잔여 lease를 확인해 snapshot 지연 중 만료·회수된 row는 발행하지 않는다. 성공/backoff/dead-letter도 완료 시점 fresh 시각을 쓴다.
- Orchestrator 추가 finding: Pending timeout은 inactive/expired lease outbox를 먼저 dead-letter 선점한 뒤 Dispatch/fixture/Command를 종료한다. 필수 1:1 outbox 부재와 active lease는 fail-closed하며, 선점 뒤 Dispatch 경쟁은 sentinel exception으로 transaction 전체를 rollback한다. Published/accepted는 outbox 선점 없이 종료한다.

Ruling: MQTT 직전 lease 조건은 단순 `leaseExpiresAt > now`보다 강한 `leaseExpiresAt > now + 20초 publish timeout`을 사용한다 — MQTT promise가 허용 시간 동안 정지해도 timeout worker나 다른 publisher가 row를 회수하지 못하게 하기 위해서다 — 조건을 만족하지 못하면 현재 시도는 발행하지 않고 lease 만료 후 다시 claim한다.

Ruling: Pending CommandDispatch와 MqttOutbox는 정상 생성 경로에서 필수 1:1이므로 timeout 시 outbox가 없으면 fail-closed한다 — outbox 선점 없이 Dispatch만 종료하면 뒤늦은 물리 publish를 막을 row 경계가 없기 때문이다 — 비정상 row는 운영 조사 및 별도 복구 대상이다.

- Fix round 3 RED: runtime full retry 1건, fresh lease/publish 직전 fencing 2건, pending timeout 선점·경쟁 5건 실패 확인
- Fix round 3 GREEN: 집중 23개, Shared 41개, 관련 API 98개(3개 opt-in skip), API 전체 397개(29개 skip), Gateway 189개, PostgreSQL migration rehearsal 3개 통과. Prisma generate/validate, Shared/API/Gateway typecheck와 API build 통과.
- Fix round 3 상태: Important 2건과 orchestrator 추가 finding 구현 및 문서화 완료. Task 13 실제 BLE 송신은 변경하지 않았다.

### Task 12 재리뷰 3 Fix round 4

- Finding: Final ownership query 시작 전 `publishFenceAt`과 lease 조건을 제거했다. 준비 transaction은 snapshot 검증 후 fresh `preparedAt`으로 lease만 연장하고 실제 `leaseExpiresAt`과 정규화 draft를 반환한다. Query 반환 후 fresh clock으로 준비 lease가 20초 MQTT timeout 전체를 엄격히 덮는지 로컬 검증한다.
- Payload: Publish-relative expiry는 final fence 반환 후 fresh clock으로 만들고 즉시 MQTT에 전달한다. Full payload는 MQTT 성공 후 `publishedAt`과 같은 outbox update transaction에 저장하며, 실패/발행 전 종료에는 기존 strict draft/full payload를 유지한다.
- 회귀: 11초 지연으로 lease가 19초 남거나 31초 지연으로 만료되면 MQTT 0회다. 5초 지연은 final fence 기준 새 expiry와 10초 MQTT interval로 발행하고 성공 DB payload가 같은 full payload인지 검증한다. 기존 strict full retry와 임의 extra key 거부도 유지한다.

Ruling: Ownership query에는 반환 이후 시각을 미리 표현할 수 없으므로 lease deadline 조건을 넣지 않는다 — query 반환 후 준비 transaction에서 확정한 절대 `leaseExpiresAt`을 fresh local clock과 비교해야 DB 대기 시간을 포함할 수 있기 때문이다 — ownership count와 local timeout 여유를 모두 통과한 경우만 publish한다.

Ruling: Outbox full payload는 publish 시도 증거가 아니라 성공한 wire payload snapshot으로 저장한다 — 발행 전 저장하면 crash/실패 retry의 오래된 expiry가 다시 입력 상태가 되기 때문이다 — 실패에는 draft 또는 기존 strict full을 보존하고 성공 transaction에서만 `payload + publishedAt`을 함께 확정한다.

- Fix round 4 RED: strict full 조기 저장, ownership query 계약, 31초 지연 publish, 짧은 지연 expiry/성공 payload 저장 4건 실패 확인
- Fix round 4 GREEN: Publisher 집중 19개, Shared 41개, 관련 API 100개(3개 opt-in skip), API 전체 399개(29개 skip), Gateway 189개, PostgreSQL migration rehearsal 3개 통과. Prisma generate/validate, Shared/API/Gateway typecheck와 API build 통과.
- Fix round 4 상태: 마지막 재리뷰 Important 1건 구현 및 문서화 완료. Task 13 실제 BLE 송신은 변경하지 않았다.

## Task 13~14 재개 기록

- Task 13: Gateway 병렬 unicast, Mesh group 단일 전송, 내구 group state와 ESP32 publication 구현 및 최종 리뷰 완료.
- Task 13 최종 문서 커밋: `cba88f0`
- Task 14: 개별·다중·층·구역 target picker, 신규 target payload, 최대 1,000개 선택과 대규모 목록 batch 렌더링 구현 완료.
- Task 14 구현 커밋: `fb8968e`
- Task 14 회귀 수정 커밋: `efe4b24`
- Task 14 문서 커밋: `cd61e35`
- Task 14 최종 검증: 웹 테스트 168개와 프로덕션 빌드 통과, 독립 리뷰 Critical/Important 0건.
- Task 13: complete
- Task 14: complete
- 사용자 확인 Gate 14 승인: 2026-08-23

## Task 15 실행

- 기준 커밋: `cd61e35`
- 작업 위치: 사용자 지정 현재 브랜치 `codex/mvp1-cloud-web`

### 사전 충돌 점검

| 생산 Task | 소비 Task | 공유 파일/인터페이스 | 점검 결과 |
| --- | --- | --- | --- |
| Task 15 | `useCommandStatus` | command stage와 polling 종료 조건 | 기존 terminal 집합을 export해 UI 잠금과 polling이 같은 정의를 사용해야 한다. |
| Task 15 | Task 14 picker | `disabled`와 선택 상태 | HTTP 생성 중뿐 아니라 저장된 active command가 terminal 전까지 picker, slider, preset, apply를 모두 잠가야 한다. |
| Task 15 | 브라우저 새로고침 | 현장별 `sessionStorage` key | command ID는 site별로 분리하고 손상된 값과 저장소 접근 실패를 앱 크래시 없이 처리해야 한다. |
| Task 15 | 상태 조회 오류 | 진행 command 복구 | 네트워크 오류는 terminal 실패가 아니므로 command ID를 보존하고 수동 재조회를 제공해야 한다. |

Ruling: active command는 서버의 terminal stage가 확인될 때만 저장소에서 제거한다 — 조회 오류나 새로고침을 명령 실패로 오인하지 않기 위해서다 — 잘못되면 UI가 장시간 잠길 수 있으므로 명시적 재조회 동작을 제공한다.

Ruling: terminal 결과는 화면에 남기되 입력 잠금만 해제한다 — 사용자가 최종 성공·부분 실패·실패·timeout 결과를 확인해야 하기 때문이다 — 새 명령을 만들면 이전 결과를 교체한다.

## Task 15 작업 단위 완료

- 구현 커밋: `017c3f9`(현장별 active command session store 테스트/구현), `c4196cf`(storage 예외 테스트 보강), `a167fe3`(terminal 전 제어 입력 잠금과 새로고침 복구 연결), `703b82d`(RFC 4122 UUID 검증), `3b9598d`(command ID 불일치·404·현장 전환 경계 보강), `13e3f47`(polling 응답 command ID 검증과 cached nonterminal의 최신 404 해제 보강).
- 구현 범위: 장시간 HTTP 연결이 아닌 1초 polling 기반 사용자 관점 동기 제어. `activeCommandStorageKey`, `loadActiveCommandId`, `saveActiveCommandId`, `clearActiveCommandId`로 현장별 `sessionStorage`를 격리하고, terminal 전 대상 선택·검색·필터·slider·preset·적용 입력을 잠근다.
- 복구 계약: 현재 추적 command ID와 상태 응답 ID가 일치할 때만 terminal 결과를 반영한다. ID가 불일치하면 terminal로 처리하지 않고 1초 polling과 수동 재조회를 유지한다. terminal 결과는 화면에 남기고, 네트워크/5xx 오류는 ID를 보존한 채 재조회한다. cached nonterminal 상태가 남아도 최신 조회의 인증된 404가 확정되면 CAS 삭제와 잠금 해제를 수행한다. UUID 형식 검증과 기대 ID 비교로 손상값 및 stale clear를 차단한다.
- 최종 리뷰 Important 2건: 상태 응답 command ID 불일치에도 terminal이면 잠금이 풀릴 수 있는 문제, cached nonterminal 데이터가 있는 최신 404에서 잠금이 계속될 수 있는 문제를 확인했다. `13e3f47`에서 polling 응답 ID 검증, 불일치 시 안전 잠금 유지, cached nonterminal + 최신 404 잠금 해제를 해결했다.
- 최종 재리뷰: Critical 0건, Important 0건.
- 최종 fresh 검증: 웹 테스트 `198개`, build/typecheck/`git diff --check`, clean worktree 통과. 실제 브라우저·하드웨어 E2E는 Task 16 범위로 남긴다.
- Task 15 상태: complete
- 사용자 확인 Gate 15: 대기
