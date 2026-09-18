# 데이터베이스 테이블 구조

작성일: 2026-09-19

이 문서는 현재 구현된 PostgreSQL/Prisma 데이터베이스 구조를 정리한다. 기준 파일은 `apps/api/prisma/schema.prisma`이며, 실제 DB 반영은 `apps/api/prisma/migrations`의 migration으로 관리한다.

## 1. 전체 구조

현재 DB는 다음 업무 영역으로 나뉜다.

- 조직/사용자/인증: `Organization`(`OrganizationType`), `User`, `SiteMembership`, `Invitation`, `Session`
- 현장/공간/도면: `Site`, `Floor`(`mapRevision`), `FloorPlan`, `FloorMapObject`, `FloorLightSlot`, `FloorMapRevision`, `FloorImportRegion`, `FloorCadScene`, `FloorCadTile`, `FloorCadElementOverride`, `FloorCadLayerState`
- 조명/그룹/게이트웨이/메시 노드: `Fixture`, `FixtureGroup`, `GroupFixture`, `Gateway`, `GatewayInventory`, `MeshNode`, `MeshControlGroup`, `MeshControlGroupMember`, `MeshControlGroupExpectedOperation`, `MeshControlGroupAppliedMember`
- 게이트웨이 PKI: `GatewayEnrollment`, `GatewayCertificate`, `CertificateRevocationReconciliation`
- 제어/모니터링: `Command`, `CommandDispatch`, `CommandFixtureResult`, `MqttOutbox`, `ProcessedGatewayEvent`, `GatewayEventWatermark`, `MonitoringIncident`, `EnergyUsage`
- 자동 제어: `GatewayAutomationConfiguration`, `LightingSchedule`, `LightingScheduleFixture`, `VehicleEventRule`, `VehicleEventSource`, `VehicleEventTarget`, `ManualOverride`, `ManualOverrideFixture`, `AutomationExecution`, `AutomationExecutionFixtureResult`
- 감사/삭제 정리: `GatewayClaimAudit`, `AuditLog`, `SiteDeletionCleanup`
- 조명 검색/등록: `ProvisioningSession`, `ProvisioningScanOutbox`, `ProvisioningDeviceOutbox`, `DiscoveredMeshNode`
- 에너지 보고서: `EnergyReportJob` — 요청·데이터·문서 스냅샷과 비동기 생성/보관 상태, `EnergyReportObjectCleanup` — cascade/메타데이터 삭제 후에도 남는 비공개 파일 회수 원장

### EnergyReportJob (P2 보고서)

Migration: `20260912_statistics_p2_reports`, 대상명 확장 `20260916_report_operations_metadata`. 상태 enum은 `queued`, `processing`, `completed`, `failed`, `expired`, 형식 enum은 `xlsx`, `pdf`다.

| 필드 | 타입 | 의미 |
| --- | --- | --- |
| `id`, `siteId` | `String` | 보고서 ID, 현장 FK |
| `requestedByUserId` | `String?` | 요청 사용자 FK, 사용자 삭제 시 SetNull |
| `requestedByActorId`, `requestedByLoginIdSnapshot` | `String` | 사용자 삭제 후에도 유지하는 요청자 식별자와 로그인 ID |
| `requestHash`, `format` | `String`, `EnergyReportFormat` | 정규화 요청 SHA-256, 파일 형식 |
| `status`, `progressPercent`, `attemptCount` | enum, `Int`, `Int` | 상태, 0–100 진행률, 0–3 시도 횟수 |
| `leaseOwner`, `leaseExpiresAt` | `String?`, `DateTime?` | worker 소유권과 만료 시각, 쌍으로 존재 |
| `requestSnapshot` | `Json` | 생성 시 확정하는 불변 요청 |
| `targetLabelSnapshot` | `String?` | INSERT transaction에서 확인한 대상명. legacy null을 포함해 이후 변경·채움·삭제 금지 |
| `dataSnapshot`, `documentSnapshot` | `Json?` | 한 번만 채우는 집계 데이터와 순서가 확정된 공통 문서 |
| `contentFingerprint` | `String?` | 문서 fingerprint 필드를 제외한 canonical JSON의 SHA-256 |
| `objectKey`, `contentType`, `sizeBytes`, `contentSha256` | nullable String/Int | private object key, MIME type, 바이트 수, 파일 SHA-256 |
| `failureCode` | `String?` | worker의 고정 실패 코드. 공개 응답에서 허용 목록으로 다시 정제 |
| `createdAt`, `updatedAt`, `startedAt`, `completedAt` | `DateTime`, 일부 nullable | 작업 수명주기 |
| `expiresAt`, `objectDeletedAt` | `DateTime?` | 보관 만료와 실제 object 삭제 확인 시각 |

`(siteId, requestedByActorId, requestHash) WHERE status IN ('queued', 'processing')` partial unique index는 같은 요청자의 실행 중 요청만 중복 방지한다. 완료·실패 후 재요청은 가능하다. 별도 상태/lease/생성 시각 index와 상태/만료/삭제 시각 index는 durable worker의 claim·회수·보관 정리에 사용한다. 최대 시도는 worker 상수 3과 DB check로 제한하며 변경 가능한 행별 설정은 두지 않는다.

보고서 이력 목록은 `siteId`를 선두 조건으로 사용해 현장 tenant 범위 안에서만 조회하며, `(createdAt DESC, id DESC)` 순서로 keyset 페이지를 나눈다. 같은 `createdAt`을 가진 작업도 `id`를 tie-break로 사용해 순서를 안정적으로 유지한다. 이를 지원하는 additive index는 `(siteId, createdAt, id)`이며, 기존 index를 대체하거나 삭제하지 않는다. 페이지 조회의 cursor predicate(`createdAt`이 cursor보다 이전이거나, 시각이 같고 `id`가 cursor보다 작은 조건)는 해당 페이지에만 적용하고, `totalCount`의 filtered count는 `siteId`와 상태·형식·대상·요청일 필터만 사용해 cursor predicate를 제외한다.

상태별 진행률·시각·lease·완료 object 필수 값은 SQL CHECK로 보호한다. 완료 문서는 데이터 스냅샷과 일치하는 fingerprint 필드를 함께 가져야 한다. SQL trigger는 요청·요청자 identity의 변경을 막고, 데이터·문서·fingerprint의 최초 저장 이후 변경/삭제를 막는다. 사용자 FK의 SetNull은 허용하며 요청자 스냅샷은 유지한다. 현장 삭제 시 행은 Cascade 삭제되므로 실제 현장 삭제 workflow에서 object 정리 대상을 삭제 전에 확보해야 한다.

`20260916_report_operations_metadata`는 명시적 `BEGIN/COMMIT`, 10초 `lock_timeout`, 보고서 테이블 배타 잠금 안에서 nullable 대상명 열·빈 문자열 거부 CHECK와 기존 snapshot guard 함수를 함께 갱신한다. 기존 migration checksum은 변경하지 않는다. 대상명은 생성 transaction의 Site 삭제 barrier 확인 뒤 같은 현장에 속한 identity의 최신 저장 이름(층은 현재 이름 우선, 삭제된 층은 이력 이름)을 읽고 문자 지원을 검사해 INSERT한다. 사전 조회 이름을 재사용하지 않으며 과거 이름을 알 수 없는 legacy 행은 null로 둔다. worker가 나중에 실행되거나 운영 객체가 삭제되어도 목록과 새 공통 문서의 `대상` 메타데이터는 저장한 이름을 유지한다. 기존 문서/fingerprint는 다시 쓰지 않는다.

공개 작업은 `target: { scope, identityId, label }`, `requestedAt`과 `failure: { code, message, action } | null`을 제공하며 기존 `createdAt`·`failureCode`도 유지한다. `requestedAt`은 DB에서 읽은 `createdAt`과 정확히 같다. 생성 시각은 JS Date로 명시해 PostgreSQL session timezone의 naive timestamp 기본값에 의존하지 않는다. legacy 대상명은 `현장/조명/층/그룹: identityId`로 표시하고 현재 이름을 조회하지 않는다. 공개 failure code는 `generation_failed`, `storage_unavailable`, `rendering_failed`, `snapshot_invalid`, `attempts_exhausted`만 허용한다. 알 수 없는 내부 code는 기존 필드도 `REPORT_GENERATION_FAILED`로 정제하며 원시 DB/S3/render 오류나 객체 경로를 반환하지 않는다. 공유 parser는 기존 서버에서 누락된 신규 필드를 안전한 기본값으로 채우고, 명시된 대상·요청 시각·실패 상태 불일치는 거부한다. 마이그레이션과 이름 보존·실패 분류는 disposable PostgreSQL에서 검증하며 사용자/운영 DB에는 적용하지 않았다.

보고서 스냅샷은 한 `RepeatableRead` transaction에서 현장 timezone, 이력 차원과 완료된 현지 날짜의 persisted daily/hourly 집계를 읽는다. legacy DB 열 `estimatedKwh`는 보고서 데이터에서 `energyKwh`, 일별 `estimatedCost`는 `cost`, `knownSeconds`는 밝기 가중 계산 및 값 존재 판정용 `durationSeconds`로 매핑한다. 저장된 실제 전력량·비용은 불변의 과거 사실이며 `cost`는 저장된 Decimal 문자열 또는 값 없음이다. 현재 state cursor·미완료 날짜는 읽지 않는다. 현재 단가는 명시적으로 `captured_current_configuration` 원천을 표시한 현재 설정 기준선·절감 비교 KPI에만 capture하며, 이 값으로 저장된 실제 비용을 소급 변경하거나 다시 계산하지 않는다. 요약·일별 표·순위에 비용을 포함하고 직전 동일 일수의 전력량/비용 차이 및 이전 값이 0이 아닐 때만 변화율을 산출한다. 적용 단가/원천 산출식의 역사적 증거를 보관한 FK나 snapshot은 없으므로 문서에는 해당 항목을 `데이터 없음`으로 설명한다.

데이터 snapshot의 identity/dimension/group `from`/`to`는 날짜로 축약하지 않은 전체 ISO UTC 시각이며 시간별 행은 `bucketStartUtc`를 보존한다. 현장 일별 총계는 identity 추적 시작/종료와 무관하게 저장된 사실을 보존한다. 순위와 층·그룹 일별 값은 현지 하루 전체의 이력이 확정된 경우만 포함한다. 시간별 소속은 UTC 한 시간 전체의 이력으로 먼저 판단한 뒤 `localDate`/`localHour`의 요일·시간으로 fold한다. 경계를 걸친 집계를 비례 배분하지 않고 DST 반복 버킷은 같은 셀에 합친다. 일별/시간별 집계 차이를 문서 생성 중 보정하지 않는다.

기존 저장 문서와 fingerprint는 불변으로 보존한다. XLSX/PDF는 같은 순서·값·표시 문자열·계산 설명·fingerprint를 렌더링한다. `GET report-targets`는 기존 analytics identity와 최신 저장 이름/과거 층 이름을 조회해 운영 Fixture/FixtureGroup ID와 혼동하지 않는 tenant-scoped 선택 계약을 제공한다. 반환 label의 글꼴 왕복이 불가능한 항목만 제외하며 무관한 과거 이름 때문에 endpoint 전체가 실패하지 않는다. 접수 전 Site 잠금 밖의 read-only `RepeatableRead` 사전 조회가 실제 범위·날짜·사실로 최종 문서를 만들어 문자/shaping 검사를 수행하고 폐기한다. 이를 `EnergyReportJob`에 저장하지 않으며 첫 worker 시도의 별도 한 transaction에서만 불변 snapshot을 저장한다. worker는 이 최종 문서 문자 검사를 다시 수행하고 이후 재시도는 저장 문서를 유지한다.

### EnergyReportObjectCleanup (보고서 파일 회수 원장)

Migration: `20260913_report_object_cleanup_ledger`. Site/보고서 FK를 두지 않아 현장 cascade와 생성 후 90일 보고서 메타데이터 삭제 뒤에도 유지한다. 요청자·이름·집계/문서 스냅샷은 저장하지 않고, 고정된 ID·형식의 허용 시도 1·2·3 키만 영구 보존한다. 아직 0/1회 시도한 보고서도 3개를 예약해 rolling upgrade 중 구버전 claim의 늦은 업로드를 회수한다. 프로세스가 임의의 시간 동안 정지했다가 PUT을 수행할 수 있으므로 유한한 유예 시간만으로 원장을 제거하지 않는다.

| 필드 | 타입 | 의미 |
| --- | --- | --- |
| `reportId`, `siteId` | `String` | 보고서 PK, 현장 식별자. 둘 다 FK 없음 |
| `objectKeys` | `Json` | 고정된 site/report ID·형식의 attempt-1/2/3 키 배열, SQL CHECK로 길이 1–3 제한 |
| `leaseOwner`, `leaseExpiresAt` | nullable String/DateTime | 정리 회차별 UUID와 DB UTC 기준 30초 임대, 둘 다 존재하거나 둘 다 null |
| `nextAttemptAt`, `lastCleanedAt` | DateTime, DateTime? | 다음 회수 가능 시각, 최근 성공 회수 시각 |
| `lastError` | `String?` | 정제된 정리 실패 코드 |
| `deleteAttemptCount`, `deleteRetryCount`, `deleteFailureCount` | `Int`, 기본 0 | 유효 임대를 가진 소유자가 결과를 확정한 정리 회차, 직전 실패 뒤 재시도 회차, 실패 회차의 누적값 |
| `lastAttemptAt` | `DateTime?` | 가장 최근에 결과를 확정한 정리 회차를 수행한 sweep의 기준 시각 |
| `lastObservedObjectCount`, `lastObservedBytes` | `Int`, `BigInt`, 기본 0 | 최근 확정 회차에서 HEAD로 확인한 존재 객체 수·크기 합. 중간 실패 시 측정한 부분까지만 기록 |
| `deletedObjectCount`, `deletedBytes` | `Int`, `BigInt`, 기본 0 | HEAD에서 존재를 확인하고 DELETE 성공 응답을 받은 객체 수·관측 크기 누적값 |
| `latePutObjectCount`, `latePutBytes` | `Int`, `BigInt`, 기본 0 | 이전 전체 성공 회차 뒤 다시 발견하여 DELETE 성공 응답을 받은 객체 수·관측 크기 누적값 |
| `createdAt`, `updatedAt` | `DateTime` | 원장 수명주기 |

`(nextAttemptAt, leaseExpiresAt)`와 `siteId` 인덱스를 둔다. 60초마다 최대 50개 원장을 `SKIP LOCKED`로 claim하고, S3 DELETE는 DB 잠금/transaction 밖에서 실행한다. 짧은 후속 transaction에서 보고서→원장 순서로 잠근 뒤 소유자·임대 만료를 다시 검사해 메타데이터 만료/삭제 및 다음 회수 시각을 확정한다. 실패·임대 상실 시 키와 보고서 메타데이터를 유지한다. 성공 후에도 다음 회수를 예약하므로 이미 완료된 현장 정리 뒤의 늦은 업로드도 회수 대상이다. Migration은 기존 `SiteDeletionCleanup`의 보고서 키(완료 원장 포함)를 엄격한 UUID 경로·xlsx/pdf 형식으로 검증하고, 기존 attempt-1만 있어도 같은 형식의 세 키를 이 테이블에 보존한다.

`20260917_report_cleanup_metrics`는 기존 migration을 수정하지 않고 transaction·10초 lock timeout 아래 위 카운터와 비음수/상호 범위 CHECK를 추가한다. 과거 삭제 횟수·바이트는 복원할 수 없어 0에서 시작하며 기존 `lastCleanedAt`은 유지한다. `nextAttemptAt`·`createdAt`의 DB 기본값은 명시적 UTC다. `prune(now)`는 최초 원장에도 같은 `now`를 전달하고 SQL의 만료·재시도 비교에서 Date 파라미터를 naive UTC로 변환한다. 임대 만료 판정은 실제 DB UTC 시각을 사용한다.

각 키의 HEAD와 DELETE는 각각 4초 이내로 제한한다. HEAD 404는 정상 미존재이며 해당 키의 DELETE도 실행해 HEAD 직후의 PUT을 회수한다. 존재 객체는 유효한 0 이상 정수 크기를 먼저 측정하고 DELETE한다. HEAD/DELETE 실패는 원시 오류 없이 `REPORT_OBJECT_CLEANUP_FAILED`만 저장한다. lease 상실 회차는 모든 카운터·최근 관측값·성공 시각을 저장하지 않는다. 실패한 DELETE의 late PUT 카운터는 이후 성공 시 증가하므로 같은 객체의 반복 실패가 수치를 부풀리지 않는다. 부분 성공 DELETE는 전체 회차가 실패해도 유효 임대 아래 누적한다.

카운터는 이 정리 서비스가 확인한 활동량이다. 현장 삭제 서비스의 직접 DELETE, 응답 유실, lease 상실, HEAD와 DELETE 사이 객체 교체 때문에 실제 전체 삭제량·현재 버킷 용량·과금 수치와 같지 않다. 최근 관측값의 합계도 서로 다른 원장의 마지막 회차를 합한 값이다. 원장과 카운터는 메타데이터/현장 삭제 후에도 보존한다.

매 sweep은 `report_object_cleanup_sweep` structured log와 반환값에 처리·purge·실패·재시도·임대 상실 회차 및 `metrics`를 제공한다. `ledgerCount`는 전체 원장 수, `backlogCount`는 미성공/직전 실패 원장과 아직 원장에 등록되지 않은 만료·실패 보고서의 합, `uninventoriedCount`는 그 미등록 보고서 수다. `dueCount`·`oldestDueAgeMs`는 임대 여부와 무관하게 예정 시각이 지난 원장 수·가장 오래 지난 시간이며 대상이 없으면 0이다. `retryPendingCount`는 직전 실패 원장 수다. `deleteRetryCount`는 실패 뒤 실제 재시도만 누적하며 정상 반복 확인은 포함하지 않는다. 나머지 동명 카운터는 원장 전체 합계이고 정밀도 손실·JSON BigInt 오류를 막기 위해 10진 문자열로 출력한다. 전체 원장 합계 조회 비용은 원장 수에 비례하며 외부 metrics 제품·자동 원장 삭제는 추가하지 않았다.

`20260914_report_delete_tombstone_guard`는 `EnergyReportJob`의 `BEFORE DELETE` 행 트리거 `EnergyReportJob_preserve_objects_before_delete`와 함수 `preserve_energy_report_object_tombstone()`을 추가한다. migration은 DELETE와 충돌하는 테이블 잠금을 얻고 트리거 설치까지 하나의 transaction으로 커밋한다. 이 커밋 이후에는 runtime helper를 모르는 구버전 인스턴스의 직접 DELETE·90일 purge·Site FK cascade도 같은 삭제 transaction에서 세 키를 남긴다. reportId/siteId는 엄격한 UUID, 형식은 불변 xlsx/pdf enum에서 검증하고, 잘못된 이력 식별자는 `23514`로 삭제를 중단한다. `objectKey`나 호출자 경로를 삭제 권한으로 사용하지 않는다. 대상 원장 schema는 `TG_TABLE_SCHEMA`로 고정하고 신규 행의 시각은 DB 세션 timezone과 무관하게 UTC로 기록한다.

트리거의 upsert는 기존 세 키를 확장/확인하되 현재 `leaseOwner`, `leaseExpiresAt`, `nextAttemptAt`을 유지한다. 따라서 새 reaper의 fenced finalize가 메타데이터를 삭제해도 스스로 임대를 잃지 않으며 중복 원장을 만들지 않는다. DELETE rollback 시 원장 쓰기도 rollback한다. 트리거는 DB 키 원장만 쓰고 S3 네트워크 호출을 하지 않는다. 보호 범위는 트리거 migration 커밋 이후 정상 DELETE/cascade이며, 관리자가 트리거를 끄거나 TRUNCATE로 우회하는 작업은 이 보장을 깨므로 운영 정리 경로로 사용하지 않는다.

### 보고서 migration 사전 검사와 실패 복구

20260912~14 적용은 구 API, report worker와 Site 삭제/메타데이터 purge를 실행하는 모든 프로세스를 중지한 maintenance barrier 안에서 수행한다. 이미 시작한 transaction도 종료됐는지 확인한다. 20260914의 테이블 잠금은 설치 중의 DELETE/쓰기와 충돌하지만 20260912~13 적용 구간까지 보호하지 않으므로 프로세스 중지가 필요하다. 기존 migration SQL과 checksum은 수정하지 않는다.

`DATABASE_URL`을 대상 DB로 명시적으로 설정한 배포 세션에서 다음 순서로 실행한다. 아래 명령은 운영 절차이며 이번 구현에서 사용자/운영 DB에는 실행하지 않았다.

```bash
pnpm --filter @led-control/api reports:migration-preflight --phase=pre
pnpm --filter @led-control/api exec prisma migrate deploy
pnpm --filter @led-control/api reports:migration-preflight --phase=post
```

preflight는 `.env`를 자동으로 읽지 않고 PostgreSQL의 `READ ONLY`, `RepeatableRead` transaction으로 검사한다. 검사별 statement timeout 5초, lock timeout 1초를 사용한다. `{ "ok": true, ... }`와 종료 코드 0만 통과로 인정하며, 설정/접속/검사 오류도 종료 코드 1로 차단한다. 출력은 진단 code만 제공하고 URL, 자격 증명, 개인 객체 경로와 원문 DB 오류를 노출하지 않는다. `pre`는 아직 적용하지 않은 보고서 migration을 허용하고, `post`는 세 migration이 모두 완료돼야 통과한다.

- `unfinished_migration`: `finished_at`과 `rolled_back_at`이 모두 null인 migration. `logs`가 null이어도 실패/중단 상태다.
- `legacy_object_keys_not_array`: 기존 `SiteDeletionCleanup.objectKeys`의 scalar/object/JSON null. 완료 원장도 포함한다.
- `legacy_report_key_count_exceeded`, `legacy_report_identity_conflict`: 기존 엄격한 UUID 경로를 3개 attempt로 확장한 결과가 3개를 넘거나 같은 report ID가 여러 site에 걸친다. xlsx/pdf가 섞이면 6개가 되어 기존 CHECK를 위반한다.
- `unexpected_report_catalog`, `report_catalog_missing`, `migration_history_gap`: 이력과 테이블/enum/함수 상태가 불일치한다. 부분 적용 또는 수동 복구 흔적을 자동으로 덮어쓰지 않는다.
- `report_constraint_missing`, `active_request_index_missing`, `snapshot_trigger_missing_or_disabled`, `delete_trigger_missing_or_disabled`: 검증된 CHECK, 활성 요청 unique index, 활성화된 올바른 함수·이벤트의 보호 트리거가 누락됐다.
- `legacy_report_backfill_missing`: 기존 cleanup의 확장된 키가 영구 원장에 없거나 site/키가 일치하지 않는다.

preflight는 데이터/카탈로그 검사이며 백업 검증이나 maintenance barrier를 대신하지 않는다. 배포 전에 복구 가능한 백업/PITR 지점을 확보한다. 배포 connection의 PostgreSQL `options`에 `-c lock_timeout=5s -c statement_timeout=120s`를 설정해 잠금 대기와 전체 statement 시간을 제한한다. Prisma URL의 query parameter 예시는 `options=-c%20lock_timeout%3D5s%20-c%20statement_timeout%3D120s`이며 기존 query가 있으면 `&`로 추가한다. 20260914 원본에는 timeout이 없으므로 세션 설정을 생략하지 않는다. 실제 배포 시간 한도는 데이터 규모에 맞춰 검토한다. 적용 후 post 검사와 새 버전의 추가 schema/backfill 검증을 통과한 뒤에만 API/worker를 시작한다.

신규 `20260915_statistics_operations_retention`, `20260916_report_operations_metadata`, `20260917_report_cleanup_metrics`도 같은 barrier에서 순서대로 적용한다. 이 세 migration은 각각 명시적 transaction과 10초 lock timeout을 가지며 기존 파일을 수정하지 않는다. report pre/postflight의 보호 대상은 20260912~14이므로 그것만 통과했다고 신규 watermark·terminal identity backfill, `targetLabelSnapshot` 불변성, cleanup 카운터 CHECK·UTC 기본값까지 검증됐다고 판단하지 않는다. 새 API/worker 시작 전 이 신규 구조를 별도로 확인하고, 시작 후 `data_retention_sweep`와 `report_object_cleanup_sweep`를 관찰한다.

실패 시에는 다음 절차를 따른다.

1. barrier를 유지하고 자동 deploy 재시도를 중단한다. `_prisma_migrations`의 migration 이름, checksum, 시작/완료/rollback 시각, logs, CLI 출력, 해당 PostgreSQL 서버 로그와 preflight 진단을 보존한다. 로그는 제한된 운영 채널에서 취급한다.
2. 실제 카탈로그와 원장 데이터로 rollback 여부를 판정한다. 20260912~13에는 명시적 transaction이 없으므로 다른 runner에서도 파일 전체가 원자적일 것이라고 가정하지 않는다. 부분 적용 DB에 원본 SQL을 다시 실행하면 이미 존재하는 객체 또는 유실된 backfill 때문에 추가 실패가 발생할 수 있다.
3. 기본 복구는 검증한 백업/PITR 지점으로 복원한 뒤 원본 migration을 다시 적용하는 것이다. 부분 적용을 보존해야 하는 경우 별도 검토한 순방향 복구 절차로 카탈로그·데이터를 먼저 일치시킨다. 기존 SQL/checksum을 수정하거나 `_prisma_migrations` 행을 임의 삭제하지 않는다.
4. 완전 rollback과 안전한 재실행을 확인한 담당자만 실패 migration의 `prisma migrate resolve --rolled-back <migration-name>` 사용 여부를 결정한다. `resolve --applied`로 제약/트리거/backfill 검증을 건너뛰지 않는다. 도구는 이러한 복구 명령을 자동 실행하지 않는다.
5. pre 검사에서 미완료 이력이 정리됐는지 확인한 뒤 단일 deploy와 post 검사를 다시 수행한다. legacy scalar를 빈 배열로 바꾸거나 형식 하나를 임의로 버리는 것은 객체 삭제 권한을 유실할 수 있으므로 원장 데이터의 별도 복구 검토가 필요하다.

자동 회귀는 `REPORT_MIGRATION_SAFETY_TEST=1 pnpm --filter @led-control/api test -- energy-report-migration-safety.integration.spec.ts --runInBand`로 실행한다. PATH의 `initdb`, `pg_ctl`, `psql`을 사용해 임시 디렉터리에 새 PostgreSQL 클러스터와 DB를 만들며 기존 `DATABASE_URL`은 사용하지 않는다. 종료 시 전용 클러스터를 정지하고 임시 파일을 제거한다. 환경변수 없이 실행하면 해당 통합 suite는 skip되며 실제 DB 검증으로 계산하지 않는다.

Prisma 6.19.3/PostgreSQL 16.14의 실제 `migrate deploy`에서 clean replay, 20260911 이후 staged upgrade와 기존 완료 cleanup 키 backfill을 검증했다. 테스트 복사본의 statement 실패는 20260912~13에서도 제출된 SQL batch를 rollback했고, 20260914의 명시적 transaction은 트리거·보고서 DELETE·tombstone 쓰기를 모두 rollback했다. 20260914에서는 Prisma가 중단된 transaction 안에서 오류 logs UPDATE도 시도해 CLI가 `current transaction is aborted`로 끝나고 이력의 `logs`는 null로 남았다. 원래 statement/lock timeout 원인은 PostgreSQL 로그에 남으며 미완료 migration의 단순 재시도는 `P3009`로 차단됐다. 원본과 구분되는 테스트 전용 중간 COMMIT 주입은 부분 카탈로그와 미실행 backfill을 남기며 preflight와 재시도가 이를 거부하는지 검증한다. 별도 두 connection 검증은 테이블 lock timeout, 설치 중 writer 대기와 commit 직후 DELETE의 세 키 보존을 확인한다. 이 결과는 일회성 DB의 소프트웨어 증거이며 운영 DB 복원 실행이나 모든 Prisma/PostgreSQL 버전의 원자성 보장이 아니다.

간단한 관계 흐름은 다음과 같다.

```text
Organization
  ├─ User ─ Session
  ├─ Invitation
  └─ Site ─ admin -> User
      ├─ Floor
      │   ├─ FloorPlan
      │   ├─ FloorAsset ─ FloorImportJob ─ FloorImportCandidate
      │   ├─ FloorLightSlot ─ 선택적 할당 -> Fixture
      │   ├─ FloorMapObject
      │   └─ Fixture ─ MeshNode
      │       ├─ GroupFixture ─ FixtureGroup
      │       └─ EnergyUsage
      ├─ Gateway ─ MeshNode
      │   ├─ GatewayInventory
      │   ├─ GatewayCertificate
      │   └─ MeshControlGroup ─ MeshControlGroupMember
      │                      ├─ MeshControlGroupExpectedOperation
      │                      └─ MeshControlGroupAppliedMember
      │   └─ CommandDispatch ─ CommandFixtureResult
      │   ├─ GatewayAutomationConfiguration
      │   ├─ LightingSchedule ─ LightingScheduleFixture
      │   ├─ VehicleEventRule ─ VehicleEventSource / VehicleEventTarget
      │   └─ AutomationExecution ─ AutomationExecutionFixtureResult
      ├─ Command ─ CommandDispatch ─ MqttOutbox
      │         └─ ManualOverride ─ ManualOverrideFixture
      └─ ProvisioningSession ─ ProvisioningScanOutbox
                             ├─ ProvisioningDeviceOutbox
                             └─ DiscoveredMeshNode ─ ProvisioningDeviceOutbox
SiteDeletionCleanup (삭제된 Site ID와 외부 정리 대상을 독립 보존)
```

## 2. Enum

### FixtureStatus

조명 상태.

| 값 | 의미 |
| --- | --- |
| `online` | 정상 수신/운영 중 |
| `offline` | 최근 상태 수신 없음 |
| `fault` | 장애 상태 |

### CommandStatus

조명 제어 명령 상태.

| 값 | 의미 |
| --- | --- |
| `pending` | 명령 생성 후 ACK 대기 |
| `acknowledged` | 게이트웨이/장비에서 명령 수신 확인 |
| `failed` | 명령 실패 |

### CommandDispatchStatus / CommandFixtureResultStatus

`CommandOutcome`은 `pending`, `applied`, `not_applied`, `partially_applied`, `unknown`으로 실제 적용 결과를 구분한다. 기존 `CommandStatus`와 별도이며 과거 행은 `outcome = NULL`로 보존한다. `unknown`은 MQTT 발행 시도 뒤 PUBACK·장비 응답 유실 등으로 실제 적용 여부를 확정할 수 없는 상태다.

`CommandDispatchKind`는 기존 Set인 `dimming`(기본값)과 관측용 Get인 `status_check`를 구분한다.

`CommandDispatchStatus`는 gateway별 전송 상태를 `pending`, `published`, `accepted`, `completed`, `failed`, `timed_out`으로 구분한다. `CommandFixtureResultStatus`는 실제 조명별 결과를 `pending`, `succeeded`, `failed`, `timed_out`으로 구분한다. Gateway acceptance와 실제 장비 status ACK를 같은 의미로 취급하지 않는다.

### GatewayEventIngestionStatus

`ProcessedGatewayEvent`의 수신 결과다. `accepted`는 정상·stale/reverse/checkpoint를 포함해 API가 영속 처리한 event이고, `rejected_future_timestamp`는 scope 확인 뒤 `occurredAt`이 서버의 `receivedAt`보다 기본 5분을 넘게 미래여서 terminal로 거부된 event다. 이 terminal 결과도 동일 identity·payload 재전달에는 재사용되며, 다른 payload의 재전달은 fail-closed 한다.

### 자동 제어 enum

| Enum | 값 | 용도 |
| --- | --- | --- |
| `AutomationSyncStatus` | `PENDING`, `APPLIED`, `REJECTED` | Gateway full snapshot 적용 상태 |
| `AutomationRuleStatus` | `enabled`, `disabled` | 스케줄·차량 이벤트 규칙 활성 상태 |
| `ScheduleRecurrenceKind` | `once`, `daily`, `weekly`, `monthly`, `yearly` | 현장 timezone 기준 반복 방식 |
| `AutomationExecutionKind` | `schedule_started`, `schedule_ended`, `vehicle_detected`, `event_started`, `event_extended`, `event_ended`, `action_result`, `telemetry_gap` | Gateway가 전달한 lifecycle 원장 종류 |
| `VehicleSensorCapabilityStatus` | `unknown`, `supported`, `unsupported` | MeshNode의 검증된 차량 센서 source capability |

### MeshControlTargetType / MeshControlGroupStatus

`MeshControlTargetType`은 gateway별 제어 group이 가리키는 대상을 `floor`, `fixture_group`으로 구분한다. `MeshControlGroupStatus`는 subscription 적용 상태를 `configuring`, `ready`, `failed`로 관리하고, 삭제 전 정리 단계와 완료 상태를 `retiring`, `retired`로 구분한다.

### FixtureGroupLifecycleStatus

조명 그룹의 업무 수명주기다. 새 그룹은 `active`로 생성하며, migration은 기존 그룹이 같은 site/floor/gateway에 속하고 fixture별 활성/정리중 그룹 수가 15개 이하일 때만 `active`로 backfill한다. 그 외 기존 그룹은 `invalid`로 격리한다. `retiring`은 gateway subscription 정리 중, `retired`는 더 이상 제어하지 않는 완료 상태다.

### ProvisioningScanStatus

검색 시도의 상태다. `pending`은 아직 시작하지 않음, `scanning`은 gateway가 수행 중, `completed`는 정상 종료(발견 0건 포함), `failed`는 gateway 또는 전송 실패를 뜻한다. scan event는 gateway-scoped v2 envelope(`eventId`, `sequence`, `occurredAt`)로만 수신한다.

### UserRole

사용자 권한.

