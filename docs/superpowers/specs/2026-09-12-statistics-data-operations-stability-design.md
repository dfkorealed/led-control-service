# 통계 데이터·보고서 운영 안정성 설계

## 목적

통계 P0~P2가 만든 이벤트 원장, 통계 비용, 보고서 파일을 장기 운영할 수 있도록 마이그레이션 복구성, 중복 방지 상태, 보존 정책, 보고서 사용성, 객체 정리 관측성을 보강한다. 사용자 개발 DB와 운영 DB는 이번 작업에서 변경하지 않으며 모든 DB 검증은 일회성 PostgreSQL에서만 수행한다.

## 범위와 제외

- 포함: 20260912~14 보고서 마이그레이션의 실제 배포/실패/재시도 검증, 게이트웨이 이벤트 high-water와 유형별 보존, Session/FloorMapRevision bounded 정리, 보고서 목록 메타데이터와 오류 안내, 비용 단가 의미 표시, 보고서 객체 정리 지표.
- 제외: 통계 최적화 기능, P2-C, P3, AuditLog·GatewayClaimAudit·인증서 자동 삭제, 운영 배포, 사용자 DB migration, 도면 이력 외부 archive.
- 기존 migration SQL은 변경하지 않는다. 이미 적용된 migration의 checksum을 보존하고 순방향 migration과 운영 절차로만 보강한다.

## 1. 마이그레이션 안전성

### 사실과 정책

- `20260912_statistics_p2_reports`와 `20260913_report_object_cleanup_ledger`는 명시적 `BEGIN/COMMIT`이 없지만 PostgreSQL용 Prisma Migrate는 migration 파일을 하나의 DB transaction으로 감싸지 않는 경우가 있으므로, 파일 자체 원자성을 가정하지 않는다.
- `20260914_report_delete_tombstone_guard`는 table lock과 transaction을 사용하지만 lock timeout이 없다.
- 이미 배포 가능한 기존 migration은 수정하지 않는다. 대신 clean replay, 직전 버전 upgrade, statement 중간 실패, 재시도, `_prisma_migrations` 상태와 카탈로그 불변식을 실제 `prisma migrate deploy`로 검증한다.
- 20260912~14 적용 구간은 구 API/worker를 중지한 maintenance barrier에서 수행한다. 적용 전 preflight, 적용 후 trigger/check/backfill 검증을 통과한 뒤 새 API/worker를 시작한다.

### 실패 주입

테스트 전용 임시 migration 디렉터리에 원본을 복사하고 지정 statement 뒤 의도적 실패 migration을 추가한다. 원본 파일은 절대 수정하지 않는다. 다음을 확인한다.

1. 실패 상태가 `_prisma_migrations`에 기록되고 성공으로 오인되지 않는다.
2. transaction migration은 카탈로그와 데이터가 rollback된다.
3. 비원자 legacy migration의 부분 상태는 preflight가 탐지하고 자동 진행하지 않는다.
4. disposable DB를 재생성한 뒤 정상 deploy가 항상 성공한다.
5. 20260913의 legacy `objectKeys` 입력과 키 개수 제약은 사전 검사에서 명시적으로 거부된다.

## 2. 이벤트 중복 방지와 보존

### 영속 high-water

`GatewayEventWatermark`를 추가한다.

- 키: `(gatewayId, eventType, scopeKey)`
- `scopeKey`: gateway 단위는 빈 문자열, fixture 상태는 fixture ID, capability는 mesh node ID, scan은 provisioning session ID.
- 값: `lastSequence`, `lastEventId`, `lastPayloadHash`, `lastOccurredAt`, `updatedAt`.
- 수신 transaction에서 `ProcessedGatewayEvent` 기록과 함께 compare-and-advance한다.
- 같은 sequence에서 event ID/payload가 동일하면 duplicate로 처리하고 기존 ACK 계약을 유지한다.
- 낮은 sequence 또는 같은 sequence의 다른 identity/payload는 stale/conflict로 거부한다.
- 임의의 과거 event ID를 영구 기억하지 않으므로 exact event-ID 중복 보장은 raw 원장 보존 기간 안에서만 제공한다. 장비 sequence는 gateway identity 내에서 reset/reuse하지 않는 기존 계약을 유지한다.

### 유형별 원장 보존

`createdAt`을 기준으로 한 번에 최대 10,000건을 `FOR UPDATE SKIP LOCKED`로 삭제한다.

| 이벤트 유형 | 보존 | 추가 조건 |
| --- | ---: | --- |
| `gateway_heartbeat` | 7일 | Gateway와 watermark에 최신 sequence가 남아 있음 |
| `fixture_state` | 30일 | Fixture cursor/snapshot과 watermark가 해당 row 이상으로 전진함 |
| `provisioning_scan_found/completed/failed` | 90일 | session이 terminal이고 scan watermark/terminal ACK identity가 남아 있음 |
| `vehicle_sensor_capability` | 365일 | node 최신 revision/watermark보다 오래된 superseded row만 삭제 |
| 알 수 없는 eventType | 자동 삭제 안 함 | 새 유형은 명시적 정책 추가 전 fail-safe 보존 |

scan terminal 재전송은 session에 저장한 terminal event identity를 이용해 상태를 바꾸지 않고 동일 application ACK를 재발행한다.

