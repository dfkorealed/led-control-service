# 구역 생성 500 오류 수정 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 유효한 일반·테스트 조명으로 구역을 만들 때 에너지 이력 기록 때문에 HTTP 500이 발생하지 않게 한다.

**Architecture:** 기존 `EnergyDimensionHistoryService`를 에너지 identity와 dimension 기록의 단일 진입점으로 유지한다. PostgreSQL advisory lock은 결과를 반환하지 않는 실행 API로 바꾸고, fixture-group과 test-data 서비스가 이 의존성을 필수로 사용하도록 한다. 테스트 데이터 삭제는 분석 이력이 없는 marker identity만 정리하며 나머지는 transaction 전체를 fail closed 한다.

**Tech Stack:** NestJS, TypeScript, Prisma 6.19, PostgreSQL, Jest

**Spec:** `docs/superpowers/specs/2026-09-11-fixture-group-500-design.md`

## Global Constraints

- 기존 API DTO, Prisma schema와 migration은 변경하지 않는다.
- production 코드를 수정하기 전에 해당 회귀 테스트를 작성하고 예상 원인으로 실패하는지 확인한다.
- 테스트 데이터 생성과 에너지 identity/dimension 기록은 같은 Prisma transaction에서 수행한다.
- 실제 분석 이력이 연결된 테스트 데이터 삭제는 부분 삭제 없이 `409 Conflict`로 거부한다.
- `docs/menus/control.md`, `docs/menus/settings.md`, `docs/project-status.md`, `docs/lesson_leared.md`를 실제 검증 결과와 함께 갱신한다.

---

### Task 1: Advisory lock과 구역 에너지 이력 회귀

**Files:**
- Modify: `apps/api/src/energy/energy-dimension-history.service.spec.ts`
- Modify: `apps/api/src/energy/energy-dimension-history.service.ts`
- Modify: `apps/api/src/fixture-groups/fixture-groups.service.spec.ts`
- Modify: `apps/api/src/fixture-groups/fixture-groups.service.ts`
- Test: `apps/api/src/energy/energy-dimension-history.integration.spec.ts`

**Interfaces:**
- Consumes: `EnergyDimensionHistoryService.recordGroupDimensions(tx, input)`
- Produces: 필수 `EnergyDimensionHistoryService` 의존성을 가진 `FixtureGroupsService`와 결과를 역직렬화하지 않는 advisory lock

- [x] **Step 1: `$executeRaw` advisory lock과 필수 이력 호출을 요구하는 실패 테스트 작성**
- [x] **Step 2: focused Jest를 실행해 `$executeRaw` 부재와 optional dependency 때문에 예상대로 실패하는지 확인**
- [x] **Step 3: advisory lock을 `$executeRaw`로 바꾸고 fixture-group 의존성의 `@Optional()`과 optional chaining 제거**
- [x] **Step 4: 실제 PostgreSQL 환경변수가 있을 때 rollback 가능한 구역 생성 통합 회귀 추가**
- [x] **Step 5: focused Jest를 다시 실행해 통과 확인**

### Task 2: 테스트 데이터 에너지 차원 정합성

**Files:**
- Modify: `apps/api/src/test-data/test-data.module.ts`
- Modify: `apps/api/src/test-data/test-data.service.ts`
- Modify: `apps/api/src/test-data/test-data.service.spec.ts`

**Interfaces:**
- Consumes: `EnergyDimensionHistoryService.ensureFixtureDimensions(tx, inputs, effectiveAt)`
- Produces: 생성·재실행 후 모든 marker fixture의 identity와 현재 dimension이 존재하는 `TestDataService.create()`