| 값 | 의미 |
| --- | --- |
| `operator` | 서비스 운영사 운영자 |
| `admin` | 고객사 관리자 |
| `viewer` | 조회 사용자 |

### OrganizationType

조직 유형을 서비스 운영사와 고객사로 구분한다.

| 값 | 의미 |
| --- | --- |
| `service_provider` | 고객 현장을 설치·운영하는 서비스 운영사 |
| `customer` | 실제 현장과 관리자를 가진 고객사 |

### UserStatus

사용자 계정 상태.

| 값 | 의미 |
| --- | --- |
| `active` | 활성 계정 |
| `disabled` | 비활성 계정 |

### SiteAccessLevel

현장 일반 사용자의 권한 범위다.

| 값 | 의미 |
| --- | --- |
| `read` | 현장 상태 조회만 허용 |
| `control` | 조회와 수동 조명 제어 허용 |

### ProvisioningSessionStatus

조명 검색/등록 세션 상태.

| 값 | 의미 |
| --- | --- |
| `active` | 진행 중 |
| `completed` | 완료 |
| `failed` | 실패 |
| `cancelled` | 취소 |

### DiscoveredNodeStatus

검색된 미등록 노드 상태.

| 값 | 의미 |
| --- | --- |
| `discovered` | 검색됨 |
| `identifying` | 점멸 확인 중 |
| `provisioning` | 등록 진행 중 |
| `provisioned` | 등록 완료 |
| `failed` | 등록 실패 |
| `reconcile_required` | 물리 provisioning 적용 여부를 먼저 확인해야 하는 상태 |

### FloorPlanSourceType

층별 도면 에디터에서 도면 배경 원본의 종류를 구분하기 위한 enum이다.

| 값 | 의미 |
| --- | --- |
| `none` | 배경 없이 격자 캔버스만 사용 |
| `image` | JPG 또는 PNG 이미지 원본 사용 |
| `pdf` | PDF 원본 자산 연결. 격리 렌더 worker가 만든 ready 이미지가 있을 때만 배경 표시 |
| `cad` | object storage의 native CAD scene을 현재 층 도면으로 사용 |

### FloorAssetKind

| 값 | 의미 |
| --- | --- |
| `original` | 사용자가 업로드한 원본 이미지/PDF/DWG/DXF |
| `rendered` | PDF/CAD 호환 미리보기 렌더 결과 |
| `cad_manifest` | native CAD scene manifest |
| `cad_tile` | 512 logical unit 단위의 압축 binary scene tile |
| `cad_region_preview` | import region 선택용 미리보기 |

### CAD import enum

| Enum | 값 | 용도 |
| --- | --- | --- |
| `FloorImportSourceFormat` | `dwg`, `dxf` | 자동 맵 구성에서 허용하는 CAD 원본 형식. PDF는 포함하지 않음 |
| `FloorImportJobStatus` | `queued`, `processing`, `region_selection_required`, `review_required`, `applying`, `completed`, `failed`, `cancelled` | 비동기 변환, region 선택, 관리자 검토와 적용까지의 영속 작업 상태 |
| `FloorImportDetectionMethod` | `rule_based`, `ai_assisted` | 조명 위치 후보를 만든 검출 경계. 초기 구현은 `rule_based`이며 AI provider는 비활성 |
| `FloorImportCandidateReviewStatus` | `pending`, `accepted`, `rejected` | 후보별 관리자 검토 상태 |

### CertificatePurpose

게이트웨이 인증서 사용 목적을 DB enum으로 제한한다.

| 값 | 의미 |
| --- | --- |
| `device` | 제조 enrollment와 API bootstrap용 장치 인증서 |
| `mqtt` | claim 완료 후 broker 접속용 MQTT client 인증서 |

### GatewayCertificateStatus

인증서 수명주기 상태를 DB enum으로 제한한다.

| 값 | 의미 |
| --- | --- |
| `active` | 현재 사용할 수 있는 인증서 |
| `pending` | 새 device 인증서. 발급 뒤 10분 안에 새 인증서 mTLS로 activation해야 하며, 그 전까지 active pointer를 변경하지 않음 |
| `replaced` | 새 인증서로 교체된 인증서 |
| `revocation_pending` | 논리적 사용 차단을 먼저 확정했고 CA 폐기·CRL 배포를 재시도하는 인증서 |
| `revoked` | CA에서 폐기된 인증서 |
| `expired` | 유효기간이 종료된 인증서 |

## 3. 테이블 상세

### Organization

고객사 또는 운영 조직 단위다. 대부분의 데이터는 `Organization -> Site` 또는 `Organization -> User`를 통해 조직 범위로 분리된다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 조직 ID |
| `name` | `String` | 예 |  | 조직명 |
| `type` | `OrganizationType` | 예 | `customer`; `service_provider`는 PostgreSQL partial Unique로 1개만 허용 | 서비스 운영사 또는 고객사 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

관계:

- `users`: `User[]`
- `sites`: `Site[]`
- `invitations`: `Invitation[]`

테넌트 및 bootstrap 보안 계약:

- legacy migration은 기존 `Organization`의 현장 유무를 서비스 운영사 식별자로 사용하지 않는다. 기존 행은 모두 기본값 `customer`로 유지하고 legacy `owner`/`operator` 사용자와 invitation은 모두 `admin`으로 변환한다.
- `service_provider` Organization과 첫 `operator`는 배포 권한이 있는 `auth:bootstrap-operator` CLI만 생성한다. bootstrap은 PostgreSQL transaction-scoped advisory lock을 잡고 기존 service provider Organization 또는 operator가 있으면 거부한다.
- `Organization.type = service_provider`에는 PostgreSQL partial Unique index가 적용된다. 이 index는 Prisma schema에 표현되지 않으므로 `20260721120000_simplify_roles_and_floor_revisions` migration과 domain schema 계약 테스트가 기준이다.
- 이 migration 파일을 수정 전 이미 로컬 개발 DB에 적용했다면 Prisma migration checksum 충돌이 난다. 데이터 보존이 불필요한 로컬 DB만 reset을 선택할 수 있으며, 보존이 필요하면 기존 잘못 분류된 service provider/operator 행을 먼저 감사한 뒤 수동 보정 migration을 적용한다. 이 저장소는 reset이나 파괴적 DB 명령을 자동 실행하지 않는다.

### User

서비스 사용자 계정이다. 로그인 정본은 정규화된 `loginId`이며 이메일은 viewer 초대 연락처를 보존하는 선택 값이다. session과 public 인증 DTO에는 `loginId`만 포함하고 이메일은 노출하지 않는다. 비밀번호는 hash로만 저장하며 앞뒤 공백도 비밀번호 원문의 일부다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 사용자 ID |
| `organizationId` | `String` | 예 | FK -> `Organization.id` | 소속 조직 |
| `loginId` | `String` | 예 | Unique, 4~100자 소문자 영문·숫자·`.`, `_`, `-`, `@` check | 로그인 식별자. 입력은 trim/lower 정규화 후 저장하며 이메일 형식을 요구하지 않음 |
| `email` | `String?` | 아니오 | Unique | viewer invitation의 연락 이메일을 보존하는 선택 값. 로그인 조회에는 사용하지 않음 |
| `name` | `String` | 예 |  | 사용자 이름 |
| `passwordHash` | `String` | 예 |  | 비밀번호 hash |
| `role` | `UserRole` | 예 |  | 권한 |
| `status` | `UserStatus` | 예 | `active` | 계정 상태 |
| `mustChangePassword` | `Boolean` | 예 | `false` | 임시 비밀번호로 생성·초기화된 계정의 다음 로그인 비밀번호 변경 요구 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

관계:

- `organization`: `Organization`
- `administeredSite`: `Site?` (`Site.adminUserId`와 1:1)
- `commands`: `Command[]`
- `sessions`: `Session[]`
- `mfa`: `UserMfa?`
- `provisioningSessions`: `ProvisioningSession[]`
- `siteMemberships`: `SiteMembership[]`
- `floorMapRevisions`: `FloorMapRevision[]`

제약 및 migration 안전성:

- `20260827090000_operator_admin_account_flow` migration은 nullable `loginId`/`adminUserId` 추가, `loginId` backfill, 형식·정규화 충돌·operator 중복·기존 active admin/현장 모호성 사전검증, 명확한 customer active admin 연결, 최종 제약 추가를 하나의 PostgreSQL transaction에서 수행한다. 기존 `email`, `Site.address`, `Site.tariffKwhRate`의 NOT NULL은 이 단계에서 변경하지 않는다.
- 정규화 충돌 또는 active admin이 있는 customer의 active admin/현장 수가 각각 하나가 아니면 `RAISE EXCEPTION`으로 중단한다. disabled admin만 있는 customer 현장은 unassigned로 남기며, 임의 loginId 보정이나 권한 확대는 하지 않는다.
- role이 `operator`인 행은 상태와 관계없이 PostgreSQL partial unique index로 한 명만 허용한다. 이 index는 Prisma schema에 표현되지 않으며 migration이 정본이다.
- `20260827100000_login_id_contract` migration은 Task 1 expand 뒤 생성된 `loginId IS NULL AND email IS NOT NULL` 행을 다시 `lower(btrim(email))`으로 backfill한다. 기존 unique index를 같은 transaction 안에서 잠시 제거해 format·collision·NULL guard가 명시적 오류를 내게 하고, guard가 모두 통과한 뒤 `loginId NOT NULL`, `email` nullable과 unique index를 적용한다. 격리 PostgreSQL rehearsal은 fresh Task 1→Task 2, staged re-backfill, guard rollback, Task 1 trigger/index 보존을 실행한다.
- fresh deploy는 `prisma migrate deploy`가 Task 1 expand와 이 contract migration을 순서대로 모두 적용한 뒤 새 `loginId` API/Web을 시작한다. 운영 staged deploy는 계정 write freeze와 구버전 API/worker 완전 drain 후 expand·재-backfill·contract migration을 모두 완료하고 새 API/Web만 배포한다. 유지보수 중 로그인 API를 열지 않으며 email fallback이나 구·신 API 동시 운영을 허용하지 않는다. 이 저장소는 사용자 DB reset이나 파괴적 DB 명령을 자동 실행하지 않는다.
- `20260827110000_pending_site_contract` migration은 `Site.address`와 `Site.tariffKwhRate`의 NOT NULL을 제거한다. operator가 만든 설치 대기 Site는 두 값을 `NULL`로 저장하고, 설치 완료 전 energy 비용 API는 단가 부재를 `409`로 처리한다.

### Site

실제 설치 현장이다. 주차장 한 곳 또는 건물 단지를 표현한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 현장 ID |
| `organizationId` | `String` | 예 | FK -> `Organization.id` | 소속 조직 |
| `adminUserId` | `String?` | 아니오 | Unique, FK -> `User.id`, restrict delete | 이 현장을 직접 관리하는 단일 admin. admin 계정도 한 현장만 가질 수 있음 |
| `name` | `String` | 예 |  | 현장명 |
| `address` | `String?` | 아니오 |  | 주소. operator가 만든 설치 대기 현장에서는 `NULL`이고 admin 최초 설치에서 필수값으로 채운다. |
| `tariffKwhRate` | `Decimal(10,2)?` | 아니오 |  | kWh 단가. 설치 대기 현장에서는 `NULL`이며, 단가가 없으면 energy 비용 산출을 요청할 수 없다. |
| `timeZone` | `String` | 예 | `Asia/Seoul` | IANA timezone. 상태 기반 에너지 일·월 경계를 계산하는 기준 |
| `gatewayOfflineAfterSeconds` | `Int` | 예 | `90`, SQL CHECK `30..900` | 모니터링 게이트웨이 heartbeat 만료 기준(초). 장비 제어 안전성의 기존 90초 계약과 별개 |
| `fixtureStaleAfterSeconds` | `Int` | 예 | `1200`, SQL CHECK `60..3600` | 조명 presence/실제 상태 수신 freshness 기준(초). 정확히 1,200초는 fresh이고 그보다 1ms라도 지나면 stale이다. |
| `currency` | `String` | 예 | `KRW` | 현재 통계 비용 계산과 표시가 지원하는 고정 통화. 운영 설정 API도 `KRW`만 허용한다. |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

관계:

- `organization`: `Organization`
- `admin`: `User?` (`User.administeredSite`와 1:1)
- `floors`: `Floor[]`
- `gateways`: `Gateway[]`
- `groups`: `FixtureGroup[]`
- `commands`: `Command[]`
- `invitations`: `Invitation[]`
- `provisioningSessions`: `ProvisioningSession[]`
- `memberships`: `SiteMembership[]`

admin 연결 제약:

- `Site` trigger는 `adminUserId`가 null이 아니면 같은 customer Organization에 속한 `active` `admin`만 연결하도록 검증한다. viewer, operator, disabled admin 또는 다른 customer의 admin 연결은 거부한다.
- `User` trigger는 이미 연결된 admin의 `role`, `status`, `organizationId` 변경이 위 관계를 무효화하면 거부한다. 현장에서 `adminUserId`를 먼저 null로 해제한 뒤 disabled 처리하는 순서는 허용한다.
- `Organization` trigger는 연결된 site admin이 하나라도 있는 customer의 `type`을 `service_provider`로 바꾸는 변경을 거부한다. `name`처럼 관계와 무관한 변경은 허용한다.
- Site의 `adminUserId`/`organizationId`, User의 `role`/`status`/`organizationId`, Organization의 `type`에 영향을 주는 INSERT/UPDATE는 각 테이블의 `BEFORE STATEMENT` trigger에서 동일한 transaction-scoped advisory lock을 먼저 얻는다. PostgreSQL이 target row를 잠그기 전에 세 write path를 직렬화하므로 서로 다른 target table에서 시작하는 UPDATE 사이의 row-lock 순환 대기를 막는다. 이 전역 직렬화는 저빈도 계정·현장 관리 작업의 처리량보다 교착 방지를 우선한 계약이다.
- statement gate를 통과한 뒤 기존 row trigger는 stale snapshot write-skew를 막기 위해 관계 행을 `FOR UPDATE`로 잠그고 변경 후 상태를 검증한다. `Site` trigger는 대상 User와 Organization, `User` trigger는 연결 Site와 Organization, `Organization` trigger는 연결 Site와 User를 transaction 종료까지 안정적으로 유지한다.
- `adminUserId`의 unique index와 restrict foreign key는 현장당 한 admin, admin당 한 현장, 연결된 admin의 삭제 방지를 함께 보장한다.
- operator site-admin 관리 API는 customer Organization, 설치 대기 Site, active admin User와 `adminUserId` 연결을 Serializable transaction으로 생성한다. 영구 삭제는 사용자가 입력한 현장명이 현재 이름과 정확히 일치할 때만 실행한다. 최종 삭제 transaction은 FloorAsset upload intent와 동일한 Site 행을 `FOR UPDATE`로 잠근 뒤 자산 목록을 다시 읽는다. 같은 transaction에서 제조 `GatewayInventory`를 비활성화하고 외부 정리 대상을 `SiteDeletionCleanup`에 먼저 기록한 뒤, `20260903041451_operator_site_cascade_delete` migration의 ownership cascade로 층·도면·조명·그룹·게이트웨이·명령·등록·에너지·자동화 데이터를 제거한다. Gateway 삭제의 `SET NULL` FK가 inventory claim 연결을 해제한다. 커밋 뒤 worker가 Gateway 인증서를 폐기하고 presigned upload URL 최대 수명 이후 FloorAsset 객체를 삭제하며 실패 시 재시도한다. `GatewayInventory`와 `GatewayCertificate` 원장은 보존한다. 고객사에 다른 Site가 없으면 Session, Invitation, 모든 customer User와 Organization도 삭제한다. 삭제 대상 User를 `FOR UPDATE`로 잠가 login/session 생성과 직렬화한다. 삭제 감사는 함께 삭제되는 customer가 아니라 service-provider Organization에 `operator.site_deleted`로 보존한다.
- 설치 후 현장 설정 수정은 admin의 `manage` 권한을 transaction 안에서 다시 확인하고 Site 행을 `FOR UPDATE`로 잠근다. 주소와 kWh 단가는 비어 있을 수 없고 통화는 `KRW`만 허용한다. 요청의 `expectedUpdatedAt`과 잠긴 행의 버전이 다르면 `409 settings_version_conflict`로 거부한다.
- 시간대 또는 kWh 단가를 바꾸기 전에는 기존 시간대·단가로 모든 조명의 열린 에너지 구간을 변경 시각까지 정산한다. 설정 변경은 Site `FOR UPDATE`, 상태 수집은 서로 호환되는 Site `FOR KEY SHARE`를 먼저 얻은 뒤 Fixture를 잠그므로, 수집끼리는 병렬 진행하면서 대기 중인 수집이 이전 설정을 새 checkpoint에 적용하지 못한다. 다수 조명 정산의 잠금 순서는 Site, Fixture ID 오름차순, aggregate/cursor이며 500행 단위로 UTC 시각을 명시해 저장한다.

### MonitoringIncident

현장 내 단일 장애 발생부터 해결까지의 이력이다. `20260912100000_monitoring_policy_incidents`는 기존 현장에 `90/180`초 기본값을 추가하며 과거 장애를 소급 생성하지 않는다.

| 컬럼 | 타입/제약 | 설명 |
| --- | --- | --- |
| `id`, `siteId` | UUID 문자열 PK, Site FK cascade | 장애 이력 및 현장 |
| `type` | `gateway_offline`, `fixture_stale`, `fixture_fault`, `command_failed` | 장애 유형 |
| `status` | `open`, `acknowledged`, `resolved`; 기본 `open` | 발생·확인·해결 상태 |
| `targetKey` | `gateway:{id}` 또는 `fixture:{id}` | 정확한 대상 식별자 |
| `fixtureId`, `gatewayId` | nullable, 정확히 하나; 대상+현장 복합 FK cascade | `gateway_offline`만 Gateway 대상이고 나머지는 Fixture 대상 |
| `activeKey` | nullable unique | 미해결이면 `{siteId}:{type}:{targetKey}`, 해결이면 null. 동일 유형·대상의 활성 장애는 하나 |
| `openedAt`, `lastObservedAt` | 필수 DateTime | 최초 발생과 마지막 관측; 마지막 관측은 최초 발생보다 빠를 수 없음 |
| `acknowledgedAt`, `acknowledgedByUserId` | nullable 시각/사용자 FK SetNull | 확인 시각과 사용자. 확인 상태에는 시각 필수 |
| `assignedToUserId` | nullable 사용자 FK SetNull | 담당자. API는 현재 현장의 active admin/member만 허용 |
| `resolvedAt`, `resolvedByUserId` | nullable 시각/사용자 FK SetNull | 해결 시각과 사용자 |
| `resolutionKind`, `resolutionNote` | nullable enum/text | `automatic_recovery` 또는 `operator_confirmed` 및 해결 메모 |
| `createdAt`, `updatedAt` | 생성·수정 시각 | API의 `expectedUpdatedAt` 충돌 검사에 사용 |

SQL CHECK는 대상/유형/키의 일치, 활성/해결 상태별 key·시각·resolution 값, 확인 및 관측 시각 순서를 강제한다. 사용자를 삭제해도 시각과 이력은 보존하고 actor FK만 null이 된다. Site 또는 대상 삭제 시 이력도 cascade한다. `Fixture(id, siteId)` unique와 두 대상의 복합 FK가 다른 현장 대상을 DB에서 차단한다. 현장·상태·유형별 목록 및 `(resolvedAt IS NULL) DESC, openedAt DESC, id DESC` 활성 우선 커서용 인덱스를 제공한다.

`GET/PATCH /sites/:siteId/monitoring-policy`와 인시던트 목록/변경 API는 read/manage capability를 구분한다. 변경은 Site → incident 순서 잠금과 재인가, optimistic concurrency, 같은 transaction의 `AuditLog`를 사용한다. 수동 해결은 실제 대상 상태가 정상으로 복구된 경우에만 허용하며 아직 장애면 `409 INCIDENT_STILL_ACTIVE`다. 30초 freshness worker가 고정 운영 상태를 갱신한 뒤 같은 transaction에서 Site 정책과 마지막 reported 상태에 따른 활성 조건 생성·관측·자동 해결을 수행한다. Web은 SidePanel 인시던트 workflow와 정책 dialog에 연결됐다.

Task 5는 schema를 변경하지 않았다. 빈 disposable PostgreSQL에 전체 `59` migrations를 적용하고 monitoring incident/policy lifecycle `69/69`(`37`개 PostgreSQL integration + `32`개 unit)을 통과한 뒤 전용 컨테이너와 volume만 삭제했다. 사용자 DB에는 migration을 적용하지 않았고 실제 MQTT broker, Raspberry Pi/BlueZ/ESP32-H2 HIL, production notification 전송은 이 검증에 포함하지 않았다.

수동 해결은 Site가 Incident보다 먼저 잠기는 규칙에 대상 의존성을 추가해 `Site → Gateway → Fixture → Incident` 순서를 사용한다. Gateway의 `FOR NO KEY UPDATE`는 heartbeat writer를 직렬화하면서 Fixture 수집이 이후 받는 Gateway FK의 `KEY SHARE`를 허용해 역대기를 방지한다. Fixture row 잠금 후 소유 Gateway ID를 재검증하며 발견 시점과 다르면 `409 INCIDENT_TARGET_CHANGED`로 중단한다. 잠금 순서를 뒤집어 새 Gateway를 추가로 잠그지 않는다. 조건 판정은 모든 의존성 잠금 뒤 실제 snapshot을 다시 조회한다.

Reconciler도 Site → Gateway → Fixture → Incident 순서로 잠그며 현장 전체 대상은 ID 순으로 잠근다. Gateway offline은 대상당 하나이며, fixture stale은 online Gateway에 매핑되고 첫 상태 대기 중이 아닌 조명에만 발생한다. Health fault와 command failure는 각각 Health snapshot과 `reportedStatusReason`에서 판정한다. 따라서 command failure는 운영 freshness가 사유를 덮어써도 유지되며 다음 실제 수락 보고에서 사유가 바뀌어야 해소된다. 관측 지속은 SQL로 `lastObservedAt`만 전진시켜 Prisma `@updatedAt`과 사용자 확인·담당 변경 revision을 보존한다. 조건 해소 시 `activeKey=NULL`, `resolutionKind=automatic_recovery`로 전환하고 `updatedAt`을 최소 1ms 증가시킨다. 확인·담당 이력은 보존하며 새 장애는 별도 행을 만든다.

수집 commit과 incident 반영 사이에는 다음 sweep까지 지연이 있다. 각 Site 내부 고정 운영 상태 변경·reconcile은 원자적이며, 다른 Site는 별도 transaction이다. transaction 획득 대기 2초/실행 5초로 제한하고 실패 현장만 rollback한 뒤 다음 현장을 처리한다. 첫 sweep 이전 과거 장애는 backfill하지 않는다.

### SiteDeletionCleanup

현장 DB 삭제와 S3/MinIO·PKI 같은 외부 시스템 정리를 분리하는 durable 작업 원장이다. 삭제된 `Site`와 FK를 맺지 않아 Site cascade 후에도 남는다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 정리 작업 ID |
| `siteId` | `String` | 예 | Unique, FK 없음 | 삭제된 현장 ID snapshot |
| `inventoryIds` | `Json` | 예 | 문자열 배열 | 인증서를 폐기할 제조 inventory ID 목록 |
| `objectKeys` | `Json` | 예 | 문자열 배열 | 삭제할 FloorAsset 키 및 비공개 보고서의 모든 시도 키 목록. `reports/`는 별도 private bucket으로 처리 |
| `attempts` | `Int` | 예 | `0` | lease 획득 횟수 |
| `nextAttemptAt` | `DateTime` | 예 | `now()` | 다음 재시도 가능 시각 |
| `lockedAt`, `leaseExpiresAt` | `DateTime?` | 아니오 |  | 다중 API instance 중복 실행을 막는 만료형 lease |
| `completedAt` | `DateTime?` | 아니오 |  | 외부 정리 완료 시각 |
| `lastError` | `String?` | 아니오 | 정제된 코드만 저장 | 마지막 실패 원인 |

보고서가 도입된 이후 이 원장은 현장 cascade 전에도 생성된다. `lastError = REPORTS_BEFORE_SITE_DELETE`는 신규 보고서 INSERT·worker claim을 막는 준비 단계이며, background worker가 아직 확정되지 않은 도면/인증서 payload를 완료 처리하지 못하게 한다. INSERT와 claim은 Site key-share lock 뒤 새 READ COMMITTED 조회로 원장을 검사해 오래된 문장 snapshot의 경합을 차단한다. 기존 barrier 아래에 남은 processing은 임대 만료 후 worker가 종료 상태로 회수하므로 영구 409가 되지 않는다. 준비 단계의 파일 삭제 실패는 Site와 EnergyReportJob을 보존하고 운영자의 재요청으로 이어진다. 모든 보고서 파일 삭제 후 최종 삭제 transaction에서 도면/인증서 목록과 생성 시각을 갱신하고 이 상태 코드를 비운 뒤 Site를 삭제한다. 준비 단계에서 같은 키를 `EnergyReportObjectCleanup`에도 보존하므로 이 원장이 완료된 뒤에도 늦은 PUT을 반복 회수할 수 있다.

worker는 API 시작 시와 30초 주기로 만료된 작업을 최대 10개씩 조회한다. inventory별 인증서 폐기는 즉시 시작하고, object 삭제는 삭제 시점에 아직 유효할 수 있는 300초 presigned URL과 5초 안전 여유가 지난 뒤 실행한다. 두 외부 작업은 재실행 가능하며, 실패하면 최대 1시간의 지수 backoff로 다시 시도한다.

### Floor

현장 내 층 단위다. 지하주차장 기준으로 `B2`, `B1` 같은 층을 표현한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 층 ID |
| `siteId` | `String` | 예 | FK -> `Site.id` | 소속 현장 |
| `name` | `String` | 예 |  | 층 이름 |
| `level` | `Int` | 예 |  | 정렬/층 숫자 |
| `status` | `FloorStatus` | 예 | `active` | 운영 화면 노출 여부. `archived` 층은 설정 조회에서만 복구 가능 |
| `displayOrder` | `Int` | 예 | `0` | 설정과 층 선택 UI의 사용자 지정 표시 순서 |
| `nextFixtureSequence` | `Int` | 예 | `0` | 마지막으로 예약한 자동 조명 이름 순번 |
| `mapRevision` | `Int` | 예 | `0` | 층 전체 편집 상태의 optimistic concurrency revision |
| `editorLeaseFence` | `Int` | 예 | `0` | 편집 lease의 monotonic fencing counter |
| `editorLeaseTokenHash` | `String?` | 아니오 |  | 현재 활성 lease token의 SHA-256 hash |
| `editorLeaseHolderId` | `String?` | 아니오 | FK 없음 | lease 무효화·사용자 삭제와 독립적으로 보존하는 현재 보유 사용자 ID snapshot |
| `editorLeaseHolderName` | `String?` | 아니오 |  | 현재 lease 보유 사용자 이름 snapshot |
| `editorLeaseAcquiredAt` | `DateTime?` | 아니오 |  | 현재 lease 획득 시각 |
| `editorLeaseExpiresAt` | `DateTime?` | 아니오 |  | 현재 lease 만료 시각 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

관계:

- `site`: `Site`
- `floorPlan`: `FloorPlan?`
- `mapObjects`: `FloorMapObject[]`
- `fixtures`: `Fixture[]`
- `assets`: `FloorAsset[]`
- `importJobs`: `FloorImportJob[]`
- `cadScene`: `FloorCadScene?`
- `lightSlots`: `FloorLightSlot[]`
- `provisioningSessions`: `ProvisioningSession[]`
- `mapRevisions`: `FloorMapRevision[]`

운영 메모:

- `(id, siteId)` Unique는 Fixture의 투영 Site owner FK 기준이다.
- `(siteId, status, displayOrder)` index로 활성 층과 설정용 정렬 조회를 지원한다. 조명, 활성 구역 또는 진행 중인 조명 등록 세션이 남은 층은 보관할 수 없다.
- 층 수정과 보관은 admin 재인가 뒤 Floor 행을 잠그고 `expectedUpdatedAt`을 검증한다. 보관된 층은 dashboard와 일반 조명 목록에서 제외되며 새 검색·등록 세션, 재검색·일괄 등록과 terminal provisioning 완료가 조명 또는 MeshNode를 만들지 못한다.
- 보관된 층은 이미 발급된 편집 lease/token이 있어도 맵 저장·복구, 자산 업로드 시작·완료와 lease 획득·갱신·반납을 수행할 수 없다. 읽기·이력 조회와 만료 pending 자산 정리는 유지한다.
- 층 이름 변경은 같은 transaction과 시각으로 소속 조명의 현재 에너지 dimension `floorName`을 갱신한다.
- floor editor save/restore transaction은 `editorLeaseFence`, `editorLeaseTokenHash`, `editorLeaseExpiresAt`, `mapRevision`을 같은 PostgreSQL transaction 안에서 함께 검증한다.
- Redis key `floor-editor:lease:{floorId}`는 빠른 경합 감지와 best-effort heartbeat cache일 뿐 정본이 아니다. 만료, 강제 해제, successor 획득은 항상 `Floor` row의 lease authority를 먼저 갱신한다.
- 자동 조명 이름 순번은 등록 transaction에서 `Floor` 행을 `FOR UPDATE`로 잠근 뒤 범위 단위로 예약한다. 삭제된 조명의 순번이나 건너뛴 순번을 재사용하지 않는다.

### SiteMembership

`viewer`의 현장 접근 범위와 일반 사용자의 현장 권한을 명시적으로 보관한다. `userId` 단독 unique로 일반 사용자 한 명이 정확히 한 현장에만 속하게 하며, 기존 `(userId, siteId)` unique도 Prisma 복합 조회 계약을 위해 유지한다. 두 부모가 삭제되면 함께 삭제한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | membership ID |
| `userId` | `String` | 예 | Unique, FK -> `User.id`, cascade delete | 사용자 ID. 사용자당 membership 최대 1개 |
| `siteId` | `String` | 예 | FK -> `Site.id`, cascade delete, indexed | 현장 ID |
| `accessLevel` | `SiteAccessLevel` | 예 | `read` | 현장별 조회 또는 수동 제어 권한. 기존 membership은 migration에서 `read`로 backfill |
| `createdAt` | `DateTime` | 예 | `now()` | 배정 시각 |

운영 메모:

- `20260912110000_single_site_membership` migration은 기존 다중 현장 사용자가 있으면 `SITE_MEMBERSHIP_MULTI_SITE_USER`로 중단한다. 임의로 소속을 삭제하지 않으며 운영자가 데이터를 정리한 뒤 다시 적용해야 한다.
- signup은 invitation 소비와 `SiteMembership` 생성을 같은 transaction으로 처리한다. scoped `viewer` invitation은 유효한 `siteId`가 필요하고, `admin`은 Site의 `adminUserId` 관계를 사용하므로 membership을 만들지 않는다.
- `viewer` membership은 반드시 사용자의 customer Organization에 속한 site만 가리켜야 한다. SiteAccess는 권한 판정과 접근 가능한 현장 목록 계산 양쪽에서 이 invariant를 강제한다.

### FloorMapRevision

층 도면의 전체 편집 스냅숏과 복구 이력을 보관한다. `Floor` 삭제 시 함께 삭제되며, 기록한 사용자는 삭제할 수 없다.

- 2026-09-09부터 신규 snapshot은 `version: 2`와 fixture별 `placementStatus`, `positionVerifiedAt`을 포함한다. 버전 필드가 없는 V1은 조회/복구 시 `placed/null`로 정규화한다. 기존 snapshot JSON과 SHA-256을 덮어쓰지 않는다.
- 2026-09-18 공유 V2 snapshot 계약은 현재 맵의 `lightSlots` 배열을 수용한다. 이 변경 전 V2 revision에는 필드가 없을 수 있으므로 누락을 계속 읽을 수 있지만, CAD apply와 editor 저장·복구가 새로 쓰는 snapshot은 현재 슬롯 배열을 항상 명시적으로 기록한다.
- 저장/복구는 Serializable transaction에서 현장 admin 재인가, 층 lease/fence 및 revision 검증, fixture/object 갱신, 새 snapshot/hash와 audit를 함께 commit한다. 위치 확인은 서버 DB 시각으로 기록하고, 복구는 저장된 확인 시각을 복원한다.
- 좌표/속성은 bound JSONB 입력을 사용하는 1,000행 단위 SQL 갱신, object 생성은 `createMany`로 처리한다. 실제 정격 W가 바뀐 fixture만 기존 에너지 checkpoint를 닫는다. 좌표/배치/확인만 변경하거나 같은 W를 다시 보내면 에너지 정산 경계를 만들지 않는다.
- 에디터 PUT JSON 한도는 1 MiB, fixture 변경 1,000개, slot assignment 변경 2,000개, object 변경 합계 2,000개다. 다른 JSON 경로는 100 KiB를 유지한다. 초과 body는 JSON 413, transaction 충돌은 409, transaction 만료는 `floor_editor_transaction_timeout` 503이다. Transaction 대기 예산은 5초, 실행 예산은 15초이며 일반 저장/복구 성능 목표는 3초다.
- 격리 PostgreSQL QA의 실제 HTTP/controller/service 1,000 fixture + 2,000 object 회귀(2026-09-09 최신 재실행, 로컬 Mac, 100회): 요청 559,679바이트, 저장 p95 425ms, 복구 485ms, 평균 snapshot JSON 730,443바이트/DB 저장 97,995바이트. 초기 저장 1회 + 변경 저장 100회 + 복구 1회의 총 102개 revision을 대상으로 snapshot 평균을 측정했다. 인증 guard만 테스트 사용자로 대체하며 현장 권한/lease/revision/DB/audit는 실제 구현이다. HIL 또는 운영 부하 측정 결과가 아니다.
- 이력 자동 삭제는 구현하지 않는다. 위 표본 기준 1만 revision은 snapshot 본문만 약 0.98 GB이며 index/audit/WAL 비용은 별도다. 보관 90일 이후 저빈도 이력 외부 보관은 제안값이며, 복구 SLA와 사용자 승인 후 별도 정책으로 결정한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | revision ID |
| `floorId` | `String` | 예 | FK -> `Floor.id`, cascade delete | 대상 층 |
| `revision` | `Int` | 예 | `(floorId, revision)` unique | 층별 revision 번호 |
| `snapshot` | `Json` | 예 |  | canonical editor state |
| `snapshotSha256` | `String` | 예 |  | 스냅숏 SHA-256 |
| `changeSummary` | `Json` | 예 |  | 변경 요약 |
| `changedBy` | `String` | 예 | FK -> `User.id`, restrict delete | 수정 사용자 |
| `restoredFromRevision` | `Int?` | 아니오 |  | 복구 원본 revision |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |

