# 구역 생성 500 오류 수정 설계

## 목표

구역 관리에서 유효한 조명을 선택해 구역을 만들 때 발생하는 HTTP 500을 제거하고, 테스트 데이터로 만든 조명도 일반 조명과 동일한 에너지 차원 이력 계약을 만족하도록 한다.

## 확인된 원인

- `EnergyDimensionHistoryService`가 PostgreSQL `pg_advisory_xact_lock()`의 `void` 반환값을 Prisma `$queryRaw`로 역직렬화해 실패한다.
- 현재 DB의 테스트 조명은 migration backfill을 받아 에너지 identity가 있으므로 현재 오류의 직접 원인은 테스트 데이터가 아니다.
- migration 적용 뒤 새로 생성하는 테스트 조명은 `EnergyFixtureIdentity`와 최초 `EnergyFixtureDimensionVersion`을 만들지 않아 이후 구역 생성과 에너지 수집이 실패할 수 있다.
- 실행 중인 `pnpm dev`에 migration 포함 변경을 병합하면 Nest watch만 재시작하므로, migration이 반영되기 전 새 코드가 실행될 수 있다.

## 설계

1. advisory lock은 결과 행을 읽지 않는 `$executeRaw`로 실행한다.
2. `FixtureGroupsService`의 `EnergyDimensionHistoryService` 의존성을 필수화해 production side effect가 테스트에서 조용히 생략되지 않게 한다.
3. 테스트 데이터 생성은 fixture bulk 생성·재사용 후 marker fixture 전체를 조회하고, 기존 `EnergyDimensionHistoryService.recordFixtureDimensions()`를 같은 transaction에서 호출해 누락 identity와 최초 dimension을 보충한다. 기존 identity의 동일 dimension은 새 version을 만들지 않는다.
4. 테스트 데이터 삭제는 분석 identity를 명시적으로 다루되, 실제 집계·상태·구역 membership 이력이 있으면 기존 fail-closed 정책에 따라 삭제를 거부한다. 안전한 marker identity와 dimension만 fixture 삭제 전에 제거한다.
5. 스키마와 API payload는 변경하지 않는다.

## 검증 경계

- 단위 테스트에서 advisory lock이 `$executeRaw`를 사용하고 `$queryRaw`를 사용하지 않는지 검증한다.
- 구역 서비스 테스트는 에너지 이력 의존성을 항상 주입하고 create/update/remove의 이력 호출을 검증한다.
- 테스트 데이터 테스트는 생성, 반복 생성, 누락 identity 보충, 안전한 삭제, 분석 이력 존재 시 삭제 거부를 검증한다.
- 환경변수로 격리 PostgreSQL이 제공되면 실제 advisory lock과 구역 생성 transaction을 실행한다.
- API 단위 테스트, 타입 검사, 빌드와 문서 diff 검사를 완료한다.

## 운영 주의

migration을 포함한 변경을 실행 중 개발 환경에 병합한 경우 `pnpm dev`를 재시작해 migration 적용 후 API가 시작되도록 한다. watcher 안에서 migration을 자동 실행하지 않는다.