## 3. Session과 도면 이력 보존

- `Session`: 활성 세션은 보존한다. `expiresAt`이 30일보다 오래됐거나 `revokedAt`이 30일보다 오래된 row만 10,000건씩 삭제한다. 토큰 hash·IP·user agent의 불필요한 장기 보유를 줄이는 보안 목적이다.
- `FloorMapRevision`: 각 floor의 최신 100개는 항상 보존하고, 365일 이내 revision도 보존한다. 나머지만 한 번에 1,000건 삭제한다. 따라서 UI restore 가능 범위는 “최근 365일 또는 최근 100개 중 넓은 범위”다.
- `AuditLog`: 3년 hot retention 제안만 문서화하고 이번 자동 삭제에서 제외한다. 법무/회사 승인이 필요하다.
- `GatewayClaimAudit` 및 폐기된 인증서 chain: 제조·보안 감사 목적으로 7년 또는 별도 승인 전까지 보존하며 이번 자동 삭제 대상이 아니다.
- cleanup timer는 중복 실행을 막고 `unref()`하며, 각 sweep 결과를 structured log로 남긴다.

## 4. 보고서 목록과 오류

### 불변 대상 snapshot

보고서 요청 시 `targetLabelSnapshot`을 저장한다. rename/delete 뒤에도 당시 대상명이 목록과 파일에서 바뀌지 않는다. legacy row는 nullable이며 scope와 identity ID로 안전한 대체 표시를 사용한다.

공개 계약은 다음을 제공한다.

- `target`: scope, identityId, label
- `requestedAt`: 기존 `createdAt`과 같은 시각
- `expiresAt`: 완료/만료 파일의 실제 만료 시각
- `failure`: 안정적인 공개 code와 사용자 행동 안내. raw DB/S3/render error는 노출하지 않는다.
- 호환을 위해 기존 `createdAt`, `failureCode`는 유지한다.

사용자 공개 failure code는 `generation_failed`, `storage_unavailable`, `rendering_failed`, `snapshot_invalid`, `attempts_exhausted`로 제한한다. 알 수 없는 내부 code는 `generation_failed`로 매핑한다.

### 요청 오류 표시

Web은 기존 `ApiError.status/body`를 사용해 다음을 구분한다.

- 400/422: 입력 검증 오류. 기간·대상·문자 등 수정 안내.
- 404: 대상 또는 파일이 없거나 만료됨.
- 409: 삭제 진행/동일 요청 처리 등 충돌. 잠시 후 재시도 안내.
- 5xx: 서버 처리 오류.
- `TypeError` 등 fetch 실패: 네트워크 연결 오류.

## 5. 비용 의미

- 일별·월별 series, 순위, 보고서의 저장 비용은 이벤트 적산 당시 적용 단가의 합계다.
- 월 forecast, 24시간 100% baseline, 예상 절감 비용은 조회 시점의 현재 현장 단가로 계산한다.
- 계산식은 변경하지 않고 화면의 제목·설명·접근성 문구에서 두 기준을 명시한다. 두 값을 동일 단가 기준의 실제 청구액처럼 표현하지 않는다.

## 6. 보고서 객체 정리 지표

`EnergyReportObjectCleanup`에 durable counter와 최근 관측값을 추가한다.

- `deleteAttemptCount`, `deleteFailureCount`, `lastAttemptAt`
- `lastObservedObjectCount`, `lastObservedBytes`
- `deletedObjectCount`, `deletedBytes`
- `latePutObjectCount`, `latePutBytes`

각 key를 HEAD하여 존재 여부와 크기를 확인한 후 DELETE한다. HEAD 404는 정상적인 미존재로 취급한다. 이전 successful pass(`lastCleanedAt`) 뒤 다시 발견한 객체만 late PUT로 누적한다. lease를 잃은 owner는 지표를 commit하지 않는다. 외부 metrics 제품을 추가하지 않고 sweep 요약, backlog 개수, oldest due age, retry/failure/late PUT 합계를 structured log로 제공한다.

## 7. 검증 기준

- shared strict contract unit tests.
- API unit/integration tests: watermark duplicate/stale/conflict, event별 cutoff, session/map revision 보존, report snapshot/error, cleanup byte/retry/late PUT.
- disposable PostgreSQL: fresh migrate deploy, staged upgrade, failure injection, rollback/retry, 두 worker의 `SKIP LOCKED` 경쟁.
- Web tests: 대상/요청/만료/실패 UI, validation/network 구분, 과거 단가/현재 단가 문구, 320px wrapping.
- Prisma validate/generate, app별 lint/typecheck/test/build, `git diff --check`.

## 8. 배포 순서

1. 구 API와 report worker를 정지한다.
2. preflight로 legacy JSON 형태, 키 개수, trigger/catalog 상태, 부분 migration 흔적을 검사한다.
3. backup/복구 지점을 확인한 후 `prisma migrate deploy`를 한 번만 실행한다.
4. 새 schema, constraint, trigger, backfill, watermark 초기값을 검증한다.
5. 새 API/worker를 시작하고 cleanup/retention 첫 sweep metrics를 확인한다.
6. 실패 시 부분 적용 DB를 임의 수정하지 않고 migration 상태와 preflight 결과를 보존해 복구 절차를 수행한다.