### AuditLog

조직·현장·작업자와 다형 대상의 감사 결과를 공통으로 보관한다. 다형 대상 ID는 FK로 강제하지 않으며 현장/작업자 시간순 조회 인덱스를 둔다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 감사 ID |
| `organizationId` | `String?` | 아니오 |  | 관련 조직 |
| `siteId` | `String?` | 아니오 | indexed with `createdAt` | 관련 현장 |
| `actorId` | `String?` | 아니오 | indexed with `createdAt` | 작업자 |
| `action` | `String` | 예 |  | 수행한 동작 |
| `targetType` | `String` | 예 |  | 대상 모델 종류 |
| `targetId` | `String?` | 아니오 |  | 대상 ID |
| `outcome` | `String` | 예 |  | 결과 |
| `metadata` | `Json?` | 아니오 |  | 비밀값을 제외한 변경 요약 |
| `ipAddress` | `String?` | 아니오 |  | 요청 IP |
| `userAgent` | `String?` | 아니오 |  | 요청 User-Agent |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |

### FloorPlan

층 도면 이미지와 좌표계 정보를 저장한다. `Floor`와 1:1 관계다. 층별 도면 에디터 작업에서 배경 없음, 이미지 원본, PDF 렌더링 결과 또는 native CAD scene 좌표계를 표현한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 도면 ID |
| `floorId` | `String` | 예 | Unique, FK -> `Floor.id` | 층 ID |
| `imageUrl` | `String` | 예 |  | 도면 이미지 URL |
| `width` | `Int` | 예 |  | 도면 기준 너비 |
| `height` | `Int` | 예 |  | 도면 기준 높이 |
| `gridSize` | `Int` | 예 | `10`, DB check `5~200` | 층별 맵 편집 격자 및 절대 좌표 스냅 간격 |
| `version` | `Int` | 예 | `1` | 도면 버전 |
| `sourceType` | `FloorPlanSourceType` | 예 | `image` | 배경 원본 종류. `cad`는 현재 `FloorCadScene`을 사용하며 기존 도면은 이미지로 간주 |
| `originalFileUrl` | `String?` | 아니오 |  | 업로드한 원본 JPG/PNG/PDF 파일 URL |
| `renderedImageUrl` | `String?` | 아니오 |  | PDF 첫 페이지 또는 후처리된 배경 이미지 URL |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

관계:

- `floor`: `Floor`

운영 메모:

- 현재 읽기 전용 모니터링 화면은 `imageUrl`, `width`, `height`와 저장된 맵 객체·조명 좌표를 사용한다.
- 맵 편집기는 `sourceType = none`이거나 `FloorPlan`이 없을 때 배경 없는 격자 캔버스를 표시한다. 배경이 없어도 맵 크기와 `gridSize`를 저장하기 위해 `sourceType = none`인 `FloorPlan`을 생성할 수 있다.
- `gridSize`는 `20260910000000_floor_plan_grid_size` migration으로 추가한다. 기존 행은 `10`으로 backfill되며 DB와 API가 모두 `5~200` 범위를 검증한다.
- PDF 업로드는 원본 ready asset 경로를 `originalFileUrl`에 저장한다. 별도 렌더 자산이 없으면 `imageUrl = ""`, `renderedImageUrl = NULL`로 원본만 연결하며 캔버스 배경은 표시하지 않는다. 첫 페이지 PNG는 후속 격리 렌더 worker가 생성한 ready asset만 연결한다.
- `sourceType = cad`는 `imageUrl`에 CAD geometry를 직렬화하지 않는다. 논리 맵 크기와 격자는 `FloorPlan`, native scene 메타데이터는 `FloorCadScene`, 실제 geometry는 `FloorAsset`이 가리키는 object storage manifest/tile에 둔다.
- `imageUrl`, `originalFileUrl`, `renderedImageUrl`은 같은 층의 ready `FloorAsset`을 가리키는 `/api/floors/{floorId}/assets/{assetId}/content` 경로만 허용한다. data URL, 임의 외부 URL과 다른 층 asset 경로는 거부한다.

### FloorAsset

S3 호환 object storage에 직접 업로드되거나 CAD worker가 생성하는 도면 원본, 렌더 이미지, native CAD manifest/tile/region preview를 추적한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | asset ID |
| `floorId` | `String` | 예 | FK -> `Floor.id`, cascade delete | 소속 층 |
| `kind` | `FloorAssetKind` | 예 | enum | `original`, `rendered`, `cad_manifest`, `cad_tile`, `cad_region_preview` 역할 |
| `status` | `FloorAssetStatus` | 예 | `pending` | 업로드 검증 전/후 상태 |
| `objectKey` | `String` | 예 | Unique | bucket 내부 object key |
| `mimeType` | `String` | 예 |  | 서명된 Content-Type |
| `contentEncoding` | `String?` | 아니오 | `NULL`, `gzip`, 또는 migration 전용 `unknown` | identity/gzip 확정값 또는 HEAD reconciliation 대기 상태 |
| `sizeBytes` | `BigInt` | 예 |  | 서명된 byte 크기 |
| `sha256` | `String` | 예 |  | 64자리 hex SHA-256 |
| `uploadExpiresAt` | `DateTime?` | 아니오 |  | pending PUT URL 만료 시각 |
| `cleanupStartedAt` | `DateTime?` | 아니오 |  | 만료 자산 정리 작업의 점유 시각 |
| `readyAt` | `DateTime?` | 아니오 |  | S3 HEAD 검증 완료 시각 |

운영 메모:

- upload intent는 JPEG/PNG/PDF, 1 byte~50 MB, SHA-256 형식을 검증하고 DB의 `pending` 원장을 먼저 커밋한 뒤 5분짜리 PUT URL을 발급한다. 서명 성공 뒤 실제 만료 시각이 원장에 기록된 경우에만 URL을 반환한다. 서명 또는 만료 기록이 실패하면 `uploadExpiresAt = NULL`인 원장이 남아 자동 정리 대상이 된다. API 내부 S3 endpoint와 브라우저용 public bucket base를 분리해 문자열 치환 없이 별도 client로 서명하며 production에서 public base 누락은 시작 오류다.
- complete 요청은 transaction 밖의 S3 HEAD에서 MIME, 크기, checksum을 4초 안에 확인한 뒤 transaction 안에서 Site 관리자 권한, 활성 Floor와 FloorAsset 행을 다시 잠금·검증하고 `ready`로 전환한다. 객체 부재는 404, 권한·timeout·저장소 장애는 503으로 구분한다.
- API 시작 시와 60초마다 최대 25개의 만료 pending 자산을 조회한다. URL 만료 후 5초가 지난 자산과 서명 단계에서 15분 이상 중단된 NULL 만료 원장을 점유하고, 4초 제한 안에 S3 삭제가 성공하면 원장 행을 삭제한다. 외부 저장소 실패 시 점유를 풀어 다음 주기에 재시도하며 2분 이상 남은 점유는 중단된 작업으로 회수한다.
- `readyAt` 또는 기존 행의 `createdAt`부터 24시간이 지난 ready 자산이 현재 FloorPlan과 모든 FloorMapRevision snapshot에서 참조되지 않으면 같은 worker가 회수한다. 후보 조회에서 참조 자산을 먼저 제외해 오래된 이력이 batch를 고갈시키지 않는다. ready 객체 삭제 실패는 점유 시각을 2분간 재시도 backoff로 유지해 다음 poll에서 뒤 후보를 처리한다. 맵 저장·복구와 cleanup은 Floor 행을 먼저 잠그고 `cleanupStartedAt`을 다시 확인하므로, 저장이 먼저 끝난 자산은 보존되고 cleanup이 먼저 점유한 자산은 저장되지 않는다.
- 조회 API는 공개 URL을 반환하지 않는다. 현장 `read` 권한을 확인한 content endpoint가 private bucket에 대해 300초 signed GET을 발급하고 `302`로 연결한다.
- 번들 MinIO는 `WEB_PUBLIC_URL`을 `MINIO_API_CORS_ALLOW_ORIGIN`으로 전달하며 미설정 시 `http://localhost:5173`을 사용한다. 버킷은 계속 anonymous `none`이고, 지원되지 않는 `mc cors set`이나 localhost 전용 XML에 의존하지 않는다.
- `20260912090000_floor_asset_private_ledger` migration은 기존 FloorPlan과 FloorMapRevision snapshot의 알려진 asset URL을 인증 경로로 치환하고, 변경된 snapshot의 안정 해시를 다시 계산한 뒤 `publicUrl` 컬럼을 제거한다. 알려진 asset과 대응하지 않는 비어 있지 않은 legacy URL이 하나라도 있으면 전체 migration을 원자적으로 중단한다.
- CAD 원본 또는 렌더 자산을 `FloorImportJob`이 참조하는 동안 FK가 직접 자산 삭제를 막는다. deferred constraint trigger는 자산 갱신 시에도 같은 층, 역할, ready 상태와 허용 MIME을 다시 검증한다. 후속 cleanup worker는 이 관계를 후보 조회에서도 제외해야 한다.
- native CAD region preview, manifest와 tile은 각각 `FloorImportRegion`, `FloorCadScene`, `FloorCadTile`이 `ON DELETE NO ACTION`으로 참조한다. 참조 owner가 제거될 때 자산 행과 object는 자동 삭제하지 않으며, 후속 object cleanup이 별도 수명주기로 회수해야 한다.
- 신규 CAD worker의 rendered SVG는 확정 `contentEncoding = gzip`을 기록한다. `20260917165000_cad_content_encoding_reconciliation`은 생성 시각을 추정 근거로 쓰지 않고, committed attempt provenance가 없는 기존 linked SVG를 `unknown`으로 표시한다. Review/apply/content는 Object Storage HEAD의 encoding, 크기, checksum, viewport가 원장과 일치할 때만 `unknown`을 `NULL` identity 또는 `gzip`으로 조건부 원자 갱신한다. HEAD 오류·불일치나 경쟁 갱신의 다른 결과는 fail-close한다. deferred asset trigger는 linked SVG에 `NULL | gzip | unknown`을, PNG/JPEG/WebP에는 `NULL`만 허용한다. 기존 `20260917150000_cad_profile_binding` checksum은 수정하지 않는다.

### FloorImportAttemptCleanup

CAD worker가 rendered SVG를 PUT하기 전에 만드는 영속 attempt cleanup tombstone이다. worker process가 PUT 도중 종료되거나 storage 성공 뒤 DB commit 응답을 잃어도 deterministic object key를 재조정할 수 있게 한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `jobId`, `attemptCount` | `String`, `Int` | 예 | 복합 PK, attempt `1~3` | job의 개별 worker attempt identity |
| `floorId` | `String` | 예 | FK 없음 | floor cascade 뒤에도 object cleanup identity를 보존하는 scope |
| `assetId` | `String` | 예 | Unique, FK 없음 | PUT 전에 생성한 pending rendered `FloorAsset.id` |
| `objectKey` | `String` | 예 | Unique, key CHECK | `floors/{floorId}/{jobId}-attempt-{attemptCount}.svg` deterministic private key |
| `leaseOwner`, `leaseExpiresAt` | `String?`, `DateTime?` | 아니오 | 둘 다 NULL 또는 둘 다 값 | cleanup sweeper의 30초 점유 fence |
| `nextAttemptAt` | `DateTime` | 예 | UTC DB 기본값 | 다음 cleanup 또는 quiet-period final 확인 가능 시각 |
| `lastCleanedAt` | `DateTime?` | 아니오 |  | 가장 최근 성공한 object DELETE 시각 |
| `cleanedAt` | `DateTime?` | 아니오 | terminal CHECK | quiet period final DELETE까지 성공한 orphan terminal 시각 |
| `lastError` | `String?` | 아니오 |  | 정제된 최근 cleanup 오류 코드 |
| `committedAt` | `DateTime?` | 아니오 | `cleanedAt`과 상호 배타 | ready asset과 import job 연결 transaction이 성공한 시각 |
| `createdAt`, `updatedAt` | `DateTime` | 예 | UTC DB 기본값, `@updatedAt` | 생성·최종 갱신 시각 |

제약과 lifecycle:

- `(jobId, attemptCount)` 복합 PK는 최대 3회 retry의 attempt identity를 고정한다. `assetId`와 `objectKey`는 각각 unique이며 key CHECK가 floor/job/attempt 조합과 실제 storage key의 일치를 강제한다.
- 의도적으로 `Floor`, `FloorImportJob`, `FloorAsset` FK를 두지 않는다. floor/job cascade가 pending asset 원장을 제거한 뒤에도 tombstone이 남아, 종료된 worker의 늦은 PUT을 삭제할 수 있어야 한다.
- cleanup claim은 `FOR UPDATE SKIP LOCKED`와 owner/expiry pair를 사용한다. 범용 `FloorAssetCleanupService`는 pending 후보 조회와 Floor→asset 잠금 claim 양쪽에서 이 tombstone의 `assetId`를 제외하며, CAD worker는 Floor→asset→attempt 순서로 잠그고 `cleanupStartedAt IS NULL`인 경우에만 pending asset을 ready로 승격한다.
- orphan의 첫 성공 DELETE는 `lastCleanedAt`을 기록하고 15분 quiet period 뒤로 `nextAttemptAt`을 이동한다. 이 기간에는 재삭제하지 않으며, transport가 늦게 완료한 PUT은 quiet period 종료 시 final DELETE로 회수한다. final DELETE 성공 시 `cleanedAt`을 기록해 terminal 처리하고 이후 sweep 대상에서 영구 제외한다.
- 정상 worker commit은 rendered asset ready 승격, job의 `review_required` 연결, tombstone `committedAt` 기록을 한 transaction에서 수행한다. `committedAt`과 `cleanedAt`은 동시에 존재할 수 없고, `cleanedAt` terminal은 `lastCleanedAt`이 있으며 cleanup lease가 해제된 상태만 허용한다.
- `20260917130000_floor_import_attempt_cleanup` migration이 tombstone과 identity/lease/key 제약을 만들고, `20260917140000_floor_import_attempt_cleanup_terminal` migration이 기존 migration을 수정하지 않고 `cleanedAt`과 terminal CHECK를 추가한다.

### FloorImportJob

DWG/DXF 원본을 비동기로 변환·검출·검토·적용하는 작업의 영속 원장이다. 큰 CAD 파싱은 API 요청 안에서 실행하지 않으며 만료된 worker lease는 다른 worker가 재개한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | import job ID |
| `floorId` | `String` | 예 | FK -> `Floor.id`, cascade delete | 대상 층 |
| `sourceAssetId` | `String` | 예 | FK -> `FloorAsset.id`, delete no action, indexed | private DWG/DXF 원본 자산. 완료 후 같은 원본으로 새 분석 job 생성 가능 |
| `renderedAssetId` | `String?` | 아니오 | Unique, FK -> `FloorAsset.id`, delete no action, 원본과 달라야 함 | 변환 결과 SVG/래스터 자산 |
| `sourceFormat` | `FloorImportSourceFormat` | 예 |  | `dwg` 또는 `dxf` |
| `status` | `FloorImportJobStatus` | 예 | `queued` | 영속 작업 상태 |
| `stage` | `String` | 예 | `queued`, trim 길이 1~100 | 상태보다 세분화된 현재 처리 단계 |
| `progressPercent` | `Int` | 예 | `0`, DB check `0~100` | 진행률. lifecycle check는 queued `0~99`, processing/region_selection_required `1~99`, review_required/applying/completed `100`, failed/cancelled `0~100`을 허용 |
| `attemptCount` | `Int` | 예 | `0`, DB check `>= 0` | worker lease 획득/재시도 횟수 |
| `parserVersion` | `String?` | 아니오 |  | CAD parser/정규화 구현 버전 |
| `detectorVersion` | `String?` | 아니오 |  | 조명 후보 detector 버전 |
| `detectorProfileId` | `String?` | 아니오 | 허용 registry ID 또는 migration staging `NULL` | 서버가 source SHA-256 binding으로 정한 detector profile ID |
| `detectorProfileVersion` | `String?` | 아니오 | digest와 함께 NULL 또는 값 | 실제 주입 detector profile 버전 |
| `detectorProfileDigest` | `String?` | 아니오 | 64자리 lowercase SHA-256 | 후보 행동 필드 전체의 canonical digest |
| `excludedRegionPrimitiveCount` | `Int?` | 아니오 | DB check `0~1000000` | CAD 영역 탐지기가 어느 region에도 포함하지 않은 실제 제외 primitive 수. 신규 분석 작업은 region API 노출 전에 반드시 기록하며 기존 NULL 작업은 재가져오기를 요구한다. |
| `leaseOwner`, `leaseExpiresAt` | `String?`, `DateTime?` | 아니오 | 둘 다 NULL 또는 둘 다 값 | 다중 worker 점유와 만료 시각 |
| `failureCode`, `failureMessage` | `String?` | 아니오 |  | 정제된 실패 코드와 내부 운영 메시지 |
| `startedAt` | `DateTime?` | 아니오 |  | 첫 처리 시작 시각 |
| `reviewRequiredAt` | `DateTime?` | 아니오 |  | 후보 검토 가능 상태 진입 시각 |
| `appliedAt` | `DateTime?` | 아니오 |  | editor transaction 적용 시각 |
| `completedAt` | `DateTime?` | 아니오 |  | 정상 종료 시각 |
| `failedAt` | `DateTime?` | 아니오 | failed 상태에서 필수 | 실패 확정 시각 |
| `cancelledAt` | `DateTime?` | 아니오 |  | 취소 시각 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 최종 갱신 시각 |

제약과 인덱스:

- `floorId + createdAt`, `status + leaseExpiresAt + createdAt` index로 층별 이력과 lease 회수 대상을 조회한다.
- `sourceAssetId`는 일반 index다. 완료·실패·취소 이후 동일 원본 재분석을 허용하며 동시 workflow는 층별 active partial unique가 막는다.
- client/Web은 profile ID를 보내지 않는다. create transaction이 잠근 ready source asset SHA-256으로 server registry binding을 결정한다. migration 시점의 queued job만 ID/version/digest를 `NULL`로 staging하고 worker lease 안에서 같은 binding을 해석한다. `20260917144000_cad_profile_upgrade_gate`는 singleton gate와 DB trigger를 먼저 설치해 구 worker를 포함한 queued→processing 전환을 거부한다. `20260917145000`/`16000`이 profile/content 제약을 적용하고 `20260917170000_cad_profile_upgrade_release`가 필요한 migration 완료 이력을 확인한 뒤에만 gate를 연다.
- partial unique index `FloorImportJob_floorId_active_key`는 `completed`, `failed`, `cancelled`가 아닌 모든 active 상태를 층마다 하나로 제한한다. 따라서 `region_selection_required` 중에도 같은 층의 두 번째 import를 시작할 수 없고, 향후 active 상태 추가 시 누락되지 않는다. 완료·실패·취소 원장은 이력으로 유지한다.
- deferred constraint trigger `FloorImportJob_asset_invariant`, `FloorAsset_import_job_invariant`는 transaction 최종 상태에서 원본/렌더 자산이 job과 같은 층이고 ready인지, source는 `original`과 source format별 DWG/DXF MIME인지, render는 `rendered`와 허용 이미지 MIME인지 양쪽 mutation 경로에서 강제한다.
- migration-only `FloorImportJob_lifecycle_check`는 queued/processing/region_selection_required/review_required/applying/completed/failed/cancelled별 progress, lease, 오류, 렌더 자산과 필수 timestamp 조합을 강제한다. `20260918130000_floor_import_retry_progress`부터 최초 및 재시도 queued는 `0~99`의 보존 진행률과 해제된 lease를 허용한다. queued 진행률이 `1~99`이면 claim 이력을 나타내는 `attemptCount >= 1`이 필요하지만, 과거 데이터 호환을 위해 진행률 `0`인 queued row의 attemptCount는 추가로 제한하지 않는다. processing은 lease가 있는 `1~99`, region_selection_required는 처리 이력과 `startedAt`/`reviewRequiredAt`이 있으나 lease·rendered asset이 없는 `1~99`, review_required/applying/completed는 정확히 `100`, failed/cancelled는 `0~100`을 허용한다. terminal 상태는 lease가 없고 각각 `completedAt`, `failedAt`, `cancelledAt`이 필요하다.
- `FloorImportJob_detector_profile_state_check`는 `review_required`, `applying`, `completed`에서 profile ID/version/digest를 모두 요구한다. migration 이전 terminal 결과는 현재 profile로 위장하지 않고 `legacy-unknown`과 zero digest sentinel로 보존한다.
- 위 trigger, lifecycle/check 제약과 active partial unique는 Prisma datamodel로 표현되지 않는다. `floor-cad-import-migration.integration.spec.ts`가 실제 PostgreSQL catalog와 잘못된 INSERT/UPDATE 거부를 검증하므로 migration을 Prisma diff로 재생성해 대체하면 안 된다.

### FloorImportRegion

CAD model space에서 탐지한 선택 후보 영역을 import job 아래에 영속화한다. `regionId`는 같은 입력과 region 알고리즘 버전에서 재시도해도 유지되는 안정 ID이며, 실제 preview 이미지는 object storage에 둔다. 최초 탐지의 region별 normalized candidate identity 집합은 정렬 후 canonical JSON을 SHA-256으로 해시해 보존하고, 선택 후 scene build 재실행의 detector assignment를 parent process에서 대조한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | region 행 ID |
| `jobId` | `String` | 예 | FK -> `FloorImportJob.id`, cascade delete | 소속 import job |
| `regionId` | `String` | 예 | `(jobId, regionId)` Unique, trim 길이 1~512 | job 안의 안정 region ID |
| `minX`, `minY`, `maxX`, `maxY` | `Float` | 예 | 유한값, max > min | 원본 CAD 좌표계 bounds |
| `primitiveCount` | `Int` | 예 | `1~500000` | 확장 후 region primitive 수 |
| `candidateIdentityDigest` | `String?` | 아니오 | lowercase SHA-256 64 hex | 최초 탐지에서 해당 region에 배정된 normalized candidate identity 정렬 집합의 canonical digest. migration 이전 행만 `NULL`이며 selection-required job은 재가져오기 전 선택을 fail-close한다. |
| `previewAssetId` | `String?` | 아니오 | Unique, FK -> `FloorAsset.id`, delete no action | 같은 층의 ready `cad_region_preview` 자산 |
| `selectedAt` | `DateTime?` | 아니오 | job별 non-null partial Unique | 현재 job에서 선택한 region 시각 |
| `createdAt`, `updatedAt` | `DateTime` | 예 | `now()`, `@updatedAt` | 생성·갱신 시각 |

`FloorImportJob` 삭제는 region을 cascade 삭제하지만 preview asset은 남긴다. `FloorImportRegion_jobId_selected_key` partial unique index가 job마다 선택 region을 최대 하나로 제한한다. Region 쓰기는 preview asset 행을 `FOR UPDATE`로 먼저 잠그고, deferred constraint trigger는 preview가 source job과 같은 층의 ready `cad_region_preview`인지 region/asset/job 변경 양쪽에서 검증한다. `20260919130000_add_floor_import_region_candidate_digest` migration은 기존 행을 백필하지 않고 nullable로 유지한다. worker가 새 최초 탐지 결과를 저장할 때 모든 region digest를 함께 기록하며, 단일 region 자동선택도 scene/candidate persistence transaction 안에서 같은 digest를 저장한다. 다중 region 선택 API는 하나라도 digest가 없으면 `re-import required`로 거부한다.

### FloorCadScene

한 층에 현재 적용된 native CAD scene 메타데이터를 하나만 보관한다. `(floorId)` Unique가 current scene을 1:1로 고정하고, source import job과 선택 region도 scene당 하나만 연결한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | scene ID |
| `floorId` | `String` | 예 | Unique, FK -> `Floor.id`, cascade delete | 현재 scene을 사용하는 층 |
| `sourceImportJobId` | `String` | 예 | Unique, FK -> `FloorImportJob.id`, cascade delete | scene을 생성한 import job |
| `sourceRegionId` | `String` | 예 | Unique, FK -> `FloorImportRegion.id`, delete no action | 선택된 source region 행 |
| `version` | `Int` | 예 | `1` 고정 | scene format/version |
| `status` | `String` | 예 | `active`만 허용 | 현재 적용된 scene 상태 |
| `width`, `height` | `Int` | 예 | 각각 `512~32768` | 정규화한 논리 맵 크기 |
| `tileSize` | `Int` | 예 | `512` 고정 | logical tile 한 변 |
| `primitiveCount`, `tileCount` | `Int` | 예 | 각각 `0~500000`, `0~12288` | scene 통계 |
| `manifestAssetId` | `String` | 예 | Unique, FK -> `FloorAsset.id`, delete no action | 같은 층의 ready `cad_manifest` 자산 |
| `sourceMinX`, `sourceMinY`, `sourceMaxX`, `sourceMaxY` | `Float` | 예 | 유한값, max > min, 선택 region bounds와 정확히 일치 | 선택 region 원본 bounds |
| `transformScaleX`, `transformScaleY`, `transformTranslateX`, `transformTranslateY` | `Float` | 예 | 유한값, scaleX > 0, scaleY != 0 | 원본 좌표를 논리 맵으로 옮기는 정규화 transform. 음수 scaleY는 CAD Y축 반전을 보존 |
| `createdAt`, `updatedAt` | `DateTime` | 예 | `now()`, `@updatedAt` | 생성·갱신 시각 |

Floor 또는 source import job 삭제는 scene과 tile/override/layer 상태를 cascade 삭제한다. manifest, tile, preview 자산은 `NO ACTION` 참조로 보호되며 owner cascade 뒤에도 자동 삭제하지 않는다. source region 직접 삭제와 manifest 직접 삭제는 현재 scene이 있으면 거부한다. Scene 쓰기는 manifest asset 행을 `FOR UPDATE`로 먼저 잠그며, deferred constraint trigger는 scene의 floor, job, 선택 region bounds, manifest와 모든 기존 tile asset의 층/역할/ready 상태를 parent update까지 포함해 재검증한다.

### FloorCadTile

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | tile 메타데이터 ID |
| `sceneId` | `String` | 예 | FK -> `FloorCadScene.id`, cascade delete | 소속 scene |
| `tileX`, `tileY`, `lod`, `part` | `Int` | 예 | 좌표 `0~63`, LOD `0~2`, part `0~127`, 복합 Unique | tile 좌표, additive 상세 단계와 16 MiB payload shard 순번 |
| `assetId` | `String` | 예 | Unique, FK -> `FloorAsset.id`, delete no action | 같은 층의 ready `cad_tile` binary 자산 |
| `primitiveCount` | `Int` | 예 | `1~500000` | 비어 있지 않은 tile part의 primitive 수 |
| `byteSize` | `BigInt` | 예 | `1~16777216` (16 MiB) | 압축 payload 크기 |
| `minX`, `minY`, `maxX`, `maxY` | `Float` | 예 | scene 내부에서 `(tileX, tileY, tileSize)` cell bounds와 정확히 일치 | 논리 맵 tile bounds |
| `createdAt`, `updatedAt` | `DateTime` | 예 | `now()`, `@updatedAt` | 생성·갱신 시각 |

`(sceneId, tileX, tileY, lod, part)` Unique와 `(sceneId, lod, tileX, tileY)` index로 중복 shard 저장을 막고 viewport/LOD 조회를 지원한다. 같은 cell/LOD의 part는 manifest에서 0부터 연속이어야 하고 각 binary payload는 16 MiB 이하이다. Tile 쓰기는 tile asset 행을 `FOR UPDATE`로 먼저 잠가 동시 role/floor/ready 변경과 직렬화한다. geometry와 공간 index 본문은 DB JSON 컬럼이 아니라 `assetId`가 가리키는 압축 object에만 저장한다.

### FloorCadElementOverride / FloorCadLayerState

원본 scene은 불변으로 유지하고 사용자가 수정한 element와 layer 상태만 sparse row로 저장한다.

| 모델 | 키/주요 컬럼 | 제약과 삭제 정책 |
| --- | --- | --- |
| `FloorCadElementOverride` | PK `(sceneId, elementId)`, `hidden`, translate/scale/rotation, stroke/fill/width/text, nullable locator `locatorTileX/Y/Lod/Part` | 값이 하나 이상 있어야 하며 transform은 유한값, scale은 양수, 색상은 hex 형식이고 text는 최대 65536자다. 신규 override는 검증에 사용한 원본 tile locator를 함께 저장해 전체 scene scan 없이 이동 요소 geometry를 복원한다. migration 이전 행은 locator 전체가 NULL일 수 있고, 값이 있으면 네 필드가 모두 존재하며 tile 범위 안이어야 한다. scene 삭제 시 cascade한다. |
| `FloorCadLayerState` | PK `(sceneId, layerName)`, `visible=true`, `locked=false` | layer 이름은 trim 1~512자이며 scene 삭제 시 cascade한다. |

`20260919150000_add_cad_override_locator` migration은 기존 override 행을 보존한 채 nullable locator 4개를 추가한다. API는 이후의 모든 upsert에서 evidence 검증을 통과한 locator를 저장하며, 클라이언트는 이동 override의 목적지 viewport에 필요한 원본 tile만 제한된 동시성으로 preload한다.

두 모델 모두 geometry를 JSON으로 복제하지 않는다. override의 transform도 nullable scalar 열로만 저장하며 `(sceneId, updatedAt)` index가 변경분 조회를 지원한다.

### CadProfileUpgradeGate

CAD profile/content migration 동안 구 worker claim까지 차단하는 DB singleton이다. Prisma datamodel에는 노출하지 않는다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `SmallInt` | 예 | PK, 항상 `1` | singleton identity |
| `closed` | `Boolean` | 예 | `true` | `true`이면 queued→processing claim 거부 |
| `updatedAt` | `DateTime` | 예 | DB 현재 시각 | gate 최종 변경 시각 |

- `FloorImportJob_profile_upgrade_gate` BEFORE trigger는 status가 processing으로 진입하는 INSERT/UPDATE를 SQLSTATE `55006`으로 거부한다. 애플리케이션 버전과 무관한 durable fence다.
- Gate 설치 migration이 lock timeout으로 rollback되면 Prisma 실패 이력을 임의 삭제하지 않는다. 실제 카탈로그 rollback을 확인한 담당자가 해당 이름만 `prisma migrate resolve --rolled-back` 처리한 뒤 deploy를 재시도한다.
- Release migration 이전에는 직접 `closed=false`로 바꾸지 않는다. 회귀 테스트는 clean deploy, 14500 race, rollback/retry, 기존 15000 완료 이력과 최종 open을 실제 PostgreSQL에서 검증한다.

### FloorImportCandidate

CAD parser 좌표에서 검출한 조명 위치 후보 원장이다. 후보는 BLE Mesh 장비 identity가 없으므로 `Fixture` 또는 `MeshNode`를 생성하거나 자동 연결하지 않는다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 후보 ID |
| `jobId` | `String` | 예 | FK -> `FloorImportJob.id`, cascade delete | 소속 import job |
| `sourceEntityId` | `String` | 예 | job 안에서 Unique, trim 길이 1~512 | 정규화 CAD source entity ID |
| `layerName` | `String` | 예 | trim 길이 1~512 | CAD layer 이름 |
| `blockName` | `String?` | 아니오 | 값이 있으면 trim 길이 1~512 | CAD block 이름 |
| `x`, `y` | `Float` | 예 | 유한한 0 이상 값 | parser가 맵 좌표계로 정규화한 위치 |
| `rotation` | `Float` | 예 | `0`, 유한값 | parser가 계산한 회전 각도 |
| `confidence` | `Float` | 예 | DB check `0~1` | 검출 신뢰도 |
| `detectionMethod` | `FloorImportDetectionMethod` | 예 |  | 규칙 또는 향후 AI 보조 검출 구분 |
| `provider` | `String?` | 아니오 | rule_based는 NULL, ai_assisted는 trim 길이 1~200 필수 | AI provider 식별자 |
| `model` | `String?` | 아니오 | rule_based는 NULL, ai_assisted는 trim 길이 1~200 필수 | AI model 식별자 |
| `inputDigest` | `String?` | 아니오 | rule_based는 NULL, ai_assisted는 64자리 lowercase SHA-256 필수 | AI 분류 입력 digest |
| `profileVersion` | `String` | 예 | 기존 행은 `legacy-unknown` | 후보를 만든 실제 detector profile 버전 |
| `profileDigest` | `String` | 예 | 64자리 lowercase SHA-256 | 후보를 만든 detector canonical digest |
| `reviewStatus` | `FloorImportCandidateReviewStatus` | 예 | `pending` | 관리자 검토 상태 |
| `reviewedAt` | `DateTime?` | 아니오 | pending이면 NULL, accepted/rejected이면 필수 | 검토 시각 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 최종 갱신 시각 |

제약과 인덱스:

- `(jobId, sourceEntityId)` unique로 worker 재시도 시 같은 CAD entity의 후보가 중복 생성되지 않게 한다.
- `(jobId, reviewStatus, id)` index와 2,000개 bounded bulk 계약으로 검토 목록을 지원한다. worker는 250건 chunk `createMany` transaction을 사용한다.
- 좌표와 회전은 parser 결과만 저장한다. AI 보조 구현도 좌표를 생성하거나 변경할 수 없다.
- migration-only `FloorImportCandidate_ai_metadata_check`는 rule-based 후보의 AI 메타데이터를 모두 NULL로, AI-assisted 후보는 provider/model/inputDigest를 모두 필수로 강제한다. profile digest, geometry/confidence/review CHECK도 Prisma datamodel 외 SQL 불변식이며 migration regression test가 실제 DB 동작을 고정한다.

### FloorLightSlot

승인된 CAD 조명 후보를 현재 맵에서 사용할 영속 배치 슬롯으로 분리한다. `FloorImportCandidate`는 분석·검토 이력으로 유지하고, 실제 조명 연결 상태는 이 테이블만 변경한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 슬롯 ID |
| `floorId` | `String` | 예 | FK -> `Floor.id`, cascade delete | 현재 맵의 층 ID |
| `sourceImportJobId` | `String` | 예 | FK -> `FloorImportJob.id`, cascade delete | 슬롯을 만든 CAD import job |
| `sourceCandidateId` | `String` | 예 | Unique, FK -> `FloorImportCandidate.id`, cascade delete | 원본 승인 후보. 후보 하나당 슬롯 하나 |
| `assignedFixtureId` | `String?` | 아니오 | Unique, FK -> `Fixture.id`, delete set null | 슬롯에 연결한 실제 조명. 한 조명은 슬롯 하나에만 연결 가능 |
| `capacityOrdinal` | `Int` | 예 | DB 관리, `1..2000`, `(floorId, capacityOrdinal)` Unique | 층별 슬롯 용량을 구조적으로 제한하는 ordinal. Prisma 호출자는 생략한다. |
| `x`, `y` | `Float` | 예 | 유한값 CHECK | 맵 좌표계의 슬롯 위치 |
| `rotation` | `Float` | 예 | `0`, 유한값 CHECK | 후보에서 보존한 회전 각도 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 최종 갱신 시각 |

제약과 인덱스:

- `(floorId, id)` index로 층별 슬롯을 안정적인 ID 순서로 조회한다.
- `sourceCandidateId` unique는 후보 중복 적용을 막고, nullable `assignedFixtureId` unique는 실제 조명의 중복 슬롯 할당을 막는다.
- 한 층의 슬롯은 최대 2,000개다. BEFORE trigger가 호출자 입력과 관계없이 비어 있는 `capacityOrdinal`을 배정하며, `1..2000` CHECK와 `(floorId, capacityOrdinal)` Unique가 REPEATABLE READ의 오래된 snapshot에서도 상한을 구조적으로 보장한다. 층별 advisory transaction lock은 동시 writer 충돌을 줄이는 보조 수단이다.
- 같은 층의 `capacityOrdinal` 직접 변경은 DB가 기존 값으로 되돌린다. `floorId` 변경과 `Floor.id` cascade update는 새 층의 빈 ordinal을 다시 배정하고, 자리가 없으면 transaction을 거부한다. DELETE 후 최대 2,000개 INSERT는 같은 transaction에서 ordinal을 재사용하므로 원자적 맵 교체가 가능하다.
- `20260918190000_floor_light_slot_capacity_reconciliation`은 이미 적용된 이전 migration의 초기·중간 schema에도 `capacityOrdinal`, 범위 CHECK, 층별 Unique와 최종 BEFORE trigger를 데이터 보존 방식으로 추가한다. 기존 행은 층별 `createdAt, id` 순서로 ordinal을 backfill하고 deferred scope trigger를 즉시 검증한 뒤 DDL을 계속한다. 기존 슬롯이 층당 2,000개를 넘으면 전체 transaction을 rollback하며 임의 행을 삭제하지 않는다.
- `FloorLightSlot_geometry_check`는 PostgreSQL이 저장할 수 있는 `NaN`, 양·음의 `Infinity`를 x/y/rotation에서 거부한다.
- deferred constraint trigger는 슬롯의 `floorId`, source job의 층, source candidate의 job이 같은지 검증한다. 할당 조명이 있으면 해당 `Fixture.floorId`도 슬롯 층과 같아야 한다.
- 슬롯뿐 아니라 `FloorImportJob.floorId`, `FloorImportCandidate.jobId`, `Fixture.floorId` 변경 경로에도 trigger를 설치해 부모 변경으로 불일치가 생기는 경우 transaction 전체를 거부한다. 이 교차 테이블 제약은 Prisma datamodel로 표현되지 않는다.
- CAD apply는 현장 manage 재인가 뒤 `Floor`, import job, 원본·렌더 자산을 잠그고 editor lease fence/token/만료와 `mapRevision`을 검증한다. 같은 Serializable transaction에서 모든 `FloorMapObject` 삭제, 해당 층 `Fixture`의 `placementStatus=unplaced`·`positionVerifiedAt=NULL`·`x/y=0` 초기화, 기존 슬롯 삭제, accepted 후보 슬롯 생성, `FloorPlan` 교체, revision/snapshot/audit와 job 완료를 처리한다. 슬롯 insert는 `capacityOrdinal`을 전달하지 않고 DB trigger에 맡긴다.
- fixture 초기화는 위치 필드만 갱신하므로 `Fixture` 행, `MeshNode`, 그룹·자동화 대상, 전력 이력은 유지된다. 슬롯 insert trigger 강제 실패 통합 회귀는 plan/object/fixture/slot/candidate/revision/audit/job과 floor revision이 모두 적용 전 상태로 rollback되는지 실제 PostgreSQL에서 비교한다.
- editor 저장의 strict `slotAssignments` mutation은 요청당 최대 2,000개이며 `slotId`와 non-null `assignedFixtureId` 중복을 거부한다. Floor row를 잠가 lease/revision을 확인한 뒤 대상 slot과 fixture의 층 소유권, 미변경 slot의 fixture 점유를 검증한다. swap/reassign은 변경 대상 slot을 먼저 NULL로 비우고 non-null 관계를 설정한 뒤 층 전체 최종 assignment가 fixture 1:1인지 재검증한다. 모든 non-null assignment의 fixture는 같은 층에서 `placed` 상태이고 x/y가 slot x/y와 DB Float 값 기준으로 정확히 일치해야 한다. fixture 위치 변경, slot assignment, 최종 관계 검증, snapshot/revision/audit는 같은 Serializable transaction에서 commit되며 검증 실패 시 모두 rollback되고 응답과 fresh editor 조회에는 최종 관계가 포함된다.
- revision 복구는 역사 snapshot을 읽되 현재 슬롯을 재생성하지 않으며, 복구 transaction이 새로 쓰는 snapshot에는 복구 시점의 현재 슬롯 배열을 기록한다.

### FloorMapObject

층별 도면 에디터에서 사용자가 추가하는 도형과 텍스트 객체를 저장한다. 조명 위치는 기존 `Fixture.x`, `Fixture.y`를 계속 사용하고, 사각형/텍스트 같은 비조명 편집 객체만 이 테이블로 분리한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 도면 객체 ID |
| `floorId` | `String` | 예 | FK -> `Floor.id` | 소속 층 |
| `type` | `String` | 예 |  | `rectangle`, `text` 등 에디터 오브젝트 타입 |
| `x` | `Float` | 예 |  | 도면 기준 X 좌표 |
| `y` | `Float` | 예 |  | 도면 기준 Y 좌표 |
| `width` | `Float?` | 아니오 |  | 사각형/삼각형 등 면 객체 너비 |
| `height` | `Float?` | 아니오 |  | 사각형/삼각형 등 면 객체 높이 |
| `rotation` | `Float` | 예 | `0` | 회전 각도 |
| `points` | `Json?` | 아니오 |  | 선 또는 다각형 좌표 배열 |
| `text` | `String?` | 아니오 |  | 텍스트 객체 내용 |
| `strokeColor` | `String` | 예 | `#0b63e5` | 선 색상 |
| `fillColor` | `String?` | 아니오 |  | 채움 색상 |
| `strokeWidth` | `Float` | 예 | `2` | 선 두께 |
| `fontSize` | `Float?` | 아니오 |  | 텍스트 크기 |
| `zIndex` | `Int` | 예 | `0` | 같은 층 안의 렌더링 순서 |
| `locked` | `Boolean` | 예 | `false` | 편집 잠금 여부 |
| `visible` | `Boolean` | 예 | `true` | 화면 표시 여부 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

제약:

- Index: `floorId`, `zIndex`

관계:

- `floor`: `Floor`

운영 메모:

- 이 모델은 층별 도면 에디터 MVP1의 비조명 편집 객체를 저장한다.
- 향후 구역/그룹 객체를 정식 도메인으로 승격할 경우 `type` 문자열 대신 전용 enum 또는 별도 테이블로 분리할 수 있다.

### Fixture

개별 LED 조명이다. 위치, 밝기, 상태, 통신 품질 최신 snapshot을 가진다.

- `20260909000000_fixture_placement`는 기존 row를 좌표 변경 없이 `placed/NULL`로 확장한 뒤 신규 기본값을 `unplaced`로 바꾼다. `Fixture_unplaced_position_unverified` CHECK로 미배치 확인 시각을 금지한다. 격리 QA DB에만 migrate deploy를 실행했으며 사용자 DB에는 적용하지 않았다.
- 신규 등록은 지도 여유 공간과 무관하게 수락하며, 구버전 등록 placement 입력은 호환 수신하되 사용하지 않는다. Pending 숫자 x/y는 `0/0`, 완료된 Fixture는 기본값 `unplaced/NULL`이며 이 숫자를 지도 위치로 해석하지 않는다.
- 에디터는 전체 등록 조명을 반환한다. 지도 마커에서만 미배치를 숨기고 목록/개수/제어/그룹/스케줄/이벤트/통계에서는 제외하지 않는다. 배치 해제는 장비·그룹·자동화·전력 이력을 변경하지 않는다.
- 위치 변경/배치 해제는 기존 확인을 무효화한다. 이름/크기 수정은 확인을 유지한다. 입력 `positionVerified: true`는 현재 위치를 사람이 확인한 요청이며 서버가 새 시각을 부여한다. Timestamp 직접 입력과 미배치 확인은 거부한다. 이전 revision 복구는 당시 좌표 및 확인 시각을 함께 복원한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 조명 ID |
| `floorId` | `String` | 예 | `siteId`와 복합 FK -> `Floor(id, siteId)`, delete cascade/update cascade | 설치 층 |
| `meshNodeId` | `String?` | 아니오 | Unique, `gatewayId`와 복합 FK -> `MeshNode(id, gatewayId)`, delete set null/update cascade | 연결된 BLE Mesh 노드 |
| `siteId` | `String` | 예 | `project_fixture_owner` trigger 파생, 직접 불일치 입력 거부 | Floor에서 투영한 tenant owner |
| `gatewayId` | `String?` | 아니오 | `project_fixture_owner` trigger 파생, MeshNode가 없을 때만 `NULL` | MeshNode에서 투영한 Gateway owner |
| `name` | `String` | 예 |  | 조명 이름 |
| `ratedWatt` | `Decimal(8,2)` | 예 |  | 정격 전력 W |
| `x` | `Float` | 예 |  | 도면 기준 X 좌표 |
| `y` | `Float` | 예 |  | 도면 기준 Y 좌표 |
| `size` | `Float` | 예 | `20` | 도면 에디터에서 표시되는 조명 노드 지름 |
| `placementStatus` | `FixturePlacementStatus` | 예 | `unplaced` | 지도 배치 상태: `unplaced`, `placed`. 등록/제어 가능 여부와 독립 |
| `positionVerifiedAt` | `DateTime?` | 아니오 | `NULL`; 미배치는 NULL 강제 CHECK | 사람이 위치를 명시적으로 확인한 서버 시각 |
| `status` | `FixtureStatus` | 예 | `offline` | 고정 90초 Gateway/1,200초 Fixture freshness가 반영된 운영 상태; Commands/Identify 소비 |
| `reportedStatus` | `FixtureStatus` | 예 | `offline` | 마지막 수락 fixture-state의 status; freshness sweep은 변경하지 않음 |
| `reportedStatusReason` | `String?` | 아니오 | `NULL` | 마지막 수락 보고 사유; command_failed 및 첫 상태 대기 보존 |
| `brightness` | `Int` | 예 | `0` | 현재 밝기 0-100 |
| `rssi` | `Int?` | 아니오 |  | 최근 RSSI |
| `hopCount` | `Int?` | 아니오 |  | 최근 BLE Mesh hop 수 |
| `commandSuccessRate` | `Float?` | 아니오 |  | 최근 명령 성공률 |
| `lastSeenAt` | `DateTime?` | 아니오 |  | API가 마지막 수락 fixture-state 또는 fixture-presence를 받은 서버 수신 시각; freshness 기준 |
| `lastStateEventId` | `String?` | 아니오 | Unique | 마지막 적용 MQTT v2 이벤트 ID |
| `lastStateSequence` | `BigInt?` | 아니오 |  | 마지막 적용 gateway sequence |
| `lastStateOccurredAt` | `DateTime?` | 아니오 |  | 검증된 장치 상태 발생 시각; energy 순서·cursor/checkpoint 기준 |
| `bioControlMode` | `String?` | 아니오 | `sensor`, `force-off`, `force-on` 또는 `NULL` CHECK | 마지막 수락 BIO presence의 제어 모드. `sensor`는 실제 LED 출력 상태를 뜻하지 않음 |
| `bioConfiguredBrightness` | `Int?` | 아니오 | `NULL` 또는 CHECK `0..100` | BIO high-brightness GET의 변환 가능한 설정값. 실제 출력 밝기가 아님 |
| `bioRawHighBrightness` | `Int?` | 아니오 | `NULL` 또는 CHECK `0..255` | BIO high-brightness GET이 반환한 원시 1-byte 값 |
| `lastPresenceEventId` | `String?` | 아니오 | Unique; presence checkpoint 3개가 함께 `NULL`이거나 모두 non-`NULL`인 CHECK | 마지막 적용 `fixture-presence` MQTT v2 이벤트 ID |
| `lastPresenceSequence` | `BigInt?` | 아니오 | 위 checkpoint CHECK에 포함 | 마지막 적용 presence gateway sequence |
| `lastPresenceOccurredAt` | `DateTime?` | 아니오 | 위 checkpoint CHECK에 포함 | 마지막 적용 presence 장치 관측 시각; 에너지 checkpoint에는 사용하지 않음 |
| `statusReason` | `String?` | 아니오 |  | 고정 운영 상태의 근거; freshness가 fixture_stale/gateway_offline으로 변경 가능 |
| `healthFaultCodes` | `Json?` | 아니오 | JSON number 배열 | 마지막 BLE Mesh Health Current의 정규화된 8비트 fault code 목록 |
| `healthLastSeenAt` | `DateTime?` | 아니오 |  | 마지막 BLE Mesh Health Current 관측 시각 |
| `energyTrackingStartedAt` | `DateTime` | 예 | `now()` | 상태 기반 에너지 추적을 시작한 시각. 기존 조명은 foundation migration 적용 시각 |
| `firstStateOccurredAt` | `DateTime?` | 아니오 |  | 첫 수락된 fixture-state 발생 시각 |
| `powerOn` | `Boolean?` | 아니오 |  | 마지막 수락된 전원 상태 snapshot |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

관계:

- `floor`: `Floor`
- `meshNode`: `MeshNode?`
- `lightSlot`: `FloorLightSlot?`
- `groupFixtures`: `GroupFixture[]`
- `energyUsages`: `EnergyUsage[]`
- `energyDailyAggregates`: `FixtureEnergyDailyAggregate[]`

운영 메모:

- `Floor`는 `(id, siteId)`, `MeshNode`는 `(id, gatewayId)` Unique를 제공한다. Fixture는 `(id, siteId, gatewayId)`와 `(meshNodeId, gatewayId)` Unique, `(floorId, siteId)` index를 가진다.
- `Fixture_mesh_owner_shape_check`는 `meshNodeId/gatewayId`가 함께 값이 있거나 함께 `NULL`이도록 강제한다. Trigger는 INSERT와 owner 필드 UPDATE에서 Floor/MeshNode의 실제 owner를 파생하고 caller가 직접 준 불일치 값을 거부한다. Floor Site 또는 MeshNode Gateway 변경은 composite FK `ON UPDATE CASCADE`로 Fixture projection에 전달되며, automation join이 Fixture owner key를 참조 중이면 그 join의 `ON UPDATE RESTRICT` FK가 전체 owner 변경을 거부한다.
- `rssi`, `hopCount`, `commandSuccessRate`, `lastSeenAt`은 장기 이력 테이블이 아니라 최신 모니터링 snapshot이다. 수락된 fixture-state 또는 fixture-presence는 `lastSeenAt = API receivedAt`으로 저장하므로 미래 장비 시계가 stale 판정을 지연시키지 못한다. 반면 `lastStateOccurredAt`은 검증된 실제 상태 `occurredAt`을 보존해 에너지 순서·cursor/checkpoint에만 사용한다.
- `20260918120000_bio_fixture_presence_polling` migration은 Site 기본 stale 값과 기존 기본값 `180`을 `1200`으로 올리되, 사용자가 따로 정한 다른 값은 보존한다. 같은 migration은 위 BIO metadata 3개와 presence checkpoint 3개를 추가한다. 모드·밝기·원시값 범위와 checkpoint의 all-null/all-present 형태는 SQL CHECK로 강제하고 event ID에는 unique index를 둔다.
- `fixture-presence` ingestion은 `lastSeenAt`, RSSI/hop과 BIO metadata/checkpoint만 갱신한다. freshness가 만든 `fixture_stale` 또는 `gateway_offline` 상태만 보고된 상태로 복원할 수 있으며, `brightness`, `powerOn`, `firstStateOccurredAt`, 실제 state checkpoint, 에너지 cursor 및 일·시간 집계는 절대 변경하지 않는다.
- `healthFaultCodes`, `healthLastSeenAt`도 이력 테이블이 아닌 최신 Health Current snapshot이다. fault code `0x00`은 제거하고 나머지는 중복 제거·오름차순 정렬해 저장한다. 유효한 Health Current를 아직 받지 못했거나 JSON이 유효하지 않으면 API는 `확인 대기`로 응답한다.
- `20260819092000_add_fixture_health_snapshot` migration은 기존 조명에 두 컬럼을 nullable로 추가한다. 따라서 migration 직후 기존 조명은 첫 Health Current 수신 전까지 `확인 대기` 상태다.
- `20260912110000_fixture_reported_state`는 reported 두 컬럼을 additive로 만들고 기존 status/statusReason을 복사한 뒤 reportedStatus를 NOT NULL/default offline으로 설정한다. 운영 상태·수신 시각·updatedAt은 변경하지 않는다. 과거에 freshness가 덮어쓴 장비 보고는 추정 복원하지 않으며 새 수락 보고부터 정확히 보존한다. 배포 시 migration 후 모든 수집 API를 새 버전으로 교체해야 하고 구버전 writer와 장기 혼용하지 않는다.
- 새 수락 fixture-state는 reportedStatus에 wire status, reportedStatusReason에 보고 사유(생략 시 reported)를 저장하고 operational status/reason도 함께 갱신한다. operational status의 기존 Health 정규화는 유지한다. 모니터링 응답·summary는 reported 상태 + Site threshold + Health snapshot으로 계산하고, controllable/controlBlockReason은 고정 운영 상태로 계산한다.
- provisioning 완료는 status/reportedStatus를 offline, statusReason/reportedStatusReason을 provisioning_waiting_state, brightness를 0, lastSeenAt을 null로 만든다. 이 값은 실제 장비 offline 판정이 아니라 첫 실제 상태를 아직 받지 못한 미확정 상태다.
- 첫 MQTT `fixture-state` event가 도착할 때만 online/fault/offline 상태, 밝기, RSSI, hop, lastSeenAt과 `statusReason`을 실제 관측값으로 확정한다. API는 packet 수신 시작 시각을 한 번 고정하고 `occurredAt <= receivedAt + 300,000ms`(정확한 경계 포함)만 수락한다. 이보다 1ms라도 미래인 event는 원장에 terminal rejection만 남기고 Fixture snapshot·에너지 cursor·aggregate에는 접근하지 않는다.
- freshness worker는 `provisioning_waiting_state`를 gateway offline과 fixture stale 재집계에서 제외한다. 첫 실제 `fixture-state`가 status reason을 보고값으로 바꾼 뒤에는, 보고된 `offline`을 포함해 일반 freshness 규칙을 적용한다.
- `(floorId, id)` 복합 인덱스는 층별 fixture snapshot의 ID cursor 페이지 조회에 사용한다.
- 일반 조명 조회는 200개 단위 ID cursor를 사용하며 시리얼·device UUID·Mesh 주소·펌웨어 버전을 노출하지 않는다. 해당 제조 식별 정보는 admin `manage` 권한 전용 설정 endpoint에서만 200개 단위 ID cursor로 조회한다.
- admin의 조명 이름·정격전력 수정은 Fixture 행을 잠근 뒤 transaction 안에서 권한과 `expectedUpdatedAt`을 다시 확인한다. stale 요청은 `409 settings_version_conflict`로 거부한다. 정격전력 변경은 기존 에너지 checkpoint를 닫고, 이름 또는 정격전력 변경은 같은 시각의 에너지 dimension 이력을 기록한다.

### FixtureGroup

조명 그룹 또는 구역이다. legacy 그룹을 격리하고, 신규 제어 구역은 하나의 층과 Gateway 경계에 고정한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 그룹 ID |
| `siteId` | `String` | 예 | FK -> `Site.id` | 소속 현장 |
| `floorId` | `String?` | 아니오 | FK -> `Floor.id`, active면 필수 | 제어 대상 층 |
| `gatewayId` | `String?` | 아니오 | FK -> `Gateway.id`, active면 필수 | 제어 대상 Gateway |
| `name` | `String` | 예 |  | 그룹명 |
| `lifecycleStatus` | `FixtureGroupLifecycleStatus` | 예 | `active` | `active`, `retiring`, `retired`, `invalid`. legacy backfill 불가 그룹은 `invalid` |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

관계:

- `site`: `Site`
- `floor`: `Floor?`
- `gateway`: `Gateway?`
- `groupFixtures`: `GroupFixture[]`

제약과 migration:

- `20260826_menu_completion_foundation`은 legacy group의 모든 member가 같은 site의 한 floor와 한 Gateway MeshNode에 속할 때만 `floorId`, `gatewayId`를 backfill하고 `active`로 전환한다. 빈 그룹, 경계가 섞인 그룹, MeshNode가 없는 조명을 포함한 그룹은 `invalid`로 남긴다.
- PostgreSQL check는 `active` group에 non-null `floorId`, `gatewayId`를 요구한다. deferred constraint trigger는 active group의 site 경계, member floor/Gateway 일치, 빈 group 금지와 조명 하나당 active 또는 retiring group 최대 15개를 commit 시점에 강제한다.
- `retiring`, `retired`, `invalid` group은 제어 대상으로 조회하거나 명령을 보내면 안 된다.

### GroupFixture

`FixtureGroup`과 `Fixture`의 N:M 연결 테이블이다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `groupId` | `String` | 예 | PK 복합키, FK -> `FixtureGroup.id` | 그룹 ID |
| `fixtureId` | `String` | 예 | PK 복합키, FK -> `Fixture.id` | 조명 ID |

제약:

- 복합 PK: `groupId`, `fixtureId`

관계:

- `group`: `FixtureGroup`
- `fixture`: `Fixture`

### Gateway

현장에 설치된 라즈베리파이 게이트웨이다. BLE Mesh와 클라우드 사이의 연결 지점이다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 게이트웨이 ID |
| `siteId` | `String` | 예 | FK -> `Site.id` | 소속 현장 |
| `name` | `String` | 예 |  | 게이트웨이 이름 |
| `serialNumber` | `String` | 예 | Unique | 게이트웨이 시리얼 |
| `firmwareVersion` | `String` | 예 |  | 펌웨어 버전 |
| `lastHeartbeatAt` | `DateTime?` | 아니오 |  | API가 마지막 수락 heartbeat를 받은 서버 수신 시각; gateway freshness 기준 |
| `certificateFingerprint` | `String?` | 아니오 | Unique | claim된 장치 인증서 SHA-256 fingerprint |
| `assignmentVersion` | `Int` | 예 | `0` | gateway bootstrap 설정 버전 |
| `nextCommandSequence` | `BigInt` | 예 | `0` | 다음 명령 dispatch sequence 예약용 카운터 |
| `nextMeshUnicastAddress` | `Int` | 예 | `256` (`0x0100`) | 다음에 예약할 BLE Mesh unicast 주소 |
| `nextMeshGroupAddress` | `Int` | 예 | `49152` (`0xC000`) | 다음에 예약할 BLE Mesh group address |
| `claimedAt` | `DateTime?` | 아니오 |  | 현장 claim 완료 시각 |
| `lastHeartbeatEventId` | `String?` | 아니오 | Unique | 마지막 heartbeat 이벤트 ID |
| `lastHeartbeatSequence` | `BigInt?` | 아니오 |  | 마지막 heartbeat sequence |
| `lastHeartbeatOccurredAt` | `DateTime?` | 아니오 |  | 검증된 장치 heartbeat 발생 시각 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

관계:

- `site`: `Site`
- `inventory`: `GatewayInventory?`
- `meshNodes`: `MeshNode[]`
- `meshControlGroups`: `MeshControlGroup[]`
- `provisioningSessions`: `ProvisioningSession[]`
- `certificates`: `GatewayCertificate[]`

운영 메모:

- `connectionStatus`는 DB 컬럼이 아니라 `lastHeartbeatAt` 기준으로 API에서 계산한다. heartbeat도 동일한 5분 미래 허용 경계를 거치며, 수락 시 서버 `receivedAt`과 장치 `occurredAt`을 각각 `lastHeartbeatAt`/`lastHeartbeatOccurredAt`에 분리 저장한다.
- Mesh 주소는 등록 transaction에서 `Gateway` 행을 `FOR UPDATE`로 잠근 뒤 연속 범위로 예약한다. 실제 할당 범위는 `0x0001~0x7fff`이며 카운터가 `0x8000`이면 주소가 소진된 상태다.
- `20260819090000_add_registration_allocators` migration은 기존 `MeshNode.meshAddress`의 최댓값 다음으로 카운터를 보정하되, 신규 주소 기본 시작점 `0x0100`보다 낮추지 않아 기존 노드와의 충돌을 방지한다.
- `nextMeshGroupAddress`는 floor/저장 구역용 영속 Mesh group address allocator다. 제어 group 생성 transaction은 `Gateway` 행을 `FOR UPDATE`로 잠그고, 증가 전 값을 실제 할당 주소로 사용한다. 유효 범위는 `0xC000~0xFEFF`이고 `0xFF00` 이상이면 명시적으로 소진 오류를 반환한다.
- `20260819093000_add_mesh_control_groups` migration은 기존 gateway에 `nextMeshGroupAddress = 0xC000` 기본값을 추가하고, group 메타데이터를 별도 테이블로 분리한다.

### GatewayInventory / GatewayClaimAudit

`GatewayInventory`는 제조 또는 출고 시 등록된 장비 identity 원장이다. `serialNumber`, 일회성 `claimCodeHash`, 선택적인 장치 인증서 `certificateFingerprint`, claim 결과인 `claimedGatewayId/claimedAt`, 폐기 상태 `disabledAt`을 저장한다. claim code 원문과 인증서 private key는 DB와 Git에 저장하지 않는다.

`certificateFingerprint`는 device enrollment 전에는 `NULL`이다. 제조 흐름은 token/Claim Code hash를 먼저 저장하고, CSR 서명이 성공하면 device `GatewayCertificate` 생성과 `GatewayInventory.certificateFingerprint` 확정을 하나의 transaction으로 처리한다. placeholder fingerprint는 사용하지 않는다.

인증서 fingerprint의 canonical 원장은 `GatewayCertificate.fingerprint`다. `GatewayInventory.certificateFingerprint`와 `Gateway.certificateFingerprint`는 별도 원장이 아니라 현재 active device 인증서를 가리키는 호환용 pointer다. 기존 bootstrap/claim 경로가 이 pointer를 사용하므로 제거하지 않으며, device 인증서 발급·교체 transaction은 canonical 원장과 두 pointer를 함께 갱신한다. MQTT 인증서 fingerprint는 이 pointer에 기록하지 않는다.

`GatewayClaimAudit`는 성공·실패 claim 시도의 inventory/site/user, serial, outcome, reason, IP, 시각을 기록한다. Claim 성공 transaction은 `GatewayInventory.claimCodeHash`를 `null`로 폐기해 재사용을 차단한다.

`GatewayInventory`는 `certificates` 관계로 장비에 발급된 device/MQTT 인증서 metadata를 조회한다. 인증서가 한 건이라도 연결된 inventory의 hard delete는 FK `RESTRICT`로 차단한다. 운영 중 inventory는 삭제하지 않고 `disabledAt`을 설정해 비활성화하며, 폐기/재발급 감사 원장을 보존한다. claim된 `Gateway`를 삭제하는 경우에는 인증서 이력을 유지하고 `gatewayId`만 `NULL`이 된다.

### GatewayEnrollment

제조 스테이션이 게이트웨이 최초 장치 인증서를 발급할 때 사용하는 15분 수명의 일회성 enrollment 기록이다. token은 `<enrollment UUID>.<256-bit random secret>` 형식이며 원문은 응답 시 한 번만 전달한다. DB에는 UUID를 `id`로 명시하고 secret의 salted scrypt hash만 `tokenHash`에 저장한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | enrollment ID |
| `serialNumber` | `String` | 예 |  | 대상 게이트웨이 제조 시리얼 |
| `tokenHash` | `String` | 예 | Unique | token secret의 salted scrypt hash |
| `expiresAt` | `DateTime` | 예 |  | token 만료 시각 |
| `usedAt` | `DateTime?` | 아니오 |  | 최초 사용 완료 시각. 값이 있으면 재사용 금지 |
| `stationIdentity` | `String` | 예 |  | 제조 요청을 인증한 station 인증서 identity |
| `outcome` | `String?` | 아니오 |  | 발급 결과 상태 |
| `failureReason` | `String?` | 아니오 |  | 실패 시 보안 감사용 사유 코드 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |

제약:

- Unique: `tokenHash`
- PostgreSQL partial unique: `serialNumber WHERE usedAt IS NULL`
- Index: `serialNumber`, `createdAt`
- 원문 enrollment token, secret, 빠른 lookup digest는 DB, 로그, Git에 저장하지 않는다.

상태 전이:

- 제조 station이 새 enrollment를 만들면 UUID와 256-bit secret을 생성하고 secret의 salted scrypt hash 및 `expiresAt = createdAt + 15분`만 저장한다. transaction에서 같은 serial의 이전 미사용 row를 `usedAt`과 `outcome = superseded`로 닫은 뒤 새 row를 생성한다. partial unique index 충돌은 원문 없는 `Conflict`로 반환한다.
- gateway는 token을 UUID와 secret으로 파싱하고 UUID로 row를 찾은 뒤 저장된 salted scrypt hash를 constant-time 비교한다. malformed token, unknown UUID, wrong secret은 모두 `enrollment token is not active`로 일반화한다.
- serial이 일치하고 미사용·미만료이며 `outcome IS NULL`이면 CSR 검증 전에 conditional update로 `usedAt`과 `outcome = processing`을 즉시 설정한다. 동시에 들어온 요청 중 이 update가 1건을 변경한 요청만 계속 진행한다.
- serial 불일치와 만료 요청도 `usedAt IS NULL AND outcome IS NULL` 조건부 update로 즉시 소비하고 `outcome = failed`, `failureReason = serial_mismatch` 또는 `token_expired`를 기록한다. 이 terminal row는 올바른 serial이나 같은 token으로 재사용할 수 없다.
- consume 이후 CSR, CA 서명, CA bundle 또는 DB 단계가 실패하면 `outcome = failed`와 원문 없는 failure code만 남긴다. `usedAt`은 되돌리지 않으며 제조 station이 새 enrollment를 발급해야 한다.
- CA가 인증서를 발급한 뒤 DB transaction이 실패하면 API는 best-effort revoke를 요청하고 `failureReason = persistence_failed`를 기록한다. revoke 자체의 오류 body는 저장하거나 반환하지 않는다.
- 성공 transaction은 device `GatewayCertificate`, `GatewayInventory.certificateFingerprint`, scrypt `claimCodeHash`, enrollment `outcome = issued`를 함께 반영한다. claim 전이므로 `GatewayCertificate.gatewayId`와 `Gateway.certificateFingerprint`는 갱신하지 않는다.

### GatewayCertificate

게이트웨이에 발급한 장치 bootstrap 인증서와 MQTT client 인증서의 수명주기 원장이다. 실제 인증서 PEM과 private key 대신 식별·폐기·교체에 필요한 metadata만 저장한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 인증서 원장 ID |
| `inventoryId` | `String` | 예 | FK -> `GatewayInventory.id`, delete restrict | 제조 장비 원장 ID |
| `gatewayId` | `String?` | 아니오 | FK -> `Gateway.id`, delete 시 set null | claim 후 연결된 서비스 게이트웨이 ID |
| `purpose` | `CertificatePurpose` | 예 | DB enum | 인증서 용도 |
| `certificateSerial` | `String` | 예 | issuer와 복합 Unique | CA가 발급한 인증서 serial |
| `fingerprint` | `String` | 예 | Unique | 인증서 SHA-256 fingerprint의 canonical 원장 |
| `issuer` | `String` | 예 |  | 발급 CA 식별자 |
| `notBefore` | `DateTime` | 예 |  | 유효 시작 시각 |
| `notAfter` | `DateTime` | 예 |  | 만료 시각 |
| `status` | `GatewayCertificateStatus` | 예 | DB enum | `active`, `pending`, `replaced`, `revocation_pending`, `revoked`, `expired` |
| `revokedAt` | `DateTime?` | 아니오 |  | 폐기 시각 |
| `replacedById` | `String?` | 아니오 | Unique self FK, delete restrict | 이 인증서를 교체한 새 인증서 ID |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