- [x] **Step 1: 신규 fixture와 기존 누락 fixture의 identity/dimension 보충, 반복 호출 비중복을 요구하는 실패 테스트 작성**
- [x] **Step 2: focused Jest를 실행해 이력 생성 호출 부재로 예상대로 실패하는지 확인**
- [x] **Step 3: marker fixture를 bounded query로 읽고 기존 energy 서비스로 같은 transaction에서 차원을 보장**
- [x] **Step 4: 안전한 marker identity 삭제와 분석 이력 존재 시 409를 요구하는 실패 테스트 작성**
- [x] **Step 5: deletion dependency 검사와 identity 정리를 최소 구현하고 focused Jest 통과 확인**

### Task 3: 문서 수렴과 전체 검증

**Files:**
- Modify: `docs/menus/control.md`
- Modify: `docs/menus/settings.md`
- Modify: `docs/project-status.md`
- Modify: `docs/lesson_leared.md`
- Modify: `docs/superpowers/plans/2026-09-11-fixture-group-500.md`

**Interfaces:**
- Consumes: Task 1~2의 fresh 검증 결과
- Produces: 실제 구현·한계·운영 재시작 규칙과 일치하는 정본 문서

- [x] **Step 1: 메뉴 문서에 구역 생성과 테스트 데이터 energy 정합성의 구현 상태·한계를 반영**
- [x] **Step 2: migration 포함 hot reload 재시작과 raw query 반환형 교훈을 `docs/lesson_leared.md`에 기록**
- [x] **Step 3: `pnpm --filter @led-control/api typecheck` 실행**
- [x] **Step 4: `pnpm --filter @led-control/api test -- --runInBand` 실행**
- [x] **Step 5: `pnpm --filter @led-control/api build`와 `git diff --check` 실행**
- [x] **Step 6: 상태판과 이 체크리스트에 최종 테스트 수·환경 의존 skip·남은 위험 기록**

**최종 검증 (2026-09-11)**

- API typecheck와 production build: exit 0.
- 전체 API Jest: 101 suites passed, 22 skipped; 956 tests passed, 196 environment-dependent skipped, 0 failed.
- `git diff --check`: exit 0.
- 실제 PostgreSQL rollback 구역 생성 통합 회귀 1건은 세 opt-in DB URL이 모두 없어 skip됐다. 사용자 DB에는 연결하거나 쓰지 않았으며 실DB 통과로 간주하지 않는다.
- 남은 위험: 실제 PostgreSQL 동시 실행 및 1,000개 transaction 소요시간은 격리 DB URL이 없어 미검증이다. TestDataService 테스트는 실제 energy service와 stateful DB boundary로 identity/version 개수·반복 비중복을 직접 검증한다.

### Task 4: 최종 리뷰 Important 2건 수정

- [x] cleanup 잠금 누락과 1,000개 비례 쿼리를 재현하는 회귀를 먼저 추가하고 RED 확인: focused 2 failed/28 passed, energy DB 호출 신규 5,000회·반복 3,000회, 잠금 요청 없이 analytics 조회.
- [x] Site 인가 잠금 뒤 검증된 fixture ID를 정렬한 PostgreSQL `FOR UPDATE`로 잠그고 모든 의존성 조회·삭제를 뒤에 유지. 새 Gateway 잠금 없음.
- [x] 공통 energy bulk 메서드 추가: 같은 advisory key 정렬 잠금, identity/current version 일괄 조회, 누락 identity/current 보충 및 변경 version bulk close/create.
- [x] 실제 energy service로 1,000개 신규·반복 query count와 identity/version 개수, 누락 current·필드별 변경·tracking start 보존·empty batch·잠금 대기 중 분석 생성 회귀 확인.
- [x] GREEN focused 55 passed/1 environment-dependent skipped; energy DB 호출 신규 5회·반복 3회(최초 marker 조회 포함 6회·4회).
- [x] API typecheck/build, 전체 Jest 956 passed/196 skipped(101 suites passed/22 skipped), `git diff --check` 통과. API DTO/Prisma schema/migration 변경 없음.
- [x] 설정·모니터링·제어 메뉴, 설계·상태판·교훈을 최종 구현과 검증 한계에 맞춰 최신화.