관계 및 삭제 정책:

- `inventory`: `GatewayInventory`. 인증서가 연결된 inventory의 hard delete를 `RESTRICT`로 차단한다.
- `gateway`: `Gateway?`. Gateway가 삭제되어도 인증서 감사 기록은 유지하고 FK만 `NULL`로 만든다.
- `replacedBy` / `replaces`: `GatewayCertificate?` self relation. 한 새 인증서는 최대 한 기존 인증서를 교체하며, 교체 대상으로 참조된 후속 인증서의 hard delete를 `RESTRICT`로 차단한다.

제약:

- Unique: `fingerprint`, `replacedById`, `issuer + certificateSerial`
- PostgreSQL partial Unique: `inventoryId` (`purpose = mqtt` 및 `status = active`인 행만 대상), `inventoryId` (`purpose = device` 및 `status = active`인 행만 대상), `inventoryId` (`purpose = device` 및 `status = pending`인 행만 대상)
- Check: `replacedById IS NULL OR replacedById <> id`로 자기 자신을 교체 대상으로 지정할 수 없다.
- Index: `inventoryId + purpose + status`, `gatewayId + purpose + status`

교체 transaction 계약:

- `GatewayCertificate.fingerprint`가 전체 인증서 이력의 canonical 값이다. `GatewayInventory`와 `Gateway`의 fingerprint는 active `device` 인증서 pointer이므로 lifecycle service가 같은 transaction에서 동기화한다.
- DB의 self-check와 unique 제약만으로는 cross-inventory, cross-purpose 또는 다중 노드 cycle을 완전히 차단할 수 없다.
- MQTT 인증서 발급은 inventory ID를 입력으로 한 PostgreSQL transaction-scoped advisory lock 안에서 실행한다. 같은 inventory의 동시 요청은 직렬화되며, 기존 active MQTT 인증서는 `replaced`로 전환한 뒤 새 active 행을 만들고 마지막에 기존 행의 `replacedById`를 새 ID로 연결한다. 세 단계는 하나의 transaction이므로 외부에는 원자적으로 보인다.
- partial Unique index는 위 서비스 잠금과 별도로 같은 inventory에 active MQTT 인증서가 둘 이상 남지 않도록 DB에서 강제한다. migration은 과거 중복 active 행이 있으면 가장 최근 행만 active로 남기고 나머지는 `replaced`로 정리한 뒤 index를 만든다.
- Device renewal은 active device 인증서가 만료 30일 안에 있을 때만 P-256 CSR을 server-fixed serial CN/URI SAN으로 서명하고 `pending` 인증서를 만든다. 최초 device 발급·MQTT 발급·renewal은 공통 inventory advisory/row와 certificate row 잠금 뒤 상태를 재조회하고, CA 서명 직후 독립 transaction으로 폐기 원장을 commit한 뒤 상태·pointer·Gateway 배정을 다시 확인한다. 성공 인증서 저장과 같은 transaction만 원장을 취소하며 rollback은 원장을 유지한다. 원장 자체를 만들지 못하면 즉시 best-effort 폐기하고 일반화된 오류로 실패한다. pending 인증서로 10분 안에 mTLS activation하면 같은 잠금 뒤 기존 active와 pending, Gateway 배정을 확인하여 두 pointer를 함께 바꾼다. grace를 넘긴 pending은 `revocation_pending`과 원장을 남겨 별도로 폐기하며 기존 active는 유지한다.
- Inventory disable은 active service-provider `operator` 전용이다. 같은 transaction에서 `disabledAt`, device/MQTT 인증서의 `revocation_pending`, inventory/Gateway pointer clear와 폐기 원장을 확정해 즉시 인가를 차단한다. commit 뒤 worker가 CA 폐기와 CRL 배포를 재시도하며 외부 실패 시 일반화된 pending 오류를 반환한다. Site 삭제도 모든 inventory ID와 certificate row를 정렬 잠금한 뒤 같은 staging을 수행하므로 Gateway cascade 후에도 폐기 의무가 남는다.
- Task 27/29 lifecycle service는 같은 transaction 안에서 기존/후속 인증서가 동일한 `inventoryId`와 `purpose`인지 확인하고, 기존 교체 체인을 잠금 조회해 cycle이 생기지 않는지 검증한 뒤 `replacedById`와 상태를 함께 갱신해야 한다.
- revoke 대상은 `purpose + issuer + certificateSerial + fingerprint`로 식별해 CA 교체나 serial 충돌 상황에서도 모호하지 않게 한다.

### CertificateRevocationReconciliation

CA 서명 직후 인증서 DB 저장 실패·process crash와 논리적 폐기 후 외부 CA/CRL 장애를 회수하는 영속 원장이다. `20260915090000_certificate_revocation_reconciliation` additive migration으로 추가하며, 인증서·inventory·현장 삭제 후에도 의무가 남도록 FK를 두지 않는다. 완료·취소 행도 삭제하지 않는다.

| 컬럼 | 타입·제약 | 의미 |
| --- | --- | --- |
| `id` | String PK, uuid | 원장 ID |
| `inventoryId`, `certificateId` | String, certificateId nullable, FK 없음 | 대상 식별 metadata |
| `purpose`, `issuer`, `certificateSerial`, `fingerprint` | purpose DB enum, issuer+serial Unique, fingerprint Unique | PEM 없는 CA 폐기 대상과 두 멱등성 키 |
| `source` | String | `signed_certificate` 또는 `inventory_revocation`으로 정제 |
| `attempts`, `nextAttemptAt` | Int 기본 0, DateTime 기본 now | 임대 횟수와 다음 처리 시각 |
| `leaseOwner`, `leaseExpiresAt` | nullable String / DateTime | claim마다 새 owner와 300초 임대 |
| `revokedAt`, `completedAt`, `cancelledAt` | nullable DateTime | CA 폐기 성공, CRL 배포 완료, 정상 인증서 저장에 따른 취소 |
| `lastError` | nullable String | CA/CRL 실패 코드만 저장 |
| `createdAt`, `updatedAt` | DateTime | 생성·갱신 시각 |

- 처리 인덱스는 `completedAt + cancelledAt + nextAttemptAt + leaseExpiresAt`, 조회 인덱스는 `inventoryId`다.
- `armSignedCertificate`는 별도 transaction으로 metadata만 commit하며 처리 유예는 180초다. 발급 소비 경로는 공통 `CERTIFICATE_TRANSACTION_TIMEOUT_MS = 140000`을 사용하고, 인증서 저장과 같은 transaction에서 `cancelSignedCertificate`를 호출해야 한다. 이미 임대·폐기·완료된 원장의 취소는 저장을 거부한다.
- Worker는 시작 시와 30초마다 `FOR UPDATE SKIP LOCKED`로 due 원장을 하나씩 claim한다. CA 폐기는 DB transaction 밖에서 실행하고 결과는 owner와 아직 유효한 lease로 fence한다. CA 성공을 먼저 기록하므로 CRL 실패는 CA를 다시 폐기하지 않고 CRL만 재시도한다. 30초부터 최대 1시간 지수 backoff로 무기한 재시도하며, CRL 배포 경로가 없으면 완료하지 않는다.
- CRL read → publish → 완료 저장은 목적별 PostgreSQL advisory lock을 가진 최대 15분 transaction에서 실행한다. 두 int key의 첫 값은 예약 namespace `0x504b4943`(`PKIC`), 둘째 값은 device `1` / mqtt `2`다. 이 공간은 inventory의 bigint advisory key와 별개이며 서로 다른 purpose는 직렬화하지 않는다. 잠금 대기는 최대 10초다. CA read 뒤 매 publish 직전에 transaction 유효성과 owner/lease를 다시 조회하고, publish 뒤 CA를 다시 읽어 snapshot이 달라졌으면 최신 snapshot을 재배포한다. 최대 3회 배포·검증(최초 조회 포함 최대 4회 CA read)까지만 시도하며 계속 달라지면 미완료/backoff로 남긴다. publication I/O 중에는 inventory/certificate row lock을 잡지 않으며 완료 직전에 공통 row lock 순서를 적용한다.
- Vault read의 요청별 상한 120초에 따라 최대 네 번의 네트워크 요청 예산은 8분이다. 15분은 네트워크 요청·인증 토큰/파일 I/O·DB 작업을 합친 transaction 예산이며 파일시스템 호출의 엄격한 상한이 아니다. 5분 row lease 이후에도 살아 있는 transaction은 purpose 잠금을 유지한다. 여러 I/O의 누적 지연이 이 예산을 넘거나 DB session이 유실되면 이미 시작한 publish가 잠금 해제 뒤까지 계속될 수 있다. Prisma가 외부 I/O를 취소하지 못하는 이 경계는 개별 파일 호출이 15분보다 짧아도 발생할 수 있으며 운영 위험으로 남는다.
- 공통 잠금 순서는 inventory advisory lock → inventory row → ID 순 certificate rows → Gateway다. `stageInventoryRevocation`은 같은 transaction에서 inventory pointer를 비우고 미폐기 인증서를 `revocation_pending`으로 바꾸며 이전 정상 발급의 취소 원장도 다시 연다. Gateway pointer와 `disabledAt` 변경은 소비 경로가 같은 transaction에서 담당한다.
- 업그레이드 전 `GatewayCertificate.status = revoked`는 CRL 배포 완료를 증명하지 못하므로 완료 판단은 `CertificateRevocationReconciliation.completedAt`을 기준으로 한다. 원장이 없는 legacy revoked 인증서를 disable/revoke 재시도에서 만나면 기존 `status`와 `revokedAt`을 유지하면서 원장 하나를 생성해 CA 폐기·CRL 배포를 안전하게 다시 수행한다. CA 성공 뒤 CRL만 실패하면 같은 원장으로 CRL만 재시도하고, 완료 후 반복 호출은 새 작업이나 추가 CA/CRL 호출을 만들지 않는다. 전체 legacy backfill을 실행하지 않고 해당 inventory 처리 시 복구한다.
- Task 2~3에서 실제 issue/renew/activate/disable 및 Site 삭제 경로를 연결하고 기존 manufacturing → claim → bootstrap → MQTT E2E와 revoked/disabled 거부를 유지했다. 전용 disposable PostgreSQL 16에 전체 57 migration을 적용하고 별도 Prisma connection과 CA barrier로 양방향 경쟁, `pg_stat_activity`/`pg_locks`의 동일 advisory key 대기, 동시 MQTT 발급의 CA 서명 비중첩, 정상 renewal → activation, disabled 이후 active/pending 0·pointer null·영속 원장, rollback 뒤 새 worker의 폐기를 검증했다. PostgreSQL connection·migration·transaction·lock·원장 저장은 실제이고 CA·CSR 검증·CRL 파일 배포는 fixture다. 사용자 로컬 DB migration과 실제 Vault/CRL 배포·장비/HIL은 실행하지 않았다. 원장 저장과 즉시 CA 폐기가 동시에 실패하는 구간은 CA 측 발급 감사/재조회 없이 완전히 회수할 수 없다.

보안 저장 정책:

- 인증서 PEM, device/MQTT private key, enrollment token 원문, Claim Code 원문은 이 테이블을 포함한 어떤 DB 테이블에도 저장하지 않는다.
- private key는 해당 Raspberry Pi 내부에서 생성하고 장비의 identity volume에만 권한 `0600`으로 보관한다.
- DB 원장은 인증서 조회, rotation, revoke와 감사에 필요한 metadata만 보관한다.

### MeshNode

ESP32-H2 BLE Mesh 노드다. 한 노드는 최대 하나의 `Fixture`와 매핑된다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 메시 노드 ID |
| `gatewayId` | `String` | 예 | FK -> `Gateway.id` | 연결 게이트웨이 |
| `deviceUuid` | `String?` | 아니오 | Unique | BLE Mesh device UUID |
| `serialNumber` | `String?` | 아니오 |  | 장비 시리얼 |
| `meshAddress` | `String` | 예 | Unique with `gatewayId` | BLE Mesh unicast address |
| `firmwareVersion` | `String` | 예 |  | 노드 펌웨어 버전 |
| `vehicleSensorCapabilityStatus` | `VehicleSensorCapabilityStatus` | 예 | `unknown` | 차량 감지 source capability 상태 |
| `vehicleSensorCapabilityVerifiedAt` | `DateTime?` | 아니오 | capability coherence DB CHECK | 모델 capability 검증 시각 |
| `vehicleSensorCapabilityRevision` | `BigInt` | 예 | `0`, capability coherence DB CHECK | Gateway가 영속 관리하는 capability 단조 revision |
| `vehicleSensorServerBound` | `Boolean` | 예 | `false`, capability coherence DB CHECK | SIG Sensor Server 모델 바인딩 여부 |
| `vehicleVendorEventModelBound` | `Boolean` | 예 | `false`, capability coherence DB CHECK | vendor vehicle event 모델 바인딩 여부 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

제약:

- Unique: `deviceUuid`
- 복합 Unique: `id`, `gatewayId`
- 복합 Unique: `gatewayId`, `meshAddress`
- `unknown`은 revision `0`, 검증 시각 `NULL`, 두 model flag `false`인 초기 상태로만 존재한다. `supported`는 양수 revision, 검증 시각, 두 model flag `true`를 모두 요구한다. `unsupported`는 양수 revision과 model flag 하나 이상 `false`를 항상 요구하며 검증 시각 유무로 이 조건을 우회할 수 없다.
- 최초 capability migration은 모든 기존 노드를 fail-closed `unknown`/`NULL`로 만들었다. ordering migration은 그 뒤 운영자가 검증한 기존 `supported`/`unsupported`를 baseline revision `1`로, 기존 `unknown`을 revision `0`으로 backfill한다. 차량 이벤트 CRUD source resolver는 `supported`이면서 검증 시각과 두 model flag가 모두 유효한 등록 Fixture만 허용한다.
- capability 변경은 strict `VehicleSensorCapabilityReportV1`만 API service 경계에서 받는다. report topic은 `sites/{siteId}/gateways/{gatewayId}/events/automation/vehicle-sensor-capability`이고 payload는 `schemaVersion=1`, UUID `eventId/siteId/gatewayId/meshNodeId`, positive safe integer `capabilityRevision`, `supported|unsupported` status, offset 포함 ISO instant `verifiedAt`, `sensorServerBound`, `vendorVehicleEventModelBound`를 가진다. `supported`는 두 model flag가 모두 true일 때만 유효하고 `unsupported`는 하나 이상 false여야 한다.
- `VehicleSensorCapabilityService.applyReport`는 complete report를 canonical JSON으로 직렬화해 `sha256:<64 lowercase hex>`를 만들고 공통 automation global lock을 첫 DB 작업으로 획득한 뒤 Gateway와 MeshNode를 `FOR UPDATE`로 잠그며 Site/Gateway/MeshNode owner scope를 식별자 비노출 오류로 검증한다. 전역 PK `eventId`와 node-local `(gatewayId, meshNodeId, capabilityRevision, vehicle_sensor_capability)`를 함께 dedupe한다. 동일 key/hash는 `duplicate`, 낮은 새 revision은 원장만 남기고 `stale`, 동일 revision의 state/hash 불일치와 동일 key의 다른 hash는 mutation 없이 `rejected`, 높은 revision만 `applied`다. 같은 Gateway의 서로 다른 두 node는 revision `1`을 순차 또는 동시에 각각 저장할 수 있다.
- migration으로 revision `1`이 된 node에 capability 원장이 아직 없으면, report의 status, DB millisecond 정밀도로 정규화한 `verifiedAt`, 두 model flag가 현재 row와 모두 같을 때 node-scoped 원장을 보강하고 `duplicate`로 분류한다. 하나라도 다르면 `capability_state_conflict`로 거부하며 capability metadata나 automation revision은 바꾸지 않는다.
- 높은 `supported` report는 capability metadata만 갱신한다. 높은 `unsupported` report는 같은 transaction에서 해당 node Fixture를 source로 쓰는 모든 enabled rule을 먼저 disabled로 바꾸고, 하나 이상 바뀐 경우에만 `AutomationSnapshotService`로 complete Gateway snapshot/outbox와 automation revision을 정확히 하나 만든 뒤 metadata를 저장한다. replay, stale, conflict는 automation revision을 만들지 않는다.
- ACK topic은 `sites/{siteId}/gateways/{gatewayId}/acks/automation/vehicle-sensor-capability-ingested`다. strict `VehicleSensorCapabilityIngestedAckV1`은 report의 `eventId/gatewayId/meshNodeId/capabilityRevision`, 필수 `reportPayloadHash=sha256:<64 lowercase hex>`, `applied|stale|duplicate|rejected`, nullable `errorCode`, API `ingestedAt`을 담는다. Service는 분류와 같은 transaction에서 `applicationAckKey=vehicle-sensor-capability:<gatewayId>:<meshNodeId>:<eventId>:<reportPayloadHash>`인 `MqttOutbox` ACK row를 생성한다. 같은 Gateway의 cross-node eventId 재사용과 same-node altered payload는 각각 incoming report hash의 별도 rejected ACK row를 만들고 capability/automation state와 원본 ACK를 변경하지 않는다. 각 exact report hash의 재전달은 최초 저장 ACK payload, outbox payload hash와 `ingestedAt`을 그대로 반환한다. 해당 ACK row가 이미 published 또는 deadletter이거나 publisher lease가 만료됐으면 attempts와 delivery/error/lock 필드만 원자 초기화해 즉시 재큐잉하고, `leaseExpiresAt > now`인 active publisher lease는 건드리지 않는다. owner scope 위조는 tenant-neutral 오류로 ACK 생성 전에 실패할 수 있다. Task 9는 인증된 MQTT consumer와 저장 ACK exact publisher를 구현하고 Task 14는 실제 모델 바인딩, report journal/publish와 hash-aware terminal matching을 연결한다.

관계:

- `gateway`: `Gateway`
- `fixture`: `Fixture?`
- `processedEvents`: `ProcessedGatewayEvent[]`
- `controlGroupMemberships`: `MeshControlGroupMember[]`

등록 동시성 계약:

- `deviceUuid`의 전역 Unique 제약은 다른 현장에서 같은 BLE Mesh UUID를 등록하거나 두 provisioning transaction이 동시에 같은 UUID를 생성하는 것을 DB에서 차단한다.
- provisioning 완료 transaction은 기존 UUID가 다른 `gatewayId`에 속하면 Fixture를 만들지 않고 해당 `DiscoveredMeshNode`를 실패로 전환한다. 사전 조회 뒤 경쟁으로 `P2002`가 발생해도 Prisma `meta.target`이 `deviceUuid` unique를 가리킬 때만 아직 provisioning 중인 동일 session/node을 조건부 실패 처리한다. `gatewayId + meshAddress` 같은 다른 unique 또는 transaction 오류는 재전파하므로 잘못된 UUID conflict/409으로 바꾸지 않는다.

### MeshControlGroup

Gateway별 층/저장 구역 제어용 BLE Mesh group address를 영속 저장하는 테이블이다. `targetType`, `targetId`는 다형 대상 구조이므로 DB FK로 직접 강제하지 않고 서비스 계층에서 gateway와 같은 site 소속인지 검증한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 제어 group ID |
| `gatewayId` | `String` | 예 | FK -> `Gateway.id`, delete cascade | 소유 gateway |
| `targetType` | `MeshControlTargetType` | 예 | DB enum | `floor` 또는 `fixture_group` |
| `targetId` | `String` | 예 | Unique with `gatewayId`, `targetType` | 제어 대상 ID |
| `groupAddress` | `String` | 예 | Unique with `gatewayId` | BLE Mesh group address (`0xC000~0xFEFF`) |
| `status` | `MeshControlGroupStatus` | 예 | `configuring` | 구성 상태 |
| `configurationVersion` | `Int` | 예 | `1` | gateway ACK 기준 control group 구성 버전 |
| `operationPlanVersion` | `Int` | 예 | `0` | expected operation plan을 생성 완료한 구성 버전. 빈 계획도 현재 version으로 기록 |
| `fullReconciliationRequired` | `Boolean` | 예 | `false` | gateway state-loss 뒤 cloud snapshot 기반 full-state Add/Delete가 exact ACK로 수렴할 때까지 유지하는 복구 flag |
| `lastError` | `String?` | 아니오 |  | 마지막 구성 실패 사유 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

제약:

- 복합 Unique: `gatewayId`, `targetType`, `targetId`
- 복합 Unique: `gatewayId`, `groupAddress`

관계:

- `gateway`: `Gateway`
- `members`: `MeshControlGroupMember[]`
- `expectedOperations`: `MeshControlGroupExpectedOperation[]`
- `appliedMembers`: `MeshControlGroupAppliedMember[]`

운영 메모:

- 같은 `gatewayId + targetType + targetId` 재호출은 기존 row를 반환하며 새 주소를 소비하지 않는다.
- target 생성은 `INSERT ... ON CONFLICT (gatewayId, targetType, targetId) DO NOTHING RETURNING`을 사용한다. concurrent winner가 있어도 PostgreSQL interactive transaction을 abort시키지 않고 같은 transaction에서 winner를 다시 조회한다.
- lifecycle 값 `retiring`, `retired`는 desired subscription 삭제가 끝날 때까지 group 명령을 차단한다.
- `first_run`, `state_missing`, `state_corrupt` resync는 `fullReconciliationRequired = true`와 새 configuration version을 같은 transaction에서 기록한다. 현재 version의 exact ACK가 ready 또는 retired로 수렴할 때만 false로 되돌린다.
- configuring 상태에서 desired member가 실제 추가되는 경우에도 version을 증가시킨다. 이전 expected operation row는 과거 version 이력으로 남고 지연 ACK는 current-version row lock 조건에서 무시된다.

### MeshControlGroupMember

개별 Mesh node에 특정 control group subscription을 적용해야 하는 상태를 저장하는 테이블이다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `groupId` | `String` | 예 | PK 복합키, FK -> `MeshControlGroup.id`, delete cascade | 제어 group ID |
| `gatewayId` | `String` | 예 | group/node와 compound FK | group과 node가 속한 gateway ID |
| `meshNodeId` | `String` | 예 | PK 복합키, FK -> `MeshNode.id`, delete cascade | 대상 Mesh node ID |
| `subscriptionStatus` | `MeshControlGroupMemberSubscriptionStatus` | 예 | `pending` | member subscription ACK 적용 상태 |
| `desired` | `Boolean` | 예 | `true` | cloud 정본이 이 node의 subscription을 원하는지 여부 |
| `appliedVersion` | `Int` | 예 | `0` | node에 실제 반영된 group configuration version |
| `statusVersion` | `Int` | 예 | `0` | 마지막 subscription result가 반영된 group configuration version |
| `operationId` | `String?` | 아니오 | UUID | 현재 Add/Delete reconciliation operation 식별자 |
| `operation` | `MeshControlGroupMemberOperation?` | 아니오 | `add`, `delete` | 현재 reconciliation 동작 |
| `lastError` | `String?` | 아니오 |  | 마지막 subscription 실패 사유 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

제약:

- 복합 PK: `groupId`, `meshNodeId`
- 보조 Index: `groupId`, `gatewayId`
- 보조 Index: `meshNodeId`, `gatewayId`

관계:

- `group`: `MeshControlGroup`
- `meshNode`: `MeshNode`

운영 메모:

- `appliedVersion = 0`은 아직 gateway ACK로 subscription이 확인되지 않았음을 뜻한다.
- `statusVersion = 0`은 아직 어떤 subscription result version도 반영되지 않았음을 뜻한다.
- `MeshControlGroupMember`는 `(groupId, gatewayId)`와 `(meshNodeId, gatewayId)` compound FK를 사용해 서로 다른 gateway의 group/node 연결을 DB에서 차단한다.
- child 쪽 `groupId + gatewayId`, `meshNodeId + gatewayId`는 unique가 아니라 일반 index다. 따라서 한 control group에 여러 node membership을 둘 수 있고, 한 node도 같은 gateway 안에서 floor group과 fixture group membership을 함께 가질 수 있다.
- `operationId`와 `operation`은 이전 migration과 member aggregate 호환을 위해 남아 있으나 round 2 이후 ACK 권위 원본은 아니다. resync 또는 desired 전체 교체 시 null로 초기화하며, exact operation 상태는 아래 version별 테이블에서 관리한다.

### MeshControlGroupExpectedOperation

각 configuration version에서 cloud가 gateway에 요구한 operation exact set을 저장한다. `operationId`가 PK이며 `(groupId, configurationVersion, action, meshNodeId, meshAddress)`가 Unique라 동일 node의 delete-old/add-new 두 tuple을 함께 표현할 수 있다. `status`와 `lastError`는 operation별 ACK 결과를 보존하고, `(groupId, gatewayId)` compound FK는 group 삭제 시 cascade한다.

### MeshControlGroupAppliedMember

cloud가 ACK로 확인한 실제 group subscription pair snapshot이다. 복합 PK는 `(groupId, meshNodeId, meshAddress)`이며 한 node의 이전 address delete가 실패하고 새 address add가 성공한 partial replacement에서 두 address를 동시에 보존할 수 있다. incremental plan은 desired pair set과 이 applied pair set의 차집합으로 생성한다. full-state plan은 모든 desired pair를 Add로 재확인하고 desired에 없는 applied pair를 Delete하며, retiring의 빈 desired set에서는 모든 cloud applied pair가 Delete 대상이다. migration은 기존 `MeshControlGroupMember.appliedVersion > 0` 행을 현재 MeshNode address로 backfill한다.

### Command

조명 제어 명령 이력이다. 개별 조명, 임의 다중 선택, 층 전체, 저장 구역 제어를 모두 표현한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 명령 ID |
| `siteId` | `String` | 예 | FK -> `Site.id` | 대상 현장 |
| `requestedBy` | `String?` | 아니오 | FK -> `User.id`, delete set null | 요청 사용자. 영구 삭제 뒤에도 명령 이력은 보존하며 요청자만 익명화 |
| `clientRequestId` | `String` | 예 | Unique with `siteId`, `requestedBy` | 클라이언트가 재시도에도 보존하는 UUID |
| `requestFingerprint` | `String` | 예 | SHA-256 | 안정 정렬 target·brightness의 canonical fingerprint |
| `targetType` | `String` | 예 |  | `fixture`, `fixtures`, `floor`, `group` |
| `targetId` | `String?` | 아니오 |  | 단일 조명/층/구역 ID. 임의 다중 선택은 `NULL` |
| `targetFixtureIds` | `Json` | 예 | `[]` | 명령 생성 transaction에서 확정한 조명 ID snapshot |
| `brightness` | `Int` | 예 |  | 요청 밝기 0-100 |
| `status` | `CommandStatus` | 예 | `pending` | 명령 상태 |
| `outcome` | `CommandOutcome?` | 아니오 | 기본값 없음 | 실제 적용 결과. 기존 행은 `NULL`, 신규 producer가 명시 |
| `errorMessage` | `String?` | 아니오 |  | 실패 사유 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

관계:

- `site`: `Site`
- `user`: `User?`

운영 메모:

- `targetType`, `targetId`는 다형 대상 구조라 DB FK로 직접 강제하지 않는다. API는 사용자 입력을 그대로 신뢰하지 않고 같은 transaction 안에서 현장 소속 Fixture/Floor/FixtureGroup 관계를 다시 조회한다.
- `targetFixtureIds`는 명령 생성 시점의 권위 있는 대상 snapshot이다. 이후 층이나 구역 구성이 변경돼도 이미 생성된 명령의 fixture별 결과 집합은 바뀌지 않는다.
- MQTT command ACK 수신 시 `status`, `errorMessage`가 갱신된다.
- `(siteId, requestedBy, clientRequestId)` unique는 동일 사용자·현장 요청의 중복 Command, Outbox, Gateway sequence 생성을 차단한다. 현재 fingerprint는 안정 정렬 target·brightness만 해시한다. 과거 API는 optional expiry의 원문까지 해시했으므로 PostgreSQL `TIMESTAMP(3)`에서 원래 소수점 표기를 역산하지 않는다. Idempotent recovery는 저장된 `targetType`, `targetId`/`targetFixtureIds`, `brightness`를 canonical 요청과 비교하며, 동일 ID에 target 또는 brightness가 다르면 API는 conflict로 처리한다.
- `ManualOverride.commandId`는 `Command.id`를 직접 참조하는 1:1 FK다. 사용자 영구 삭제로 요청자 값이 `NULL`이 되어도 수동 override와 명령 이력 관계는 유지된다.

### CommandDispatch / CommandFixtureResult / MqttOutbox

`CommandDispatch`는 하나의 사용자 `Command`를 gateway로 전달하는 전송 단위다. 현재 단일 gateway 검증 범위에서는 논리 target이 여러 gateway에 걸치면 명령 생성 전에 전체 거부한다. `idempotencyKey`는 전체 unique, `(gatewayId, sequence)`도 unique이며 acceptance/device status 진행 상태와 오류를 저장한다.

| `CommandDispatch` 추가 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `kind` | `CommandDispatchKind` | 예 | `dimming` | Set 전송 또는 후속 상태 조회 |
| `verificationAttempt` | `Int?` | 아니오 | 기본값 없음 | `status_check`의 시도 번호, shared wire에서 1~3 강제 |
| `clientRequestId` | `String?` | 아니오 | 전역 Unique | 상태 조회 HTTP 재요청 멱등 키. 기존 dimming은 `NULL` |
| `deliveryMode` | `String` | 예 | `unicast` | `unicast`, `parallel_unicast`, `mesh_group` |
| `destinationAddress` | `String?` | 아니오 |  | `mesh_group`일 때 사용할 BLE Mesh Group Address |
| `meshControlGroupId` | `String?` | 아니오 | `gatewayId`와 복합 FK -> `MeshControlGroup(id, gatewayId)`, `ON DELETE RESTRICT` | 명령 생성 시 선택한 Mesh control group snapshot |
| `meshControlGroupVersion` | `Int?` | 아니오 | 양수 | 명령 생성 시 선택한 group 구성 버전 snapshot |

`unicast`와 `parallel_unicast`는 조명 수만큼 실제 전송하고, `mesh_group`은 `destinationAddress`에 한 번 전송한다. floor/group target은 `MeshControlGroup.status = ready`인 주소만 사용하며 준비되지 않은 group을 unicast로 대체하지 않는다. Mesh group dispatch는 그룹 삭제로 명령 감사 snapshot이 사라지지 않도록 `ON DELETE RESTRICT` 관계를 사용하고, `(meshControlGroupId, status)` index로 발행 대기 명령 검증을 지원한다.

`Gateway.nextCommandSequence`는 gateway별 dispatch sequence를 트랜잭션 안에서 원자 증가시키는 카운터다. 동시 제어 요청에서도 `(gatewayId, sequence)`가 충돌하지 않도록 `max(sequence)+1` 계산을 사용하지 않는다.

`20260912090000_command_outcome_status_check`는 두 enum과 nullable outcome/상태 조회 identity, 기본값 `dimming`인 dispatch kind, nullable `MqttOutbox.deliveryAttemptedAt`을 추가하는 순방향 migration이다. 아직 적용하지 않은 이 migration에 최종 리뷰 보정을 포함했다. 과거 outcome·시도 번호·요청 ID·발행 시각을 backfill하지 않는다. 이 작업에서는 migration 파일 작성 및 Prisma validate/generate만 수행하고 어떤 DB에도 적용하지 않았다.

P0/P1 배포는 구버전과 혼용하면 안전하지 않다. 신규 제어와 상태 확인 기능을 닫고 구버전 API/publisher를 stop-and-drain한 뒤 migration을 적용해야 한다. 신규 publisher와 Gateway, API ACK consumer가 모두 배포되어 준비된 뒤 status-check producer/API와 UI를 활성화한다. 특히 기존 publisher는 `deliveryAttemptedAt`을 기록하지 않고 status-check wire를 처리하지 못하며, 기존 consumer는 BlueZ의 `failed + STATUS_TIMEOUT`을 미적용으로 오판한다. 기존 미해결 명령의 `outcome=NULL`은 과거 발행 여부를 추정하지 않고 그대로 유지한다. 이 순서는 운영 절차이며 이번 작업에서 배포나 migration 적용을 실행한 것은 아니다.

상태 조회 outbox는 `sites/{siteId}/gateways/{gatewayId}/commands/status-check`로 발행한다. Strict draft는 기존 command identity와 `originalCommandId`, 중복 없는 `targetFixtureIds` 1~64개, `expectedBrightness` 0~100, `verificationAttempt` 1~3, `requestedAt`을 사용한다. 원 명령 snapshot이 64개를 넘으면 정렬한 64개 단위 dispatch들로 나누되 모두 같은 논리 `verificationAttempt`에 속하고 첫 dispatch만 HTTP `clientRequestId`를 가진다. 따라서 65~1,000개 원 대상도 한 번의 상태 확인이며 최대 3회 제한은 chunk 수가 아니라 논리 시도 번호로 계산한다. 모든 chunk의 dispatch/result/outbox와 gateway sequence 증가는 하나의 DB transaction에서 생성되어 중간 chunk 실패 시 전체 rollback된다.

Published payload는 `deliveryGeneration`, `deliveryGeneratedAt`, `deliveryWindowMs`, `expiresAt`을 더하며 요청자 PII·override·Mesh 그룹 정보를 허용하지 않는다. 발행 시점 기준 최대 10초·초 단위 expiry를 durable 저장하고, PUBACK 유실 뒤에도 동일 generation을 재사용하며 남은 MQTT TTL만 감소시킨다. Status-check 발행 실패·timeout은 해당 dispatch/result만 닫고 원 명령의 `unknown`은 유지한다. Gateway는 acceptance receipt를 journal에 먼저 내구 저장한 뒤 Generic OnOff/Lightness Get을 실행하며, API는 시도의 모든 chunk가 terminal일 때 관측 밝기를 원 요청과 비교해 전부 일치 `applied`, 전부 불일치 `not_applied`, 혼합 `partially_applied`, 미관측 포함 `unknown`으로 수렴한다. 어떤 경로도 밝기 Set을 자동 재전송하지 않는다.

`CommandFixtureResult`는 `(dispatchId, fixtureId)` 복합 PK로 실제 조명별 `succeeded`, `failed`, `timed_out`, 밝기, fault, RSSI, hop, 발생 시각을 저장한다. 일부 노드 실패를 그룹 전체 성공으로 숨기지 않는다.

`MqttOutbox`는 command dispatch, automation full snapshot, application ACK 발행을 함께 담당한다. Command row는 `dispatchId`만 가지고 나머지 identity는 `NULL`이며 dimming payload에는 요청자 `User` 식별자를 저장하지 않는다. Automation config row는 `gatewayId`, integer `revision`, `payloadHash`를 가지고 `dispatchId/applicationAckKey`는 `NULL`이다. Application ACK row는 `gatewayId`, unique report-hash-scoped `applicationAckKey`, ACK JSON의 canonical `payloadHash`를 가지고 `dispatchId/revision`은 `NULL`이다. 최장 UUID와 `sha256:` hash를 포함한 capability key는 ASCII 208 bytes로 255-byte safety bound 안이며 PostgreSQL B-tree unique key 한도보다 충분히 작다. `MqttOutbox_row_shape_check`가 이 세 형태 외의 row를 거부하고, `MqttOutbox_payload_hash_check`는 `sha256:` 뒤 소문자 64자리 hex 형식을 강제한다. `(gatewayId, revision, payloadHash)` Unique는 config snapshot을, `applicationAckKey` Unique는 application ACK를 exact report별 dedupe한다. Capability revision은 safe integer 최대값까지 허용되므로 ACK identity에 PostgreSQL `INTEGER revision`을 재사용하지 않는다.

Task 9 publisher는 config와 application ACK를 별도 row-shape predicate와 `FOR UPDATE SKIP LOCKED` 30초 lease로 claim해 저장된 topic/payload를 재계산 없이 MQTT QoS 1로 발행한다. 두 variant 모두 1초~60초 bounded exponential backoff와 0~20% jitter를 적용하고 10회 또는 생성 후 15분에 retained deadletter로 전환하며 row/topic/payload/hash를 삭제하거나 다시 만들지 않는다. Exact capability 또는 execution report 재전달은 해당 hash의 최초 ACK payload와 `ingestedAt`을 보존한 채 published/deadletter/expired-lease delivery 상태만 되살리고 active lease는 건드리지 않는다. Config claim과 publish 직전에는 현재 `desiredRevision`보다 오래된 미발행 full snapshot을 `supersededAt`으로 보존 종료해 최신 snapshot만 발행한다. Automation variant는 command expiry나 command terminal 전이를 사용하지 않는다.

Gateway의 Site를 바꿀 때 `publishedAt IS NULL`인 config outbox가 하나라도 남아 있으면 `Gateway_automation_site_reassignment_guard`가 변경을 거부한다. Dead-letter 여부와 무관하게 아직 publish되지 않은 old-tenant payload를 새 Site의 Gateway로 보낼 수 없게 하는 경계다. 이미 publish된 row만 있고 다른 automation 의존성이 없으면 reassignment를 막지 않는다.

Command와 outbox를 같은 DB transaction에서 생성해 MQTT publish 실패로 `pending` 명령이 유실되는 문제를 방지한다. 신규 dimming payload는 `commandId`, `dispatchId`, 대상·전송·시각 정보만 저장하고 `Command.requestedBy`를 복제하지 않는다. `mesh_group` payload는 `meshControlGroupId`, `meshControlGroupVersion`, Group Address를 포함한다. Publisher는 payload 준비 transaction 안에서 Dispatch snapshot 및 현재 그룹의 gateway/address/version/status를 다시 확인하고, 동일 버전 `configuring`만 재시도한다. 그룹 삭제·실패·버전/주소/gateway 불일치는 MQTT 발행 없이 `MESH_GROUP_STALE` terminal failure로 종료한다.

`20260819094000_extend_command_targets` migration은 기존 Command의 `targetFixtureIds`를 관련 `CommandFixtureResult.fixtureId` 집합으로 backfill한다. 기존 Dispatch는 실제 result 수 1개 이하면 `unicast`, 2개 이상이면 `parallel_unicast`로 정규화한다. 기존 outbox payload도 같은 fixture 목록을 사용하며 과거 `group` 명령을 Mesh group으로 가장하지 않고 `fixtures`, `targetId = null`로 바꾼다. 단, 기존 `fixture` 명령이 정확히 한 조명을 가리킬 때만 `fixture`를 유지한다. Payload는 당시 draft wire가 허용한 키로 새 JSON을 구성해 이전 재시도의 `expiresAt`과 임의 legacy 키를 제거했지만, 당시 계약의 `requestedBy`는 포함한다. 권위 있는 result가 없거나 당시 wire 한도인 1,000개를 초과하는 outbox가 하나라도 있으면 migration은 대상을 자르거나 잘못 발행하지 않고 명시적으로 중단한다.

모든 preflight는 DDL보다 먼저 실행되고 migration 전체는 명시적 PostgreSQL transaction으로 감싼다. Guard 또는 후반 index/FK 오류가 발생하면 신규 컬럼, update, constraint가 함께 rollback된다. `COMMAND_MIGRATION_TEST_DATABASE_URL`을 지정한 opt-in rehearsal은 무작위 임시 schema만 만들고 fresh/retry strict parse, guard rollback, 후반 DDL rollback을 검증한 뒤 schema를 삭제한다.

이 migration은 아직 어떤 배포 환경에도 적용하지 않은 Task 12 신규 migration이라는 전제에서 같은 파일을 보정했다. 이미 이전 버전을 적용한 환경이 생긴 뒤에는 파일을 다시 수정하지 말고 별도의 순방향 보정 migration을 추가해야 한다.

다중 API 인스턴스에서는 `lockedBy`, `lockedAt`, `leaseExpiresAt`으로 30초 발행 lease를 소유하고 PostgreSQL `FOR UPDATE SKIP LOCKED`로 같은 레코드의 중복 발행을 차단한다. Command payload는 생성 직후 strict draft, publisher가 확정한 strict published generation, 또는 rolling upgrade 중 남은 legacy full wire일 수 있다. Compatibility parser는 과거 draft/full/published payload의 `requestedBy`, `overrideUntil`, `overrideRemainingMs`를 알려진 legacy 키로만 수신하고 canonical draft로 정규화할 때 제거하며 임의 추가 키는 허용하지 않는다. Publisher가 과거 row를 새 generation으로 승격할 때도 이 legacy 필드를 제거한다. 새 producer는 요청자나 수동 만료 키 없이 generation metadata가 상호 일치하는 strict published wire만 만든다.

Publisher는 Mesh snapshot 검증과 lease ownership을 확인하는 같은 transaction에서 `deliveryGeneration`, `deliveryGeneratedAt`, 고정 10초의 whole-second `deliveryWindowMs`, `expiresAt`을 payload에 먼저 durable 저장한다. 이 generation은 MQTT 전달 가능 시간만 나타내며 수동 밝기의 지속 시간이나 Gateway 적용 만료를 뜻하지 않는다. MQTT `messageExpiryInterval`은 같은 absolute delivery end를 가리킨다. Final ownership query 뒤에는 lease가 `freshNow + 20초 MQTT timeout`보다 엄격히 뒤인지 다시 확인하고, DB 대기로 남은 시간이 부족하거나 delivery generation이 만료됐다면 발행하지 않는다.

MQTT 실패나 PUBACK 유실 뒤 retry는 generation과 wire payload를 다시 만들지 않는다. Durable `expiresAt - retryNow`를 whole seconds로 내린 remaining MQTT expiry만 사용하므로 broker 보존이 payload delivery deadline을 넘지 않으며, generation이 소진되면 `COMMAND_DELIVERY_EXPIRED` terminal failure로 수렴한다. Legacy draft/full row는 첫 fix-round publisher claim에서 새 generation으로 한 번 승격된다. Broker가 물리 publish를 수신한 직후 API가 종료되면 같은 payload가 재전달될 수 있으므로 command idempotency key와 Gateway durable journal이 중복 물리 실행을 차단하는 필수 경계다. MQTT QoS 1 callback을 20초 안에 받지 못하면 해당 message ID를 `removeOutgoingMessage`로 취소하고 fresh failure 시각 기준 재시도 경로로 전환한다. 이 변경은 `MqttOutbox.payload` JSON 계약만 갱신하며 DB 컬럼이나 migration은 추가하지 않는다.

순방향 migration `20260911090000_remove_command_requester_from_mqtt_outbox`는 하나의 transaction에서 `dispatchId`가 실제 `CommandDispatch`를 가리키는 JSON object payload만 대상으로 top-level `requestedBy`를 제거한다. 이어서 명명된 `MqttOutbox_command_payload_no_requested_by_check` CHECK를 설치해 `dispatchId`가 있는 JSON object에 같은 키가 다시 저장되는 것을 거부한다. Nested key, JSON array, automation config와 application ACK row는 변경하거나 차단하지 않는다. 현장 일반 유저 삭제 transaction도 해당 사용자가 요청한 모든 CommandDispatch outbox에 같은 set-based JSONB scrub을 적용한 뒤 User를 삭제한다. 따라서 `Command.requestedBy`와 `ManualOverride.requestedById`의 `SET NULL`, accepted Invitation 삭제 및 durable publish payload 익명화가 최종 audit 실패와 함께 rollback된다.

이 migration은 구버전 command producer/publisher와 신버전을 동시에 운영하는 rolling deploy를 허용하지 않는다. Control write를 freeze하고 구버전 API와 command publisher를 stop-and-drain한 뒤, 마지막 구버전 publisher 종료부터 broker 최대 command expiry 10초를 기다린다. 그 다음 migration을 적용하고 신버전 API/publisher만 시작해 command smoke를 통과한 뒤 write를 재개한다. CHECK는 DB 재삽입을 fail-closed하지만 이미 최종 DB fence를 지난 구버전 worker의 메모리 publish는 막을 수 없으므로 이 순서를 생략할 수 없다. 상세 절차는 Gateway appliance runbook의 requester PII migration 유지보수 절을 따른다.

Pending delivery timeout은 Dispatch보다 `MqttOutbox`를 먼저 조건부 dead-letter 선점한다. `lockedBy IS NULL` 또는 `leaseExpiresAt <= now`인 미발행 row를 정확히 1개 선점한 경우에만 Dispatch, 조명별 결과, Command를 종료한다. 필수 1:1 outbox가 없거나 active publisher lease가 있으면 fail-closed로 아무 terminal 전이도 하지 않는다. Outbox 선점 뒤 Dispatch 상태 경쟁을 잃으면 전용 오류로 transaction 전체를 rollback한다. 따라서 publisher claim과 timeout은 같은 outbox row update에서 직렬화된다. Published/accepted timeout은 outbox 선점 없이 기존 Dispatch 조건부 종료를 사용한다. 실패 시 지수 backoff와 jitter를 적용하며 최대 10회 또는 생성 후 15분을 넘으면 `deadLetteredAt`을 기록하며 dispatch와 조명별 결과는 아래 발행 시도 증거에 따라 분류한다. 프로세스가 중단돼도 lease 만료 후 다른 인스턴스가 레코드를 회수한다.

Command publisher는 MQTT 호출 직전에 lease를 다시 확인하고 첫 `deliveryAttemptedAt`을 transaction으로 commit한다. 이 기록 이후 PUBACK을 잃으면 `publishedAt=NULL`, dispatch `pending`이어도 실제 Set을 전달했을 수 있다. Expiry/dead-letter 및 pending timeout worker는 이 내구 기록을 읽어 dimming을 `unknown`으로 닫고, 발행 시도 없이 검증에서 거절된 경우만 `not_applied`로 분류한다. `attempts` 횟수는 발행 증거로 사용하지 않는다. 기록 commit 직후 MQTT 호출 전 crash도 보수적으로 `unknown`이며 자동 Set 재시도는 추가하지 않았다.

Publisher의 claim/prepare/발행 시도 기록/retry/terminal 갱신은 automation global lock을 outbox·dispatch·command 잠금보다 먼저 얻는다. MQTT 네트워크 대기에는 transaction을 유지하지 않는다. Terminal outbox를 닫더라도 dispatch 조건부 전이에 실패하면 조명 결과와 원 명령은 갱신하지 않아 먼저 확정한 ACK를 보존한다. 발행 불확실 dispatch는 `timed_out` 증거와 오류 코드를 남기며 `unknown`인 dimming에 한해 늦은 ACK를 수렴시킨다. Status-check publisher 실패는 원 Set outcome을 결정하지 않는다.

BlueZ의 Lightness Status 유실은 신규 Gateway에서 `timed_out + STATUS_TIMEOUT`으로 발행한다. API consumer는 기존 `failed + STATUS_TIMEOUT`도 원문 aggregate와 event/hash를 검증한 뒤 `timed_out`으로 정규화하고 관측하지 못한 밝기는 저장하지 않는다. 이 경우 outcome은 `unknown`이므로 겹치는 새 Set은 막고 실제 상태 Get을 허용한다.

| `MqttOutbox` 컬럼 | 타입 | 설명 |
| --- | --- | --- |
| `id` | `String` | PK, `uuid()` |
| `dispatchId` | `String?` | command row의 Unique FK -> `CommandDispatch.id`; delete cascade |
| `deliveryAttemptedAt` | `DateTime?` | Command MQTT 호출 전 최초 시도 commit 시각. PUBACK 성공 시각과 별도이며 구형 행은 `NULL` |
| `gatewayId` | `String?` | automation config/application ACK row의 FK -> `Gateway.id`; delete cascade |
| `applicationAckKey` | `String?` | application ACK row의 deterministic Gateway/node/event/report-hash scoped unique identity |
| `revision` | `Int?` | automation config revision, DB check `>= 0` |
| `payloadHash` | `String?` | automation config 또는 application ACK canonical SHA-256 hash |
| `topic` | `String` | publish 대상 MQTT topic |
| `payload` | `Json` | durable publish payload |
| `attempts` | `Int` | 기본값 `0`, 누적 publish 시도 횟수 |
| `nextAttemptAt` | `DateTime` | 기본값 `now()`, 다음 claim 가능 시각 |
| `publishedAt` | `DateTime?` | publish 성공 시각 |
| `lockedBy` | `String?` | 현재 발행 lease를 가진 API worker UUID |
| `lockedAt` | `DateTime?` | lease 획득 시각 |
| `leaseExpiresAt` | `DateTime?` | 장애 발생 시 다른 worker가 회수할 수 있는 시각 |
| `deadLetteredAt` | `DateTime?` | 재시도 한도를 초과해 자동 발행을 중단한 시각 |
| `supersededAt` | `DateTime?` | 더 최신 desired revision 때문에 미발행 config snapshot을 보존 종료한 시각 |
| `lastError` | `String?` | 마지막 publish 오류 |
| `createdAt`, `updatedAt` | `DateTime` | `now()`, `@updatedAt` |

Automation config reclaim index는 `(gatewayId, publishedAt, deadLetteredAt, nextAttemptAt)`이며 기존 공용 reclaim index `(publishedAt, deadLetteredAt, nextAttemptAt, leaseExpiresAt)`도 유지한다. Task 9 partial delivery index는 dispatch가 없고 미발행·non-deadletter·non-superseded인 automation row를 `(nextAttemptAt, createdAt)` 순으로 찾는다.

### GatewayAutomationConfiguration

Site/Gateway별 full snapshot revision과 ACK 상태의 현재값이다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `gatewayId` | `String` | 예 | PK, `(gatewayId, siteId)` Unique/FK -> `Gateway(id, siteId)`, delete cascade | Gateway별 단일 구성 |
| `siteId` | `String` | 예 | FK -> `Site.id`, delete cascade | tenant 루트 |
| `desiredRevision` | `Int` | 예 | `0`, DB check `>= 0` | Cloud 최신 revision |
| `appliedRevision` | `Int` | 예 | `0`, DB check `0..desiredRevision` | Gateway ACK 완료 revision |
| `syncStatus` | `AutomationSyncStatus` | 예 | `PENDING`, index with `siteId` | 적용 상태 |
| `payloadHash` | `String?` | 아니오 | DB check `sha256:[a-f0-9]{64}` | desired snapshot hash |
| `lastErrorCode` | `String?` | 아니오 |  | 정제된 마지막 reject code |
| `lastAppliedAt` | `DateTime?` | 아니오 |  | 마지막 exact ACK 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 갱신 시각 |

`GatewayAutomationConfiguration_state_check`는 revision 순서 외에 상태별 원자 전이를 강제한다.

- 최초 상태는 `PENDING`, `desiredRevision = appliedRevision = 0`, hash/error/applied 시각 `NULL`이다.
- `PENDING`의 revision이 0보다 크면 `desiredRevision > appliedRevision`, 유효한 `payloadHash`, `lastErrorCode = NULL`이어야 한다. 이전 성공 시각은 유지할 수 있지만 현재 desired revision을 applied로 주장할 수 없다.
- `APPLIED`는 `desiredRevision = appliedRevision`, hash와 `lastAppliedAt` 필수, error `NULL`이다.
- `REJECTED`는 hash와 공백이 아닌 error가 필수이고 `appliedRevision <= desiredRevision`이다. 이전 applied revision/시각은 보존할 수 있다.

Exact desired reject 뒤 lower revision의 applied ACK가 늦게 도착하면 `appliedRevision`과 `lastAppliedAt`만 단조 전진시키고 `REJECTED/lastErrorCode`는 유지한다. Exact desired applied만 rejection을 `APPLIED`로 해소할 수 있다.

구성 row는 감사 이력이 아니라 현재 동기화 상태이므로 Site 또는 Gateway가 삭제되면 cascade한다. Snapshot publish 이력은 같은 Gateway에 연결된 `MqttOutbox` config row가 담당한다. `(gatewayId, siteId)`와 `siteId` FK는 owner key 갱신을 `RESTRICT`한다.

### LightingSchedule / LightingScheduleFixture

`LightingSchedule`은 현장 날짜 범위, 현지 시각 구간, 반복 방식과 action을 저장하고 `LightingScheduleFixture`는 저장 시 확정된 Fixture ID snapshot이다.

자동화 membership 변경은 낮은 빈도의 구성 쓰기라는 전제에서 의도적으로 transaction 단위 직렬화한다. Parent인 `LightingSchedule`, `VehicleEventRule`, `ManualOverride`와 membership인 `LightingScheduleFixture`, `VehicleEventSource`, `VehicleEventTarget`, `ManualOverrideFixture`의 INSERT/UPDATE/DELETE `BEFORE STATEMENT` trigger는 top-level DML의 target tuple이 잠기기 전에 모두 동일한 `pg_advisory_xact_lock(1279607873, 1296387394)`를 획득한다. MeshNode capability UPDATE와 source Fixture의 `meshNodeId` UPDATE도 같은 statement lock을 사용해 source INSERT와 capability downgrade/reassignment를 직렬화한다. 고정 key의 mnemonic은 `LEDA`/`MEMB`이며 transaction 전체에 유지하므로 parent field를 먼저 갱신한 뒤 membership을 바꾸는 transaction과 여러 parent를 반대 순서로 바꾸는 multi-row statement도 직렬화된다. Child counter trigger가 만든 nested parent UPDATE와 parent DELETE가 만든 nested FK cascade는 `pg_trigger_depth() > 1`에서 statement advisory 획득과 부수 작업을 생략한다. 전자는 바깥 child statement가 이미 global lock을 보유하고, 후자는 top-level parent statement의 global lock과 parent row/FK cascade가 직렬화 권한을 가진다. Cascade row maintenance는 삭제 중인 parent가 이미 보이지 않을 때 counter 갱신을 생략하고, depth 1에서 나중에 실행되는 deferred event도 parent 부재를 확인해 cardinality reconciliation을 생략한다. 반면 direct top-level child DELETE는 depth 1 statement lock, counter 감소, deferred 최소 1개 검증을 모두 수행한다.

| `LightingSchedule` 컬럼 | 타입 | 필수 | 기본값/제약 |
| --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` |
| `siteId` | `String` | 예 | FK -> `Site.id`, delete cascade; index `(siteId, status, createdAt)` |
| `gatewayId` | `String` | 예 | `siteId`와 복합 FK -> `Gateway(id, siteId)`, delete cascade; index `(gatewayId, status)` |
| `name` | `String` | 예 | DB check `btrim(name) <> ''` |
| `status` | `AutomationRuleStatus` | 예 | `enabled` |
| `activeFrom`, `activeUntil` | `DateTime` | 예 | DB check `activeFrom <= activeUntil` |
| `localStartTime`, `localEndTime` | `String` | 예 | DB check `HH:mm`, `00:00..23:59`, 두 값은 서로 달라야 함 |
| `recurrenceKind` | `ScheduleRecurrenceKind` | 예 | 반복 enum |
| `weeklyDays` | `Int[]` | 예 | `[]`; weekly에서 비어 있지 않고 모든 값이 고유한 `1..7` |
| `monthlyDay` | `Int?` | 아니오 | monthly에서만 `1..31` |
| `yearlyMonth`, `yearlyDay` | `Int?` | 아니오 | yearly에서만 각각 `1..12`, `1..31` |
| `dimmingEnabled` | `Boolean` | 예 | action의 디밍 사용 여부 |
| `brightnessPercent` | `Int` | 예 | DB check `0..100` |
| `desiredRevision`, `appliedRevision` | `Int` | 예 | `0`; DB check `0 <= appliedRevision <= desiredRevision` |
| `targetCount` | `Int` | 예 | `0`; DB check `>= 0`, child trigger 유지 | 현재 target row 수 |
| `createdById`, `updatedById` | `String` | 예 | named FK -> `User.id`, delete restrict |
| `createdAt`, `updatedAt` | `DateTime` | 예 | `now()`, `@updatedAt` |

`automation_weekly_days_are_unique(INTEGER[])`는 `IMMUTABLE` SQL helper이며 recurrence CHECK가 중복 요일을 API와 독립적으로 거부한다. `localStartTime <> localEndTime` CHECK는 같은 시각을 암묵적인 24시간 schedule로 해석하지 않고 API와 독립적으로 거부한다. `LightingSchedule`은 owner-bearing child FK 기준인 `(id, siteId, gatewayId)` Unique도 가진다.

`LightingScheduleFixture`의 컬럼은 `scheduleId`, `fixtureId`, `siteId`, `gatewayId`, `createdAt`이다. `(scheduleId, fixtureId)`가 복합 PK이고 `(scheduleId, siteId, gatewayId)`는 부모 owner Unique를 `ON DELETE CASCADE, ON UPDATE RESTRICT`로 참조한다. `(fixtureId, siteId, gatewayId)`는 투영된 `Fixture(id, siteId, gatewayId)`를 delete cascade/update restrict로 참조하며 `(fixtureId)`, `(siteId, gatewayId)` index가 있다.

`LightingSchedule_membership_statement_lock`과 `LightingScheduleFixture_membership_statement_lock`은 top-level INSERT/UPDATE/DELETE 전에 같은 automation membership advisory lock을 획득한다. Row maintenance는 이 statement lock이 이미 유지된다고 가정하고 INSERT/DELETE에서 부모 `targetCount`를 원자 증감하며, `scheduleId` UPDATE에서는 OLD/NEW 부모를 ID 오름차순 `FOR UPDATE`로 잠근 뒤 두 counter를 갱신한다. Counter가 만든 nested `LightingSchedule` UPDATE의 parent statement trigger는 depth guard로 재진입 작업을 생략한다. 음수는 DB check와 underflow guard가 거부한다. DEFERRABLE INITIALLY DEFERRED constraint trigger는 commit 시 `targetCount >= 1`과 실제 child `COUNT(*)` 일치를 함께 검증한다. Parent+child를 같은 transaction에서 만들거나 snapshot 전체를 교체할 수 있고, nested parent cascade에서 이미 삭제된 parent의 counter와 deferred 검증은 건너뛴다. 모든 direct child write가 같은 parent row version을 갱신하므로 READ COMMITTED는 lock 대기 뒤 최신 counter로 재검사하고 REPEATABLE READ/SERIALIZABLE은 concurrent row update를 serialization failure로 종료해 동시 마지막-target 삭제의 stale 성공을 막는다.

### VehicleEventRule / VehicleEventSource / VehicleEventTarget

| `VehicleEventRule` 컬럼 | 타입 | 필수 | 기본값/제약 |
| --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` |
| `siteId` | `String` | 예 | FK -> `Site.id`, delete cascade; index `(siteId, status, createdAt)` |
| `gatewayId` | `String` | 예 | `siteId`와 복합 FK -> `Gateway(id, siteId)`, delete cascade; index `(gatewayId, status)` |
| `name` | `String` | 예 | DB check `btrim(name) <> ''` |
| `status` | `AutomationRuleStatus` | 예 | `enabled` |
| `dimmingEnabled` | `Boolean` | 예 | 감지 action 디밍 여부 |
| `brightnessPercent` | `Int` | 예 | DB check `0..100` |
| `holdSeconds` | `Int` | 예 | `60`, DB check `5..1800` |
| `desiredRevision`, `appliedRevision` | `Int` | 예 | `0`; DB check `0 <= appliedRevision <= desiredRevision` |
| `sourceCount`, `targetCount` | `Int` | 예 | `0`; 각각 DB check `>= 0`, child trigger 유지 | 현재 source/target row 수 |
| `createdById`, `updatedById` | `String` | 예 | named FK -> `User.id`, delete restrict |
| `createdAt`, `updatedAt` | `DateTime` | 예 | `now()`, `@updatedAt` |

`VehicleEventRule`은 child owner FK 기준인 `(id, siteId, gatewayId)` Unique를 가진다. `VehicleEventSource`와 `VehicleEventTarget`은 각각 `ruleId`, `fixtureId`, `siteId`, `gatewayId`, `createdAt`을 저장하고 `(ruleId, fixtureId)` 복합 PK로 source/target 중복을 차단한다. `(ruleId, siteId, gatewayId)`는 부모 owner를 delete cascade/update restrict로, `(fixtureId, siteId, gatewayId)`는 투영된 Fixture owner를 delete cascade/update restrict로 참조한다. 두 테이블 모두 `(fixtureId)`, `(siteId, gatewayId)` index가 있다.

`VehicleEventSource` INSERT와 `fixtureId` 변경은 연결 Fixture의 MeshNode row를 잠그고 capability가 `supported`이며 verified timestamp가 있는지 검사한다. MeshNode capability UPDATE의 `BEFORE ROW` guard는 status/timestamp 조합을 재검증하고 enabled rule source로 참조되는 node의 downgrade/unknown 전환을 거부한다. Rule status UPDATE도 invalid source를 가진 disabled rule의 re-enable을 거부한다. Fixture의 `meshNodeId` 변경은 enabled source를 미지원 node로 옮기지 못하게 한다. Disabled rule의 기존 source는 감사 목적으로 남길 수 있지만 지원 report 적용 전에는 API와 direct SQL 모두 re-enable할 수 없다. 이 제약은 Prisma를 우회한 direct SQL에도 동일하다.

`VehicleEventRule_membership_statement_lock`, `VehicleEventSource_membership_statement_lock`, `VehicleEventTarget_membership_statement_lock`은 top-level statement가 parent 또는 child tuple을 잠그기 전에 공통 advisory lock을 획득한다. Row maintenance는 INSERT/DELETE/`ruleId` UPDATE에 맞춰 `sourceCount` 또는 `targetCount`를 원자 갱신하고 부모 이동 시 두 rule row를 ID 오름차순으로 잠근다. Counter가 만든 nested rule UPDATE는 depth guard로 parent statement 작업을 생략하고, nested parent cascade는 이미 사라진 rule의 counter와 deferred 검증을 건너뛴다. Direct DML의 deferred 검증은 두 counter가 각각 1 이상이고 실제 source/target row 수와 정확히 같은지 확인한다. 같은 parent row version을 쓰는 방식이 READ COMMITTED, REPEATABLE READ, SERIALIZABLE의 동시 마지막-child 삭제를 직렬화하거나 serialization failure로 종료한다.

### ManualOverride / ManualOverrideFixture

| `ManualOverride` 컬럼 | 타입 | 필수 | 기본값/제약 |
| --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` |
| `siteId` | `String` | 예 | FK -> `Site.id`, delete cascade; index `(siteId, overrideUntil)` |
| `gatewayId` | `String` | 예 | `siteId`와 복합 FK -> `Gateway(id, siteId)`, delete cascade; index `(gatewayId, overrideUntil)` |
| `commandId` | `String` | 예 | Unique; FK -> `Command.id`, delete cascade/update restrict |
| `requestedById` | `String?` | 아니오 | named FK -> `User.id`, delete set null; index `(requestedById, createdAt)` |
| `brightnessPercent` | `Int` | 예 | DB check `0..100` |
| `startedAt` | `DateTime` | 예 | 수동 기본 밝기 명령 감사 시작 시각 |
| `overrideUntil` | `DateTime?` | 아니오 | legacy timed override compatibility field. 값이 있으면 DB check `overrideUntil > startedAt` |
| `endedAt` | `DateTime?` | 아니오 | `overrideUntil IS NULL`이면 반드시 null. legacy timed row는 DB check `startedAt <= endedAt <= overrideUntil` |
| `targetCount` | `Int` | 예 | `0`; DB check `>= 0`, child trigger 유지 | 현재 target row 수 |
| `createdAt`, `updatedAt` | `DateTime` | 예 | `now()`, `@updatedAt` |

`ManualOverride`은 child owner FK 기준인 `(id, siteId, gatewayId)` Unique와 `commandId` Unique로 1:1 Command relation을 가진다. `20260914090000_manual_control_baseline` 순방향 migration은 기존 migration 파일이나 non-null timed history를 다시 쓰지 않고 `overrideUntil`의 `NOT NULL`만 제거한다. 변경된 `ManualOverride_time_range_check`는 `(overrideUntil IS NULL AND endedAt IS NULL)`인 새 감사 행 또는 기존 timed 범위만 허용한다. 새 API가 기록하는 null-expiry 행은 시간 제한 override가 아니라 target·brightness 기반 수동 기본 밝기 명령의 감사 이력이며, Gateway는 이 필드로 만료를 판단하지 않는다. 요청 사용자가 영구 삭제되면 `requestedById`만 `NULL`로 바꾸고 override·명령 원장은 보존한다. `ManualOverrideFixture`는 `manualOverrideId`, `fixtureId`, `siteId`, `gatewayId`, `createdAt`을 저장한다. `(manualOverrideId, fixtureId)` 복합 PK, `(fixtureId)`, `(siteId, gatewayId)` index, owner-aware override delete cascade/update restrict와 투영된 `(fixtureId, siteId, gatewayId)` Fixture delete cascade/update restrict를 사용한다.

`ManualOverride_membership_statement_lock`과 `ManualOverrideFixture_membership_statement_lock`은 top-level statement가 parent 또는 child tuple을 잠그기 전에 공통 advisory lock을 획득한다. Row maintenance는 INSERT/DELETE/부모-key UPDATE에서 `targetCount`를 원자 갱신하며 부모 이동 시 두 override row를 ID 오름차순으로 잠근다. Counter가 만든 nested override UPDATE는 depth guard로 parent statement 작업을 생략하고, nested parent cascade는 이미 사라진 override의 counter와 deferred 검증을 건너뛴다. Direct DML의 deferred 검증은 `targetCount >= 1`과 실제 target row 수 일치를 강제한다. 동일 parent row version 갱신이 모든 공통 isolation level에서 동시 마지막-target 삭제의 stale 성공을 막는다. Command 관계는 command 삭제 시 cascade, User 관계는 user 삭제 시 set null, ManualOverrideFixture의 Fixture 관계는 fixture 삭제 시 cascade를 사용한다.

### AutomationExecution / AutomationExecutionFixtureResult

`AutomationExecution`은 Gateway가 보낸 lifecycle event를 보존하는 append-only 원장이다.

| `AutomationExecution` 컬럼 | 타입 | 필수 | 기본값/제약 |
| --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` |
| `siteId` | `String` | 예 | FK -> `Site.id`, delete cascade; index `(siteId, occurredAt)` |
| `gatewayId` | `String` | 예 | `siteId`와 복합 FK -> `Gateway(id, siteId)`, delete cascade |
| `eventId` | `String` | 예 | Unique with `gatewayId`, `sequence` |
| `sequence` | `BigInt` | 예 | DB check `>= 0`; index `(gatewayId, sequence)` |
| `revision` | `Int` | 예 | DB check `>= 0` |
| `ruleId` | `String?` | 아니오 | 삭제 후에도 보존하는 Gateway payload의 raw rule ID; index `(ruleId, occurredAt)` |
| `lightingScheduleId`, `vehicleEventRuleId`, `manualOverrideId` | `String?` | 아니오 | 각 원본 FK, delete set null/update restrict; kind별 원본 하나만 허용 |
| `occurrenceKey` | `String?` | 아니오 | 재시작 후 같은 occurrence 식별자 |
| `kind` | `AutomationExecutionKind` | 예 | lifecycle 종류 |
| `occurredAt` | `DateTime` | 예 | Gateway 발생 시각 |
| `payload` | `Json` | 예 | 종류별 원본 메타데이터 |
| `payloadHash` | `String?` | 아니오 | 신규 MQTT ingest는 canonical `sha256:<64 lowercase hex>`, legacy row는 `NULL` 허용 |
| `createdAt` | `DateTime` | 예 | `now()` |

`lightingScheduleId`와 `vehicleEventRuleId`는 각각 최신 실행 조회 순서인 `(sourceId, occurredAt DESC, sequence DESC)` 일반 복합 index를 사용하고, `manualOverrideId`는 단독 index를 사용한다. 차량 이벤트 목록의 최신 전체 실행은 일반 vehicle index를 사용하고, 최신 감지는 migration/catalog 전용 partial index `(vehicleEventRuleId, occurredAt DESC, sequence DESC) WHERE kind = 'vehicle_detected'`를 사용한다. Prisma schema가 partial predicate를 표현하지 못하므로 일반 index만 schema에 유지하며 partial index를 중복된 일반 index처럼 선언하지 않는다. `(gatewayId, eventId, sequence)` Unique와 canonical `payloadHash`가 MQTT QoS 1 exact replay를 멱등 처리하고 같은 identity의 변조 replay를 거부한다. Action result hash는 fixture ID 순으로 terminal result를 정규화하므로 집합 순서만 다른 재전달은 같은 report다. MQTT ingest는 `event.revision`에 해당하는 strict config outbox full snapshot의 canonical hash, Site/Gateway, enabled source와 target fixture set을 검증한다. Live rule relation은 감사 FK 연결에만 사용하므로 rule 수정·이동·삭제 후에도 old revision의 정상 execution은 raw `ruleId`와 nullable source FK로 보존된다. `AutomationExecution_source_check` trigger가 INSERT와 source/owner/kind 변경에서 source 부모의 `siteId/gatewayId`를 실행 owner와 비교하고 다음 coherence를 강제한다.

- `schedule_started`, `schedule_ended`: `lightingScheduleId` 필수, `ruleId = lightingScheduleId`
- `vehicle_detected`, `event_started`, `event_extended`, `event_ended`: `vehicleEventRuleId` 필수, `ruleId = vehicleEventRuleId`
- `action_result`: schedule/event/manual source 중 정확히 하나. schedule/event는 `ruleId`가 source ID와 같고 manual은 `ruleId = NULL`이다. Manual payload의 `sourceId`는 command ID이며, `manualOverrideId`는 같은 `ManualOverride.commandId`를 가진 실제 PK여야 한다.
- `telemetry_gap`: source 세 컬럼과 `ruleId`가 모두 `NULL`

개별 규칙 또는 override 삭제는 실행 원장의 FK를 `SET NULL`로 바꾸고 raw `ruleId`, event payload, occurrence key와 owner를 보존한다. 반면 operator가 확인한 현장 영구 삭제에서는 Site/Gateway ownership FK가 cascade되어 해당 현장의 실행 원장도 함께 제거된다. Owner `(gatewayId, siteId)`와 Site/source FK의 key update는 restrict한다.

| `AutomationExecutionFixtureResult` 컬럼 | 타입 | 필수 | 기본값/제약 |
| --- | --- | --- | --- |
| `executionId` | `String` | 예 | 복합 PK, FK -> `AutomationExecution.id`, delete cascade |
| `fixtureSnapshotId` | `String` | 예 | 복합 PK, 실행 당시 Fixture ID snapshot |
| `fixtureId` | `String?` | 아니오 | FK -> `Fixture.id`, delete set null; index with `status` |
| `status` | `CommandFixtureResultStatus` | 예 | DB check `succeeded`, `failed`, `timed_out`만 허용 |
| `brightnessPercent` | `Int?` | 아니오 | DB check `0..100` |
| `faultCode`, `errorCode` | `String?` | 아니오 | 정제된 실패 정보 |
| `occurredAt` | `DateTime` | 예 | 결과 발생 시각 |
| `createdAt` | `DateTime` | 예 | `now()` |

DB check는 live `fixtureId`가 `NULL`이거나 `fixtureSnapshotId`와 정확히 같아야 한다. Fixture가 삭제되면 nullable FK만 `NULL`이 되고 `fixtureSnapshotId`는 남는다. `pending`은 automation result에 저장할 수 없으며 실행 원장을 명시적으로 삭제할 때만 그 하위 결과가 cascade된다.

### 자동 제어 tenant 경계와 lifecycle

- `Gateway.id + Gateway.siteId`를 Unique로 만들고 구성, 규칙, override, 실행 원장이 `(gatewayId, siteId)` 복합 FK를 사용한다. Owner FK는 `ON UPDATE RESTRICT`다. `Gateway_automation_site_reassignment_guard`는 기존 Site가 `NULL`이면 dependency 생성 전 최초 assignment를 허용하지만, 구성/규칙/override/실행 원장 또는 `publishedAt IS NULL` config outbox가 있으면 Site 변경을 거부한다.
- Fixture는 `Floor(id, siteId)`와 `MeshNode(id, gatewayId)` 복합 FK로 owner를 투영한다. Floor/MeshNode owner update는 Fixture에 cascade하지만 schedule/event/manual join이 `(fixtureId, siteId, gatewayId)`를 `ON UPDATE RESTRICT`로 참조하므로 유효한 owner 이동만 구조적으로 허용된다. Join 생성과 owner 이동의 안전성은 automation row visibility scan에 의존하지 않으며 READ COMMITTED, REPEATABLE READ, SERIALIZABLE에서 FK row-version 검사로 유지된다. 같은 owner update, automation 미참조 Fixture의 owner 이동, MeshNode 없는 Fixture의 `gatewayId = NULL`은 허용한다.
- Schedule/event/manual parent와 schedule target, vehicle source/target, manual target의 top-level DML은 모두 `BEFORE STATEMENT`에서 고정 key `(1279607873, 1296387394)`의 transaction-level advisory lock을 target tuple보다 먼저 획득한다. 이 낮은 빈도의 구성 쓰기 직렬화가 parent UPDATE 후 membership DML과 multi-row 반대 parent 변경의 transaction-global lock cycle을 제거한다. Membership row maintenance는 parent-maintained non-negative counter를 갱신하고, parent-key move의 양쪽 parent ID 정렬, DEFERRABLE INITIALLY DEFERRED counter/실제 child 수 reconciliation, 최소 1개 제약은 그대로 유지한다. Counter trigger가 만든 nested parent UPDATE와 parent DELETE의 nested FK cascade는 trigger depth guard로 statement 작업을 건너뛴다. Cascade row trigger와 deferred cardinality trigger는 삭제된 parent 부재도 확인해 parent row/FK cascade 순서를 따른다.
- 구성 row와 config outbox는 owner 삭제 시 cascade한다. 규칙 target/source는 규칙 또는 Fixture 삭제 시 cascade하며, 현장 영구 삭제에서는 양쪽 owner가 함께 정리된다.
- Manual override는 unique `commandId`로 `Command.id`를 직접 참조한다. Command와 대상 Fixture 삭제는 관련 override/target을 cascade하고, 요청 `User`를 개별 삭제하면 `Command.requestedBy`와 `ManualOverride.requestedById`가 각각 `NULL`이 되어 이력을 익명 상태로 보존한다.
- 실행 원장은 trigger로 source owner와 kind/rule coherence를 확인한다. 개별 원본 규칙/override 및 Fixture 삭제에서는 nullable source FK와 snapshot ID로 이력을 보존하지만, 명시적인 현장 영구 삭제에서는 Site/Gateway와 함께 cascade한다.

`20260829_add_lighting_automation`은 배포 이력을 보존하는 released Task 6 migration으로 수정하지 않는다. 이 migration은 기존 Fixture의 `siteId`를 Floor에서 backfill하고, MeshNode가 연결된 Fixture만 `gatewayId`를 backfill한 뒤 `siteId NOT NULL`과 owner FK를 적용한다. MeshNode 없는 기존 Fixture는 `gatewayId = NULL`로 보존된다. 기존 Command와 command형 `MqttOutbox` row는 신규 owner Unique와 command/config row-shape check를 그대로 만족한다. Task 7 목록의 최신 실행 조회 index는 별도 순방향 migration `20260830_add_schedule_execution_list_index`가 기존 단독 index를 `(lightingScheduleId, occurredAt DESC, sequence DESC)`로 교체한다.

순방향 migration `20260830_vehicle_sensor_capability_and_detection_index`는 `VehicleSensorCapabilityStatus`, MeshNode capability 두 컬럼과 coherence CHECK를 추가하고 모든 기존 노드를 fail-closed `unknown`/`NULL`로 backfill한다. 같은 migration이 최신 감지 조회용 partial index `AutomationExecution_vehicleEventRuleId_latest_detection_idx`를 생성한다. 이 index의 predicate와 정렬 컬럼은 PostgreSQL catalog contract test로 관리한다.

순방향 migration `20260830_vehicle_sensor_source_invariants`는 적용 전에 모든 기존 `VehicleEventSource`를 Fixture와 MeshNode까지 해석한다. `supported`+verified가 아닌 source가 하나라도 있으면 rule/node/fixture/status/verifiedAt을 포함한 operator-remediation `23514`로 전체 migration을 중단하며 row를 자동 수정하지 않는다. 통과 후에는 source INSERT/변경, MeshNode capability 변경, enabled rule re-enable, source Fixture의 node 변경에 capability guard를 설치하고 MeshNode/Fixture 변경도 기존 automation statement lock protocol에 참여시킨다. 양방향 source-insert/downgrade 경쟁은 READ COMMITTED, REPEATABLE READ, SERIALIZABLE 두 연결 test로 직렬화 또는 serialization failure를 검증한다.

순방향 migration `20260830_vehicle_sensor_state_ordering`은 MeshNode에 capability revision과 두 model-binding flag를 추가하고 기존 `supported`/`unsupported`를 revision `1`, `unknown`을 revision `0`으로 보수적으로 backfill한다. coherence CHECK와 MeshNode statement/row trigger를 새 컬럼 전체에 다시 연결하며, `ProcessedGatewayEvent.payloadHash`를 nullable로 추가해 기존 원장은 그대로 허용하고 새 hash는 `sha256:<64 lowercase hex>`만 허용한다.

순방향 migration `20260831_node_local_capability_ack_outbox`은 기존 capability 원장의 `fixtureId`를 현재 같은 Gateway의 Fixture/MeshNode 관계로 해석해 `meshNodeId`를 backfill한다. 해석할 수 없는 capability 행이 하나라도 있으면 event/gateway/fixture/sequence와 remediation 지침을 포함한 `23514`로 transaction 전체를 중단하고 신규 컬럼과 UPDATE를 모두 rollback한다. 기존 global `(gatewayId, sequence, eventType)` Unique를 non-capability event 전용 partial unique index로 교체하고, capability에는 `(gatewayId, meshNodeId, sequence, eventType)` partial unique index와 non-null node CHECK를 적용한다. 같은 migration이 `MqttOutbox.applicationAckKey` Unique와 command/config/application-ACK 3종 row-shape CHECK를 설치하고 unsupported capability가 검증 시각과 무관하게 model flag 하나 이상 false이도록 coherence CHECK를 교정한다.

순방향 migration `20260901_automation_mqtt_delivery`는 legacy 실행 원장을 유지하기 위해 nullable `AutomationExecution.payloadHash`와 canonical hash CHECK를 추가하고, `MqttOutbox.supersededAt` 및 automation delivery partial index를 설치한다. 신규 production MQTT ingest만 non-null canonical hash를 기록하며 이전 row를 임의 backfill하지 않는다.

순방향 migration `20260902_snapshot_backed_automation_execution`은 `validate_automation_execution_source`를 교체한다. Current schedule/event source FK가 이미 `NULL`인 신규 history INSERT는 같은 Site/Gateway/revision의 config outbox payload와 row hash가 일치하고 enabled source ID가 해당 immutable snapshot array에 있을 때만 허용한다. Snapshot으로 증명되지 않은 deleted/moved source, 잘못된 kind/rule/sourceType/sourceId는 `23514`로 거부하며 기존 live source owner 검증과 delete 후 `SET NULL` history 보존은 유지한다.

순방향 migration `20260903_revalidate_automation_execution_updates`는 `AutomationExecution_source_check` trigger를 재생성해 기존 owner/source/kind 열에 더해 `revision`과 `payload` UPDATE에도 같은 source 검증 함수를 실행한다. 따라서 snapshot-backed 실행의 revision만 다른 snapshot으로 바꾸거나 action payload의 `sourceType`/`sourceId`만 바꿔 immutable proof를 무효화하는 UPDATE는 `23514`로 거부된다. 기존 정상 INSERT/UPDATE, live source owner 검증과 source 삭제 시 `SET NULL` history 보존 경로는 유지한다.

순방향 migration `20260904_bind_manual_execution_command_source`는 manual `action_result`의 wire identity와 DB relation identity를 구분하면서 기존 실행 payload를 변경하지 않는다. 실행 row의 `manualOverrideId`로 찾은 같은 `ManualOverride`에 대해 legacy `payload.sourceId=ManualOverride.id` 또는 현재 `payload.sourceId=ManualOverride.commandId`만 허용한다. 두 형식 모두 그 override의 `siteId`/`gatewayId`가 실행 owner와 같아야 하며, 다른 override·다른 tenant·무관한 source 결속은 `23514`로 거부된다. migration은 기존 `AutomationExecution.payload`와 `payloadHash`를 rewrite하지 않으므로 immutable execution hash가 유지된다.

순방향 migration `20260830_reject_equal_schedule_times`는 하나의 명시적 PostgreSQL transaction에서 `LightingSchedule`과 `MqttOutbox`에 `SHARE` table lock을 먼저 획득한다. 이 lock은 조회를 허용하면서 두 table의 concurrent INSERT/UPDATE/DELETE를 막으므로, 같은 local start/end를 가진 live `LightingSchedule`과 아직 publish/dead-letter되지 않은 automation-config `MqttOutbox` snapshot entry의 preflight와 CHECK 적용 사이에 invalid row가 들어올 수 없다. 하나라도 발견하면 deferred commit-time trigger가 schedule 또는 outbox 식별자와 Gateway/revision/time을 포함한 `23514` operator-remediation 오류를 발생시켜 transaction 전체를 rollback하며 어떤 row도 자동 수정하거나 삭제하지 않는다. 운영자가 schedule 시간을 명시적으로 교정하고 Gateway full snapshot을 재생성한 뒤 superseded pending outbox만 recovery runbook에 따라 제거해야 migration을 다시 적용할 수 있다.

### ProcessedGatewayEvent

MQTT QoS 1 중복 및 순서 역전을 차단하는 이벤트 원장이다. `eventId`는 모든 event type에서 전역 PK다. Non-capability event는 partial unique `(gatewayId, sequence, eventType)`을 유지하고, `vehicle_sensor_capability`는 node-local partial unique `(gatewayId, meshNodeId, sequence, eventType)`을 사용하며 `meshNodeId`가 반드시 있어야 한다. 이벤트를 Fixture/Gateway snapshot에 반영하기 전에 이 테이블과 마지막 sequence를 확인한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `eventId` | `String` | 예 | PK | Gateway event UUID |
| `gatewayId` | `String` | 예 | FK -> `Gateway.id`, unique tuple | owner Gateway |
| `meshNodeId` | `String?` | capability만 예 | `(id, gatewayId)` 복합 FK -> `MeshNode`, delete cascade/update restrict, partial unique tuple | node-local capability ledger identity; legacy event는 null 허용 |
| `fixtureId` | `String?` | 아니오 | FK -> `Fixture.id`, delete set null | 연결 Fixture snapshot |
| `sequence` | `BigInt` | 예 | unique tuple | event type별 영속 순서, capability에는 `capabilityRevision` 저장 |
| `eventType` | `String` | 예 | unique tuple | 이벤트 계약 식별자 |
| `payloadHash` | `String?` | 아니오 | `NULL` 또는 `sha256:<64 lowercase hex>` CHECK | canonical complete payload hash; legacy event는 null 허용 |
| `scopeKey` | `String?` | 아니오 | immutable identity, FK 없음 | 신규 fixture는 Fixture ID, capability는 canonical MeshNode ID, scan은 session ID, heartbeat는 빈 문자열. 복구 불가능한 legacy는 null |
| `occurredAt` | `DateTime` | 예 |  | Gateway 발생/검증 시각 |
| `receivedAt` | `DateTime` | 예 | `now()` | fixture-state/heartbeat는 API가 packet 수신을 시작한 서버 시각, 그 밖의 producer는 명시하지 않으면 DB row 생성 시각 |
| `ingestionStatus` | `GatewayEventIngestionStatus` | 예 | `accepted` | 정상 처리 또는 durable terminal future timestamp 거부 결과 |
| `createdAt` | `DateTime` | 예 | `now()` | 원장 row 생성 시각 |

`20260912090000_gateway_event_received_time` additive migration은 enum `GatewayEventIngestionStatus`, `receivedAt`, `ingestionStatus`를 추가한다. 기존 원장 행의 `receivedAt`은 기존 `createdAt`으로 backfill하고 `ingestionStatus`는 `accepted`로 기본값을 둔다. migration 파일만 저장소에 추가했으며 이 작업은 사용자 로컬 DB에 적용하지 않는다. disposable 검증 DB에만 migration을 적용한다.

Final Fix에서 기존 fixture-state/heartbeat의 `payloadHash=null` 행은 topic/DB scope 검증과 소유 Fixture/Gateway 행 잠금 뒤에만 보완한다. eventId로 조회한 기존 행의 gateway, fixture(heartbeat는 null), sequence, eventType, occurredAt이 모두 같으면 첫 인증 replay의 canonical hash를 `UPDATE ... WHERE eventId = ... AND payloadHash IS NULL`로 같은 transaction에서 확정한다. 조건부 갱신이 0행이면 재조회한 identity/hash가 정확히 같은 경우만 기존 terminal 결과를 반환하며 다른 replay는 fail-closed 한다. migration-default `accepted` fixture event는 `duplicate` ACK로 종료하고 상태·집계를 다시 반영하지 않는다.

null은 원래 payload 동등성의 증거가 아니며 첫 인증 replay가 과거 원장의 hash를 확정한다는 신뢰 한계가 있다. 새 future rejection은 최초 기록부터 hash를 보유한다. 보완은 hash만 변경하므로 ledger의 `receivedAt`/`ingestionStatus`, fixture/gateway snapshot, energy aggregate/cursor/checkpoint를 보존한다. 기존 `Fixture.lastSeenAt`/`Gateway.lastHeartbeatAt`은 migration도 재작성하지 않으며, 서버 수신 시각 freshness 보장은 새 정상 event가 수락된 값에 적용한다. 과거 장비 시각으로 오염된 값의 소급 정정은 포함하지 않는다. 스키마/migration 파일 자체는 Final Fix에서 변경하지 않는다.

`device_status_ack`도 이 원장을 사용한다. API는 dispatch/command row lock 아래 ACK 전체의 canonical hash를 계산해 `eventId`, Gateway, event type과 함께 먼저 claim한다. 같은 `eventId`·같은 hash의 QoS 1 재전달은 상태를 다시 적용하지 않고, 같은 identity의 Gateway/type/hash가 다르면 정제된 충돌 경고만 남긴 채 payload와 명령 상태를 변경하지 않는다. ACK wire의 command sequence는 새 이벤트마다 증가하지 않으므로 이 event type의 ledger sequence는 같은 Gateway/type 원장 안에서 별도로 할당한다. timeout 뒤 늦은 ACK 수렴도 이 dedupe 경계를 통과한 한 번의 유효 terminal evidence만 반영한다.

`20260915_statistics_operations_retention`부터 모든 신규 소비 경로는 complete payload hash와 scope를 저장하고, 원장·watermark·상태 변경을 같은 transaction에서 commit한다. 보존 선별용 `(eventType, createdAt, eventId)` index를 추가했다. 이 migration은 삭제 worker를 실행하지 않는다.

### GatewayEventWatermark

원장이 정리된 이후에도 stream의 최신 sequence와 payload identity를 보존하는 compact 상태다. `(gatewayId, eventType, scopeKey)`가 PK이며 `lastEventId`는 전역 unique다. `gatewayId`만 cascade FK를 가지므로 Fixture/Node가 사라져도 해당 Gateway의 최신 stream identity는 남는다.

| 컬럼 | 타입 | 의미 |
| --- | --- | --- |
| `gatewayId`, `eventType`, `scopeKey` | `String` | heartbeat와 scan은 빈 scope, fixture는 Fixture ID, capability는 canonical MeshNode ID |
| `lastSequence` | `BigInt` | 양수 high-water. fixture와 capability는 각 scope별로 전진한다 |
| `lastEventId` | `String` | 마지막 이벤트 ID; 다른 stream의 최신 identity 재사용을 차단한다 |
| `lastPayloadHash` | `String?` | complete canonical payload hash. 원본 payload가 없는 legacy 값은 null |
| `lastOccurredAt` | `DateTime` | 마지막 이벤트의 발생 시각 |
| `updatedAt` | `DateTime` | high-water 갱신 시각 |

- gateway/type advisory transaction lock은 첫 INSERT와 cross-fixture 같은 sequence 경쟁을 직렬화한다. 같은 sequence/ID/hash/발생 시각만 duplicate이며 낮은 sequence는 기존 stale ACK 규약으로 처리하고 같은 sequence의 변경된 identity는 거부한다. Fixture cursor/snapshot, capability 상태, raw ledger와 ACK의 기존 추가 검증은 유지한다.
- scan은 기존 gateway/type 전체 순서 의미를 유지한다. 과거 PGE에는 session ID가 없으므로 watermark를 session별로 바꾸지 않으며 새 PGE의 `scopeKey`에는 보존 정책용 session ID를 별도로 기록한다.
- 원장 보존 기간 안에서는 기존 전역 event ID 및 per-type sequence unique/check를 유지한다. 원장 삭제 뒤에는 각 stream의 최신 identity와 단조 high-water만 남는다. 이미 더 높은 값으로 대체된 임의 과거 ID나 다른 fixture의 과거 sequence 충돌까지 영구 기억하지 않는다. Gateway identity 안에서 sequence를 reset/reuse하지 않는 장비 계약이 계속 필요하다.
- migration은 writer 정지 뒤 10초 `lock_timeout`과 명시적 transaction/table barrier 안에서 실행한다. 원장의 동일 sequence 충돌과 snapshot/원장 identity 불일치는 오류로 중단하며 전체 rollback한다. raw 최신 값과 Fixture/Gateway cursor를 비교해 더 높은 값으로 backfill하고, 같은 identity의 실제 hash가 있으면 보존한다. 알 수 없는 event type은 watermark 생성 대상에서 제외한다.
- hash 또는 session scope를 복원할 수 없는 legacy 원장은 추정값으로 채우지 않는다. null hash는 watermark duplicate 검증의 wildcard가 아니며, legacy exact replay는 남아 있는 raw 원장에 의존한다. 특히 legacy scan의 raw scope/hash와 terminal identity는 null로 남으므로 현재 retention worker도 이를 보존한다.
- 같은 migration에서 Session의 `(expiresAt, id)`·`(revokedAt, id)`, FloorMapRevision의 `(createdAt, id)` index를 추가했다. migration 자체는 데이터를 삭제하지 않으며 API의 `RetentionModule`이 아래 보존 worker를 시작한다.
- 검증은 `GATEWAY_EVENT_WATERMARK_TEST=1 pnpm --filter @led-control/api test -- gateway-event-watermark.integration.spec.ts --runInBand`가 직접 만든 임시 PostgreSQL에서 수행했다. 사용자/운영 DB에는 적용하지 않았다.

### 운영 데이터 보존과 복구 범위

`DataRetentionService`는 60초마다 다음 대상을 정리한다. 각 삭제는 안정된 정렬과 `FOR UPDATE SKIP LOCKED`를 사용하는 단일 SQL statement다. 후보의 시각이 cutoff와 같으면 보존하고 더 오래된 행만 제거한다. 수동 호출과 timer는 진행 중 promise를 공유하며 `unref()`·종료 drain을 적용하고, Prisma 연결은 모든 worker의 module destroy 이후 최종 shutdown 단계에서 닫는다.

| 대상 | 보존 기준 | 삭제 전 안전 조건 / 한 sweep 상한 |
| --- | --- | --- |
| `gateway_heartbeat` | 생성 후 7일 | Gateway snapshot·watermark가 원장 이상이며 동일 sequence의 identity가 일치 |
| `fixture_state` | 생성 후 30일 | 동일 gateway의 Fixture snapshot과 energy cursor가 해당 원장을 포괄하고 watermark가 원장 이상 |
| `provisioning_scan_found/completed/failed` | 생성 후 90일 | 전체 등록 session과 scan이 terminal이고 완전한 terminal ACK identity·watermark 유지; terminal 원장은 저장 identity와 정확히 일치 |
| `vehicle_sensor_capability` | 생성 후 365일 | 현재 node revision과 watermark가 모두 원장보다 엄격히 큼; 최신 보고는 보존 |
| `Session` | 만료 또는 폐기 후 30일 | 활성 session 보존; 최대 10,000행 |
| `FloorMapRevision` | floor별 최신 100개 또는 최근 365일 중 넓은 범위 | revision 번호 내림차순으로 최신 100개 보호; 나머지 최대 1,000행 |

이벤트 네 유형은 합산 최대 10,000행이다. 모든 이벤트 후보는 완전한 scope/hash와 최신 watermark가 필요하며 같은 sequence이면 ID/hash/발생 시각도 일치해야 한다. 알 수 없는 유형, legacy 불완전 원장, 삭제된 fixture·cursor 누락처럼 안전 조건을 충족하지 못하는 행은 무기한 남을 수 있다. 배치 상한은 인스턴스의 sweep당 값이며 여러 인스턴스는 서로 잠근 행을 건너뛴다. `data_retention_sweep`는 기준 시각·소요 시간·대상별 삭제 수와 성공/실패를 기록하고 실패 시 `failedStage`와 앞 단계에서 이미 완료된 삭제 수를 남긴다.

임의 과거 event ID의 exact dedupe 보장은 실제 raw 원장이 남아 있는 기간에 한정된다. 원장 정리 이후에는 최신 stream identity/high-water만 유지하므로 장비 sequence를 Gateway identity 안에서 reset/reuse하지 않아야 한다. 도면은 위 보존 범위에서만 복구할 수 있고 제거한 revision의 외부 archive·복구 기능은 없다. 일별 집계와 분석 dimension/membership 이력은 이 worker의 삭제 대상이 아니다.

`Session` 정리는 token hash·IP·user agent의 장기 보유를 줄인다. `AuditLog`의 3년 hot retention은 회사·법무 승인 전의 제안이며 자동 삭제로 구현하지 않았다. `GatewayClaimAudit`와 폐기된 인증서 chain은 제조·보안 감사 보존 대상으로, 설계상 7년 또는 별도 승인 전까지 보존하며 이번 작업에 자동 purge를 포함하지 않는다. 이 문구는 법정 보존 의무나 승인된 삭제 일정의 확정이 아니다.

Prisma Date raw parameter는 timestamptz로 전달되므로 naive UTC `timestamp` 열과 비교할 때 `::timestamptz AT TIME ZONE 'UTC'`를 명시한다. `DATA_RETENTION_TEST=1 pnpm --filter @led-control/api test -- data-retention --runInBand`는 자체 disposable PostgreSQL의 Asia/Seoul session에서 정확한 cutoff·배치 제한·두 connection 잠금/수렴·실제 Nest 종료 연결 회수를 검증한다. 사용자/운영 DB 적용이나 운영 데이터 복구를 실행한 결과는 아니다.

### Invitation

초대 기반 회원가입을 위한 토큰 정보다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 초대 ID |
| `organizationId` | `String` | 예 | FK -> `Organization.id` | 초대 조직 |
| `siteId` | `String?` | 아니오 | FK -> `Site.id` | 초대 대상 현장 |
| `email` | `String?` | 아니오 |  | 초대 이메일 |
| `role` | `UserRole` | 예 |  | 가입 후 권한 |
| `tokenHash` | `String` | 예 | Unique | 초대 토큰 hash |
| `expiresAt` | `DateTime` | 예 |  | 만료 시각 |
| `acceptedAt` | `DateTime?` | 아니오 |  | 수락 시각 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

관계:

- `organization`: `Organization`
- `site`: `Site?`

운영 메모:

- `siteId`는 scoped `operator`/`viewer` 초대의 대상 현장이다. signup transaction은 이 현장이 존재하고, viewer의 경우 초대 조직과 같은 customer Organization에 속하는지 검증한 뒤 membership을 만든다.
- `siteId`가 없거나 잘못된 customer Organization을 가리키는 viewer 초대는 signup 단계에서 거부한다.
- 초대 가입 사용자를 현장 유저 관리에서 영구 삭제할 때는 같은 transaction에서 `organizationId`, `siteId`, trim/lower 정규화 이메일이 모두 일치하고 `acceptedAt IS NOT NULL`인 Invitation만 삭제한다. 미수락 초대와 다른 현장·조직·이메일 초대는 보존하며, `User.email IS NULL`인 admin 직접 생성 사용자는 Invitation 정리를 실행하지 않는다.

### Session

서버 저장 session이다. 브라우저에는 원본 token을 HttpOnly cookie로 저장하고, DB에는 token hash만 저장한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 세션 ID |
| `userId` | `String` | 예 | FK -> `User.id`, delete cascade | 사용자 ID. 사용자 영구 삭제 시 함께 삭제 |
| `familyId` | `String` | 예 | `uuid()` | 최초 로그인부터 보안 상태 변경에 따른 token 회전을 하나로 묶는 세션 계열 ID |
| `rotatedFromSessionId` | `String?` | 아니오 | Unique, self FK -> `Session.id`, delete set null | 이 세션으로 교체된 직전 세션. 하나의 세션에서 둘 이상의 후속 세션이 생기지 않도록 보장 |
| `tokenHash` | `String` | 예 | Unique | 세션 토큰 hash |
| `rememberMe` | `Boolean` | 예 | `false` | 자동 로그인 여부 |
| `userAgent` | `String?` | 아니오 |  | 접속 user agent |
| `ipAddress` | `String?` | 아니오 |  | 접속 IP |
| `expiresAt` | `DateTime` | 예 |  | 만료 시각 |
| `revokedAt` | `DateTime?` | 아니오 |  | 폐기 시각 |
| `mfaVerifiedAt` | `DateTime?` | 아니오 |  | TOTP 또는 복구 코드까지 검증해 발급한 세션의 MFA 검증 시각 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

관계:

- `user`: `User`
- `rotatedFrom`: 직전 `Session?`
- `rotatedTo`: 이 세션에서 이어진 `Session[]`이며 unique 제약으로 최대 1개

`userId + revokedAt + expiresAt` 복합 index는 사용자별 활성 세션 조회와 일괄 폐기를 지원한다.
`userId + familyId + revokedAt` 복합 index는 회전 전 token으로 들어온 로그아웃과 세션 폐기가 현재 활성 후속 세션을 찾도록 지원한다.
최초 로그인은 새 `familyId`를 만든다. 비밀번호 변경과 MFA 등록·해제는 사용자 행을 잠근 transaction에서 현재 세션을 다시 검증하고 기존 활성 세션을 모두 폐기한 뒤, 현재 세션의 `familyId`와 접속 정보·만료 시각을 승계하고 `rotatedFromSessionId`로 직전 행을 가리키는 새 token hash 행을 만든다.
로그아웃은 이미 폐기된 token도 조회한 뒤 사용자 행을 잠그고 같은 family의 활성 세션을 모두 폐기한다. 따라서 회전 응답과 로그아웃 응답 순서가 뒤바뀌어도 새 cookie가 세션을 되살리지 않는다.
활성 세션 API는 요청 사용자 ID와 `revokedAt IS NULL`, 미래 만료 시각을 모두 적용해 조회한다. 개별 폐기는 대상 세션의 family 전체를 폐기하고, 다른 세션 전체 폐기는 현재 family만 남긴다. 두 작업도 사용자 행 잠금과 family 재검증 아래 실행되므로 token 회전과 직렬화된다.

### UserMfa

operator/admin의 활성 TOTP 설정이다. 사용자와 1:1이며 viewer는 애플리케이션 정책상 생성할 수 없다. 원본 비밀키는 `MFA_ENCRYPTION_KEY`로 AES-256-GCM 암호화하고, 복구 코드는 원문을 보관하지 않는다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `userId` | `String` | 예 | PK, FK -> `User.id`, delete cascade | MFA 소유 사용자 |
| `secretCiphertext` | `String` | 예 |  | 버전·nonce·ciphertext·인증 태그를 포함한 암호화 TOTP 비밀키 |
| `recoveryCodeHashes` | `String[]` | 예 |  | 아직 사용하지 않은 고엔트로피 복구 코드의 SHA-256 hash |
| `lastUsedTotpCounter` | `Int` | 예 | `-1` | 마지막으로 수락한 RFC 6238 30초 counter. 더 큰 counter만 수락해 같은 TOTP 재사용을 차단 |
| `enabledAt` | `DateTime` | 예 | `now()` | MFA 활성화 시각 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

관계:

- `user`: `User`

`20260916090000_account_security` migration은 `UserMfa`, `Session.mfaVerifiedAt`, 사용자별 활성 세션 조회 index를 추가한다.
`20260916120000_harden_session_rotation_and_totp` migration은 세션 계열과 회전 self FK, TOTP 마지막 counter를 추가한다. 기존 세션은 각 행의 `id`를 `familyId`로 backfill해 서로 무관한 기존 브라우저 세션이 한 계열로 합쳐지지 않는다. 기존 MFA 행은 알 수 없는 과거 counter 대신 `-1`에서 시작하고 다음 성공 검증부터 단조 증가를 강제한다.
이번 작업의 migration 검증은 사용자 DB가 아닌 새 일회용 PostgreSQL에서만 수행한다. 이는 사용자 DB 적용 또는 운영 배포 증거가 아니다.

### ProvisioningSession

층/게이트웨이 단위 조명 검색 및 등록 작업 세션이다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 등록 세션 ID |
| `siteId` | `String` | 예 | FK -> `Site.id` | 현장 ID |
| `floorId` | `String` | 예 | FK -> `Floor.id` | 등록 대상 층 |
| `gatewayId` | `String` | 예 | FK -> `Gateway.id` | 스캔/등록 게이트웨이 |
| `requestedBy` | `String` | 예 | FK -> `User.id`, delete restrict | 요청 사용자. provisioning을 수행하지 않는 일반 viewer 영구 삭제 범위에는 생기지 않으며, 이력이 있으면 사용자 삭제를 차단 |
| `status` | `ProvisioningSessionStatus` | 예 | `active` | 세션 상태 |
| `scanStatus` | `ProvisioningScanStatus` | 예 | `pending` | `pending`, `scanning`, `completed`, `failed` |
| `scanCorrelationId` | `String?` | 아니오 | UUID | scan 시도별 correlation ID |
| `scanAttempt` | `Int` | 예 | `0` | scan 재시도 횟수. 실제 scan은 1부터 시작 |
| `scanStartedAt` | `DateTime?` | 아니오 |  | 현재 scan 시작 시각 |
| `scanCompletedAt` | `DateTime?` | 아니오 |  | 완료 또는 실패 수신 시각 |
| `scanFailureCode` | `String?` | 아니오 |  | Gateway가 분류한 비밀값 없는 실패 코드 |
| `scanFailureMessage` | `String?` | 아니오 |  | 사용자 노출 가능한 실패 설명 |
| `scanTerminalEventId` | `String?` | 아니오 | terminal identity CHECK | 마지막으로 commit한 terminal event ID |
| `scanTerminalSequence` | `BigInt?` | 아니오 | 양수 | terminal의 sequence |
| `scanTerminalEventType` | `String?` | 아니오 | completed/failed 두 event type만 허용 | terminal 종류 |
| `scanTerminalPayloadHash` | `String?` | 아니오 | canonical SHA-256 | acceptedNodeCount 또는 failure message를 포함한 전체 terminal hash |
| `scanTerminalIngestedAt` | `DateTime?` | 아니오 | 최초 ACK 시각 | raw와 ACK outbox가 모두 없어도 같은 ACK payload 재생성 |
| `startedAt` | `DateTime` | 예 | `now()` | 시작 시각 |
| `completedAt` | `DateTime?` | 아니오 |  | 완료 시각 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

관계:

- `site`: `Site`
- `floor`: `Floor`
- `gateway`: `Gateway`
- `user`: `User`
- `discoveredNodes`: `DiscoveredMeshNode[]`
- `scanOutbox`: `ProvisioningScanOutbox[]`
- `deviceOutbox`: `ProvisioningDeviceOutbox[]`

등록 시작 계약:

- `POST /registration-sessions`는 `siteId`, `floorId`, `gatewayId`를 모두 명시적으로 받는다. Floor와 Gateway는 모두 해당 Site에 속해야 하고, Gateway의 `lastHeartbeatAt`은 API 현재 시각 기준 정확히 90초 전을 포함해 90초 이내여야 한다. 등록·식별·제어 안전성 판단은 기존 공통 freshness helper를 사용하며, 모니터링 표시와 sweep은 별도의 Site 정책을 사용한다.
- `POST /registration-sessions`와 retry는 `pending` session state, 새 correlation/attempt와 `ProvisioningScanOutbox` row를 하나의 transaction에서 만든다. partial unique index `ProvisioningSession_single_scanning_gateway_key`는 `status=active`인 Gateway 하나에만 `pending` 또는 `scanning` scan 하나를 허용한다.
- `20260826150000_add_provisioning_scan_outbox` migration은 foundation migration이 남긴 모든 historical `pending/scanning` session을 `failed` (`legacy_scan_closed`) terminal state로 먼저 수렴시킨 뒤 active-only partial unique index를 만든다. 당시에는 durable scan-start outbox가 없었으므로 과거 active session도 재발행하지 않고 종료하는 fail-closed migration 정책이다.
- publisher는 leased outbox를 처리할 때만 `pending -> scanning`으로 전이한 뒤 strict v2 scan-start payload를 발행한다. MQTT callback timeout은 기본 10초(`PROVISIONING_SCAN_OUTBOX_PUBLISH_TIMEOUT_MS`)로 30초 lease보다 짧아야 하며, timeout/reject는 attempt backoff로 기록한다. publish 전 process crash는 lease 만료 뒤 같은 correlation/attempt로 재시도하며, 최대 3회 또는 5분 실패는 outbox dead-letter와 `scan_start_publish_failed` terminal state를 같은 transaction에서 기록한다.
- found/completed/failed event는 session, correlation ID, attempt와 topic scope가 현재 행과 일치할 때만 반영한다. `ProcessedGatewayEvent`와 gateway/type watermark는 같은 transaction에서 중복·낮은 sequence를 차단한다. completed/failed는 원장·watermark·session terminal identity와 ACK outbox를 같은 transaction에 저장한다. 신규 terminal identity의 5개 컬럼은 전부 null 또는 전부 non-null이어야 한다. 동일 terminal은 현재 session identity/hash/snapshot과 맞을 때 raw 삭제 뒤에도 최초 `ingestedAt`의 application ACK를 재발행하며, 상태나 acceptedNodeCount/failure message를 변경한 재전송은 거부한다. Legacy terminal은 기존 raw/ACK 원장이 있어야 동일하게 재발행할 수 있다.
- 등록 batch는 node를 `provisioning`으로 바꾸고 command ID, session/site/gateway/node/device/address identity를 가진 `ProvisioningDeviceOutbox` row를 같은 transaction에서 만든다. HTTP `accepted`는 broker 연결이나 PUBACK이 아니라 이 durable transaction의 commit을 뜻한다.

### ProvisioningScanOutbox

등록 search command의 durable transactional outbox다. CommandDispatch에 1:1로 결합된 `MqttOutbox`와 분리되어 있으며, `ProvisioningSession`의 scan attempt를 gateway MQTT publish와 원자적으로 연결한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | outbox ID |
| `sessionId` | `String` | 예 | FK -> `ProvisioningSession.id`, delete cascade | 등록 세션 |
| `scanAttempt` | `Int` | 예 | Unique with `sessionId` | scan 재시도 번호 |
| `topic` | `String` | 예 |  | strict v2 scan-start MQTT topic |
| `payload` | `Json` | 예 |  | correlation, scope, attempt를 가진 strict scan-start payload |
| `attempts` | `Int` | 예 | `0` | publisher MQTT 실패 횟수 |
| `nextAttemptAt` | `DateTime` | 예 | `now()` | retry 가능 시각 |
| `lockedBy`, `lockedAt`, `leaseExpiresAt` | nullable | 아니오 | worker lease | crash 후 다른 worker의 reclaim 경계 |
| `publishedAt`, `deadLetteredAt` | nullable | 아니오 | terminal marker | 성공 publish 또는 재시도 포기 시각 |
| `lastError` | `String?` | 아니오 |  | 내부 publisher 오류. 사용자 API 응답에 그대로 노출하지 않음 |

### ProvisioningDeviceOutbox

node별 `provision-device` command의 durable transactional outbox다. 등록 API의 node 상태·Mesh 주소·pending Fixture 정보와 같은 transaction에서 생성되며, 기존 command/scan outbox와 독립적으로 lease를 관리한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, command UUID | outbox와 strict command가 공유하는 identity |
| `sessionId` | `String` | 예 | FK -> `ProvisioningSession.id`, delete cascade | 등록 세션 |
| `nodeId` | `String` | 예 | FK -> `DiscoveredMeshNode.id`, delete cascade | 등록 대상 node |
| `topic` | `String` | 예 |  | gateway-scoped `provision-device` topic |
| `payload` | `Json` | 예 |  | command/session/site/gateway/node/device/address/requestedAt strict payload |
| `attempts` | `Int` | 예 | `0` | publisher MQTT 실패 횟수 |
| `nextAttemptAt` | `DateTime` | 예 | `now()` | retry 가능 시각 |
| `lockedBy`, `lockedAt`, `leaseExpiresAt` | nullable | 아니오 | worker lease | `SKIP LOCKED` claim과 crash reclaim 경계 |
| `publishedAt`, `deadLetteredAt` | nullable | 아니오 | terminal marker | broker PUBACK 또는 재시도 포기 시각 |
| `lastError` | `String?` | 아니오 |  | 내부 publisher 오류. 사용자 응답에는 고정 문구만 사용 |

운영 계약:

- `20260905090000_add_provisioning_device_outbox` migration만 새로 추가하며 이전 migration은 변경하지 않는다.
- worker는 30초 lease보다 짧은 기본 10초 publish timeout, 최대 10회 또는 15분, 최대 60초 exponential backoff를 사용한다. outbox ID/session/node/topic과 payload identity, 잠근 node의 현재 session/site/gateway/device/address/status를 모두 확인한 뒤 QoS 1 발행을 시작한다.
- broker PUBACK 뒤에만 `publishedAt`을 기록한다. 한계를 넘으면 outbox deadletter와 node의 `reconcile_required` 전이를 한 transaction에 기록하며 Mesh 주소와 pending Fixture 정보는 변경하지 않는다.
- 한 node의 과거 published/deadletter 원장을 보존한 채 후속 명시적 재조정 command를 만들 수 있도록 `nodeId`는 unique가 아니라 일반 index다.

### DiscoveredMeshNode

등록 세션 중 발견된 미등록 ESP32-H2 노드 후보 목록이다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 발견 노드 ID |
| `sessionId` | `String` | 예 | FK -> `ProvisioningSession.id` | 등록 세션 |
| `deviceUuid` | `String` | 예 | Unique with `sessionId` | BLE Mesh device UUID |
| `serialNumber` | `String` | 예 |  | 장비 시리얼 |
| `rssi` | `Int` | 예 |  | 발견 시 RSSI |
| `oobCapability` | `String` | 예 |  | OOB capability |
| `firmwareVersion` | `String` | 예 |  | 펌웨어 버전 |
| `scanCorrelationId` | `String?` | 아니오 |  | API가 검증한 발견 이벤트의 scan correlation ID. legacy row는 `null` |
| `scanAttempt` | `Int?` | 아니오 |  | API가 검증한 발견 이벤트의 scan 재시도 번호. legacy row는 `null` |
| `status` | `DiscoveredNodeStatus` | 예 | `discovered` | 발견 노드 상태 |
| `identifyState` | `String` | 예 | `idle` | 점멸 확인 상태 |
| `meshAddress` | `String?` | 아니오 |  | 할당 예정 또는 할당된 mesh address |
| `pendingFixtureName` | `String?` | 아니오 |  | provisioning 완료 후 생성할 fixture 이름 |
| `pendingFixtureX` | `Float?` | 아니오 |  | provisioning 완료 후 생성할 fixture X 좌표 |
| `pendingFixtureY` | `Float?` | 아니오 |  | provisioning 완료 후 생성할 fixture Y 좌표 |
| `pendingFixtureSize` | `Float?` | 아니오 |  | provisioning 완료 후 생성할 fixture marker 크기 |
| `pendingRatedWatt` | `Decimal(8,2)?` | 아니오 |  | provisioning 완료 후 생성할 fixture 정격 전력 |
| `errorMessage` | `String?` | 아니오 |  | 실패 사유 |
| `discoveredAt` | `DateTime` | 예 | `now()` | 발견 시각 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

제약:

- 복합 Unique: `sessionId`, `deviceUuid`
- `scanCorrelationId`, `scanAttempt`는 새 migration에서 nullable로 추가한다. 신뢰할 수 있는 attempt identity가 없는 기존 row는 backfill하지 않으며 Web 후보 판정에서 fail-closed로 제외한다.
- 같은 세션의 동일 `deviceUuid`가 다음 scan attempt에서 다시 발견되면 upsert update가 두 identity 필드를 현재 검증된 event 값으로 덮어쓴다. `discoveredAt`은 gateway 발생 시각이며 attempt 경계 판정에 사용하지 않는다.

등록 동시성 및 복구 계약:

- batch 요청은 session과 선택 node 행을 안정된 ID 순서로 잠그고, 유효한 node에 대해서만 층 이름 순번과 gateway Mesh 주소 범위를 같은 transaction에서 예약한다.
- 일괄 자동 좌표는 저장된 도면 크기 또는 기본 `1200x800` canvas 안에서 기존 fixture와 겹치지 않는 행 우선 grid cell을 사용한다.
- MQTT publish 오류나 provisioning failure event처럼 물리 적용 여부가 불명확한 결과는 `reconcile_required`로 기록한다. 이 상태는 device UUID와 gateway mapping을 확인하기 전 다시 provisioning하면 안 된다.
- provisioning 완료 event는 pending 이름, 좌표, 정격 전력과 marker 크기를 `Fixture` 생성에 사용한다.

관계:

- `session`: `ProvisioningSession`
- `deviceOutbox`: `ProvisioningDeviceOutbox[]`

### EnergyUsage

조명별 전력 사용량과 예상 요금 집계 테이블이다. MVP에서는 추정값 중심으로 사용한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 사용량 ID |
| `fixtureId` | `String` | 예 | FK -> `Fixture.id` | 대상 조명 |
| `source` | `String` | 예 |  | `estimated`, `measured`, `adjusted` 등 |
| `period` | `String` | 예 |  | 일/월/년 또는 집계 기간 |
| `kwh` | `Decimal(12,4)` | 예 |  | 사용 전력량 |
| `cost` | `Decimal(12,2)` | 예 |  | 예상 요금 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |

관계:

- `fixture`: `Fixture`

### EnergyFixtureIdentity / EnergyFixtureDimensionVersion

운영 조명 레코드와 분석 이력을 분리하는 영구 identity다. `Fixture` 삭제 시 `fixtureId`만 `null`이 되고 identity, 일별·시간별 집계, 이름·층·정격 전력 이력은 유지된다. Dimension version은 분석 기능 활성화 이후 변경만 기록하며 migration 이전 구조를 추정해 만들지 않는다.

- `EnergyFixtureIdentity.fixtureId`는 nullable unique이며 `Fixture.id` 삭제 시 `SET NULL`이다.
- `trackingStartedAt` 이전의 일별 집계는 현장 합계에는 포함할 수 있지만 층·조명 구조 순위에서는 제외한다.
- `EnergyFixtureDimensionVersion`은 이름, 층 ID/이름, 정격 W와 `[effectiveFrom, effectiveTo)`를 저장한다.
- 같은 identity와 시작 시각은 unique이고 종료 시각은 시작 시각보다 뒤여야 한다.

### EnergyGroupIdentity / EnergyGroupDimensionVersion / EnergyGroupMembershipVersion

그룹 이름과 조명 소속의 유효기간 이력을 보존한다. 운영 그룹 삭제 후에도 분석 identity는 남고 `groupId`만 `null`이 된다. 한 조명은 같은 시점에 여러 그룹에 속할 수 있으므로 그룹별 합계를 현장 총합으로 해석하지 않는다.

- 그룹 이름과 membership은 각각 `[effectiveFrom, effectiveTo)` 범위로 관리한다.
- 신규 migration은 현재 구조만 활성화 시각부터 기록하며 과거 그룹 구조를 backfill하지 않는다.

### FixtureEnergyDailyAggregate

상태 기반 전력 추정의 정본이다. legacy `EnergyUsage`의 의미와 데이터는 변경하지 않는다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 집계 ID |
| `fixtureId` | `String?` | 아니오 | FK -> `Fixture.id`, delete set null | 현재 운영 조명 연결 |
| `energyFixtureId` | `String` | 예 | FK -> `EnergyFixtureIdentity.id` | 영구 분석 조명 identity |
| `localDate` | `Date` | 예 | Unique with `energyFixtureId` | Site timezone 기준 현지 날짜 |
| `estimatedKwh` | `Decimal(20,12)` | 예 |  | 상태 기반 추정 사용량 |
| `estimatedCost` | `Decimal(20,8)` | 예 |  | 적산 당시 단가 기준 예상 비용 |
| `knownSeconds` | `Int` | 예 | `0`, non-negative check | 유효 상태로 계산한 시간 |
| `unknownSeconds` | `Int` | 예 | `0`, non-negative check | 첫 상태 이전 또는 수집 공백 시간 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 갱신 시각 |

제약:

- 복합 Unique: `energyFixtureId`, `localDate`
- Index: `fixtureId`, `localDate`
- Index: `localDate`
- `knownSeconds`, `unknownSeconds`는 음수가 될 수 없다.
- migration은 모든 기존 Fixture의 `energyTrackingStartedAt`에 적용 시각을 저장한다. 따라서 그 이전 구간을 추정하거나 `EnergyUsage`를 새 집계로 backfill하지 않는다.

### FixtureEnergyHourlyAggregate

상태 구간을 UTC 정각 경계로 나눈 시간별 분석 집계다. `bucketStartUtc`와 함께 현장 timezone의 `localDate`, `localHour`, `utcOffsetMinutes`를 저장해 DST 반복 시간을 구분한다. 일별 집계를 시간별로 임의 분배하는 backfill은 하지 않는다.

- 복합 Unique: `energyFixtureId`, `bucketStartUtc`
- `estimatedKwh`, `knownSeconds`, `unknownSeconds`, `brightnessWeightedSeconds`는 음수가 될 수 없다.
- 시간별 데이터는 24개월까지만 보존하고, 일별 집계와 dimension history는 장기 보존한다.

### FixtureEnergyStateCursor

조명별 마지막 적산 checkpoint다. `aggregatedThrough` 이후 구간만 계산하고, 마지막 관측 상태와 정격 전력 및 duration remainder를 보존해 재시작·재전달에도 같은 결과를 만든다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `fixtureId` | `String` | 예 | PK, FK -> `Fixture.id`, delete cascade | 대상 조명 |
| `aggregatedThrough` | `DateTime` | 예 |  | 적산 완료 checkpoint |
| `observedStateOccurredAt` | `DateTime?` | 아니오 |  | 마지막 유효 상태 관측 시각 |
| `brightness` | `Int` | 예 | DB check `0..100` | 마지막 밝기 |
| `powerOn` | `Boolean?` | 아니오 |  | 마지막 전원 상태 |
| `ratedWatt` | `Decimal(8,2)` | 예 |  | 해당 checkpoint 구간의 정격 전력 |
| `durationRemainders` | `Json` | 예 |  | 날짜 분할 시 소수 시간 잔여값 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 갱신 시각 |

`ProcessedGatewayEvent.fixtureId`는 상태 이벤트의 조명 원장 연결을 보존한다. API는 이벤트 원장, 이 cursor, `FixtureEnergyDailyAggregate`, `FixtureEnergyHourlyAggregate`, Fixture 최신 상태를 하나의 transaction으로 갱신한다.

## 4. 주요 제약 조건 요약

| 테이블 | 제약 | 설명 |
| --- | --- | --- |
| `User` | Unique `email` | 이메일 중복 가입 방지 |
| `FloorPlan` | Unique `floorId` | 한 층에 하나의 현재 도면 |
| `FloorLightSlot` | `(floorId, capacityOrdinal)` Unique와 ordinal 범위 CHECK, Unique `sourceCandidateId`, nullable Unique `assignedFixtureId`, finite geometry CHECK와 deferred scope trigger | REPEATABLE READ 동시 쓰기에서도 층별 2,000개 상한과 후보별 슬롯·조명별 할당 중복을 막고 job/candidate/fixture의 층 일치를 강제 |
| `FloorMapObject` | Index `floorId`, `zIndex` | 한 층 안에서 편집 객체 렌더링 순서 조회 최적화 |
| `Fixture` | Unique `meshNodeId`, Unique `id + siteId + gatewayId`, composite Floor/MeshNode owner FK와 projection trigger | 하나의 메시 노드는 하나의 조명에만 연결하고 자동화가 참조할 Site/Gateway owner를 구조적으로 투영 |
| `Gateway` | Unique `serialNumber` | 게이트웨이 시리얼 중복 방지 |
| `Gateway` | Unique `id + siteId` | 자동 제어 owner의 Gateway/Site 복합 FK 기준 제공 |
| `Floor`, `MeshNode` | Unique `id + ownerId`, Fixture owner FK `ON UPDATE CASCADE` | owner 변경을 Fixture projection에 전달하고 downstream automation FK가 참조 중인 변경은 차단 |
| `GatewayInventory` | Unique `serialNumber`, nullable `certificateFingerprint`, `claimedGatewayId` | 인증서 발급 전 제조 identity 생성과 발급 후 fingerprint 확정 지원 |
| `GatewayEnrollment` | Unique `tokenHash`, partial unique `serialNumber WHERE usedAt IS NULL`, Index `serialNumber + createdAt` | secret hash 중복, serial별 미사용 enrollment 단일성, token 재사용 방지와 제조 이력 조회 |
| `GatewayCertificate` | DB enum purpose/status; Unique `fingerprint`, `replacedById`, `issuer + certificateSerial`; partial unique `inventoryId WHERE purpose = mqtt AND status = active`; self-replacement Check; inventory/replacement delete Restrict | 인증서 수명주기와 inventory별 단일 active MQTT 인증서, 감사 가능한 1:1 교체 체인 추적 |
| `CommandDispatch` | Unique `idempotencyKey`, `gatewayId + sequence` | 중복 명령과 순서 충돌 방지 |
| `Command` | Unique `siteId + requestedBy + clientRequestId`; nullable requester FK delete set null | 사용자 재시도 멱등성과 사용자 삭제 뒤 명령 이력 익명화 |
| `EnergyFixtureIdentity` | Unique nullable `fixtureId`, Site cascade, Fixture delete set null | 운영 조명 삭제 뒤 분석 이력 보존 |
| `EnergyFixtureDimensionVersion` | Unique `energyFixtureId + effectiveFrom`, partial Unique open row, ordered effective range | 이름·층·정격 전력 이력 보존 |
| `EnergyGroupIdentity` / `EnergyGroupMembershipVersion` | nullable operational group link, partial Unique open row, effective range constraints | 그룹 삭제·복수 소속 이력 보존 |
| `FixtureEnergyDailyAggregate` | Unique `energyFixtureId + localDate`, localDate index, non-negative seconds check | 영구 identity 기준 일별 idempotent upsert와 기간 조회 |
| `FixtureEnergyHourlyAggregate` | Unique `energyFixtureId + bucketStartUtc`, local/UTC indexes, non-negative check | DST-safe 시간별 집계와 bounded retention |
| `FixtureEnergyStateCursor` | PK/FK `fixtureId`, brightness `0..100` check | 조명별 단일 적산 checkpoint와 밝기 범위 보장 |
| `CommandFixtureResult` | PK `dispatchId + fixtureId` | dispatch별 조명 결과 중복 방지 |
| `ProcessedGatewayEvent` | PK `eventId`, non-capability partial Unique `gatewayId + sequence + eventType`, capability partial Unique `gatewayId + meshNodeId + sequence + eventType` | 전역 event 중복과 legacy Gateway/node-local capability stale 이벤트 방지 |
| `MeshNode` | Unique `deviceUuid` | BLE Mesh device UUID 중복 방지 |
| `MeshNode` | Unique `gatewayId`, `meshAddress` | 같은 게이트웨이 내 mesh address 중복 방지 |
| `MeshNode` | vehicle sensor capability status/verifiedAt CHECK, capability statement lock과 enabled-source downgrade guard | 검증된 지원 노드만 차량 이벤트 source로 사용하고 기존·미확인 노드는 fail-closed |
| `MeshControlGroup` | Unique `gatewayId + targetType + targetId`, Unique `gatewayId + groupAddress` | gateway별 영속 제어 group 중복과 주소 충돌 방지 |
| `MeshControlGroupMember` | PK `groupId + meshNodeId`, Index `groupId + gatewayId`, Index `meshNodeId + gatewayId` | 같은 group/node membership 중복 방지, cross-gateway group/node FK 검증, gateway 내부 membership 조회 가속 |
| `MeshControlGroupExpectedOperation` | PK `operationId`, Unique `groupId + configurationVersion + action + meshNodeId + meshAddress` | version별 exact ACK와 동일 node address replacement 2-operation 보존 |
| `MeshControlGroupAppliedMember` | PK `groupId + meshNodeId + meshAddress`, Index `groupId + gatewayId` | partial success를 포함한 cloud 확인 실제 subscription pair snapshot |
| `GroupFixture` | PK `groupId`, `fixtureId` | 같은 조명의 그룹 중복 매핑 방지 |
| `Invitation` | Unique `tokenHash` | 초대 토큰 hash 중복 방지 |
| `Session` | Unique `tokenHash`, `userId + revokedAt + expiresAt` index | 세션 토큰 hash 중복 방지와 사용자별 활성 세션 조회·폐기 가속 |
| `UserMfa` | PK/FK `userId`, delete cascade | 사용자별 TOTP 설정 하나만 허용하고 계정 삭제 시 보안 정보 제거 |
| `SiteDeletionCleanup` | Unique `siteId`, retry/lease index | 현장별 외부 정리 작업 1개와 다중 API instance의 crash-safe 재시도 |
| `DiscoveredMeshNode` | Unique `sessionId`, `deviceUuid` | 같은 등록 세션 안에서 발견 노드 중복 방지 |
| `ProvisioningSession` | Partial unique `gatewayId WHERE scanStatus IN (pending, scanning)` | Gateway당 outbox 대기·실행 중 scan 1개 제한 |
| `ProvisioningScanOutbox` | Unique `sessionId + scanAttempt`, retry/lease index | 같은 scan attempt의 중복 outbox 생성 방지와 crash-safe reclaim |
| `FixtureGroup` | active boundary check, deferred group/member trigger, `siteId + floorId + gatewayId + lifecycleStatus` index | legacy 격리와 활성 구역 경계·member 수 제한 |
| `GatewayAutomationConfiguration` | PK `gatewayId`, Unique/FK `gatewayId + siteId`, ordered revisions, state-dependent check | Gateway별 단일 full snapshot 적용 상태와 PENDING/APPLIED/REJECTED coherence |
| `LightingSchedule` | active/time/distinct local times/unique recurrence/brightness/revision checks, non-negative `targetCount`, Unique `id + siteId + gatewayId` | 반복 스케줄 범위, 암묵적 full-day 차단, child owner 기준, 실제 target 수 reconciliation 강제 |
| `LightingScheduleFixture` | PK `scheduleId + fixtureId`, parent/Fixture owner composite FK, counter maintenance + deferred nonempty/reconciliation trigger | 스케줄 대상 snapshot 중복·tenant/Gateway·isolation-safe 최소 1개 강제 |
| `VehicleEventRule` | brightness `0..100`, hold `5..1800`, ordered revisions, non-negative source/target counters, Unique `id + siteId + gatewayId` | 차량 감지 action 범위와 실제 source/target 수 reconciliation 강제 |
| `VehicleEventSource`, `VehicleEventTarget` | PK `ruleId + fixtureId`, parent/Fixture owner composite FK, counter maintenance + deferred nonempty/reconciliation trigger; source는 verified-supported MeshNode trigger | source/target 중복·tenant/Gateway·isolation-safe 각 최소 1개와 source capability 강제 |
| `ManualOverride` | Unique `commandId`, direct Command FK delete cascade, nullable requester/legacy `overrideUntil`, brightness/time checks, non-negative `targetCount` | command별 수동 기본 밝기 감사, timed history 호환, 사용자 삭제 뒤 이력 익명화, 실제 target 수 reconciliation 강제 |
| `ManualOverrideFixture` | PK `manualOverrideId + fixtureId`, parent/Fixture owner composite FK, counter maintenance + deferred nonempty/reconciliation trigger | 수동 대상 중복·tenant/Gateway·isolation-safe 최소 1개 강제 |
| `MqttOutbox` | command/config/application-ACK row-shape check, Unique `gatewayId + revision + payloadHash`, Unique `applicationAckKey`, non-superseded automation delivery partial index | requester 없는 command payload와 과거 row scrub, 최신 config snapshot만 발행, durable application ACK dedupe |
| `AutomationExecution` | Unique `gatewayId + eventId + sequence`, canonical payload hash CHECK, ordered schedule/vehicle general indexes, partial vehicle-detected index, source owner/kind/rule trigger | Gateway lifecycle exact replay 멱등성·conflict 거부, 최신 실행·감지 조회와 tenant-consistent history 원장 |
| `AutomationExecutionFixtureResult` | PK `executionId + fixtureSnapshotId`, identity/terminal-status checks | Fixture 삭제 뒤 snapshot ID 보존과 terminal 결과만 저장 |

## 5. 현재 구현 기준으로 중요한 데이터 흐름

### 로그인

```text
User.loginId/password
→ Redis IP·계정·고객사/IP 제한 확인
→ AuthService 비밀번호 검증
→ MFA 미사용 계정은 Session 생성
→ MFA 사용 operator/admin은 Redis 일회성 challenge 발급
→ TOTP 또는 미사용 복구 코드 검증 뒤 Session 생성
→ HttpOnly cookie 발급
→ 이후 API 요청에서 Session token hash 검증
```

### 모니터링

```text
실제 Raspberry Pi gateway
→ Generic OnOff/Lightness/Health Current의 coherent MQTT v2 fixture-state event
→ Fixture brightness/status/RSSI/hop/lastSeenAt과 healthFaultCodes/healthLastSeenAt 갱신
→ GET /sites/default/dashboard
→ 웹 모니터링 화면 표시
```

### 게이트웨이 상태

```text
Gateway heartbeat MQTT event
→ Gateway.lastHeartbeatAt 갱신
→ dashboard API에서 online/offline 계산
→ 웹 상단/상세 패널 표시
```

### 조명 제어

```text
웹 제어 요청
→ Command pending/outcome=pending 생성
→ MQTT dimming Set 발행
→ acceptance 진행 상태 반영 및 device-status ACK의 eventId/hash 중복 제거
→ 적용 여부가 불확실하면 outcome=unknown
→ control 권한 사용자가 POST /commands/{id}/status-checks
→ dispatch당 최대 64개로 chunk한 status_check outbox 생성(논리 시도 최대 3회)
→ Gateway durable receipt 뒤 Generic OnOff/Lightness Get
→ 모든 chunk 관측 결과를 expected brightness와 비교해 outcome 수렴
→ not_applied에서만 Web이 새 clientRequestId의 안전 재적용을 제공
```

HTTP 응답 유실 복구는 기존 dimming/status-check `clientRequestId`로 저장 결과를 재조회할 뿐 새 물리 Set을 만들지 않는다. 실제 재적용은 `not_applied` 확인 뒤 사용자가 명시적으로 실행하는 새 Command다.

### 조명 검색/등록

```text
ProvisioningSession pending + ProvisioningScanOutbox 생성 transaction
→ leased publisher가 pending -> scanning 전이
→ gateway scan command 발행
→ gateway-scoped v2 `provisioning/scan-found` event
→ 검증된 scanCorrelationId/scanAttempt와 함께 DiscoveredMeshNode upsert
→ identify 확인
→ register-batch 요청에서 node별 검증
→ 유효 node의 이름 순번·Mesh 주소 원자 예약과 pending fixture 정보 저장
→ gateway provision-device command를 장치별 직렬 처리
→ provisioning-completed event
→ MeshNode 생성 또는 기존 MeshNode 재사용
→ Fixture 생성 또는 기존 Fixture 유지
→ provisioning-failed 또는 불명확 publish 결과는 DiscoveredMeshNode reconcile_required/errorMessage 갱신
```

### 현장·층 초기 설정

```text
최초 로그인 또는 빈 조직 상태
→ Site 생성
→ Floor 일괄 생성
→ 선택적으로 FloorPlan 생성
→ 선택적으로 Gateway 수동 등록
→ 조명 검색/등록 가능 상태
```

현장·층 온보딩 MVP 1에서는 `Site`, `Floor`, `FloorPlan`, `Gateway` 기존 모델을 그대로 사용한다. 층별 게이트웨이 커버리지, 주차면 수, 층 설명은 실제 파일럿 요구가 확인된 뒤 별도 컬럼 또는 테이블로 분리한다.

### 층별 도면 에디터

```text
GET /floors/{floorId}/editor-state
→ Floor, FloorPlan, Fixture, FloorMapObject 조회
→ 웹 에디터에서 도면 배경, 도형, 텍스트, 조명 위치 draft 편집
→ PATCH /floors/{floorId}/floor-plan
→ POST/PATCH/DELETE /floor-map-objects
→ PATCH /fixtures/{fixtureId}
→ dashboard query 갱신
```

모든 조회와 수정은 `Floor -> Site -> Organization`, `Fixture -> Floor -> Site -> Organization`, `FloorMapObject -> Floor -> Site -> Organization` 경로로 로그인 사용자의 조직 범위를 검증한다.

## 6. 운영상 아직 분리가 필요한 후보

최신 상태 snapshot은 `Fixture`, `Gateway`에 저장하고, command fan-out·outbox·중복 이벤트 원장은 별도 테이블로 분리했다. 다음 시계열/정책 테이블은 후속 범위다.

- `FixtureMetric`: RSSI, hop count, latency, command success rate의 시계열 이력
- `GatewayMetric`: heartbeat, CPU/memory/disk, MQTT 연결 상태 이력
- `CommandLog`: 명령 전송, ACK, retry, failure reason 상세 로그
- `OtaPackage`, `OtaDeployment`: 게이트웨이/노드 OTA 패키지와 배포 이력
- `Tariff`: 현장별 전기요금제와 계약전력 설정
- `GatewayCoverage`: 게이트웨이가 담당하는 층/구역 커버리지
- `Floor.description`, `Floor.parkingCapacity`: 층 설명과 주차면 수

## 7. 문서 갱신 규칙

DB 구조가 변경될 때는 다음 순서로 함께 갱신한다.

1. `apps/api/prisma/schema.prisma`
2. `apps/api/prisma/migrations/*/migration.sql`
3. 이 문서 `docs/database-schema.md`
4. 필요한 경우 API 테스트, 웹 테스트, `docs/lesson_leared.md`
