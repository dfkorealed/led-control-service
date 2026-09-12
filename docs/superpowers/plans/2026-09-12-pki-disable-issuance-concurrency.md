# PKI Disable-Issuance Concurrency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 비활성 Gateway inventory에 device/MQTT 인증서가 경쟁 조건으로 발급·활성화되는 경로를 차단하고 서명 orphan을 영속적으로 폐기한다.

**Architecture:** 모든 inventory 변경은 공통 advisory lock과 inventory row lock 순서를 사용한다. CA 서명 직후 별도 commit 원장을 만들고 인증서 저장 성공 transaction만 원장을 취소하며, logical revoke와 lease-fenced worker가 외부 CA/CRL 장애를 재시도한다.

**Tech Stack:** NestJS 10, TypeScript, Prisma 6, PostgreSQL 16, Jest

**Spec:** `docs/superpowers/specs/2026-09-12-pki-disable-issuance-concurrency-design.md`

## Global Constraints

- 작업은 `/Users/kim-jh/Documents/led-control-service/.worktrees/p0p1-platform-security-ops`와 `codex/p0p1-platform-security-ops`에서만 수행한다.
- 기존 migration은 수정하지 않고 additive migration만 추가한다.
- 사용자 로컬 DB에는 migration을 적용하지 않는다.
- 인증서 PEM, CSR, private key, enrollment token과 claim code 원문을 DB·로그·테스트 출력에 저장하지 않는다.
- 모든 경로는 `inventory.id advisory lock → GatewayInventory FOR UPDATE → certificate rows → Gateway` 순서를 따른다.

---

### Task 1: 영속 폐기 원장과 worker

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260915090000_certificate_revocation_reconciliation/migration.sql`
- Create: `apps/api/src/pki/inventory-certificate-lock.ts`
- Create: `apps/api/src/pki/certificate-revocation-reconciliation.service.ts`
- Create: `apps/api/src/pki/certificate-revocation-reconciliation.service.spec.ts`
- Modify: `apps/api/src/pki/pki.module.ts`
- Modify: `apps/api/src/pki/pki.module.spec.ts`

**Interfaces:**
- Produces: `lockGatewayInventory(tx, inventoryId)`, `lockGatewayCertificates(tx, inventoryId)`, `armSignedCertificate(input)`, `cancelSignedCertificate(tx, reconciliationId)`, `stageInventoryRevocation(tx, inventoryId, now)`, `processNow(id?)`.
- Consumes: `CertificateAuthorityProvider`, `PrismaService`, `CertificatePurpose`.

- [ ] **Step 1: 원장·worker 실패 테스트 작성**

  issuer+serial/fingerprint idempotency, PEM/CSR 미저장, `FOR UPDATE SKIP LOCKED` claim, lease owner fencing, revoke 성공+CRL 실패의 CRL-only 재시도, 최대 1시간 backoff, 성공 저장 취소를 검증한다.

- [ ] **Step 2: RED 확인**

  Run: `pnpm --filter @led-control/api exec jest src/pki/certificate-revocation-reconciliation.service.spec.ts --runInBand`

  Expected: 새 서비스·Prisma delegate가 없어 FAIL.

- [ ] **Step 3: additive schema/migration과 최소 worker 구현**

  `revocation_pending` enum과 FK 없는 durable ledger를 추가하고, signed metadata만 저장하는 lease-fenced worker를 구현한다. 완료 row는 삭제하지 않는다.

- [ ] **Step 4: GREEN 및 Prisma 검증**

  Run: `pnpm --filter @led-control/api exec jest src/pki/certificate-revocation-reconciliation.service.spec.ts src/pki/pki.module.spec.ts --runInBand`

  Run: `pnpm --filter @led-control/api exec prisma validate --schema prisma/schema.prisma`

- [ ] **Step 5: 중간 커밋**

  `git add apps/api/prisma apps/api/src/pki && git commit -m "feat(api): add durable certificate revocation reconciliation"`

### Task 2: 발급·갱신·활성화 잠금과 CA 후 재검증

**Files:**
- Modify: `apps/api/src/pki/manufacturing-enrollment.service.ts`
- Modify: `apps/api/src/pki/manufacturing-enrollment.service.spec.ts`
- Modify: `apps/api/src/pki/gateway-certificate.service.ts`
- Modify: `apps/api/src/pki/gateway-certificate.service.spec.ts`
- Modify: `apps/api/src/pki/certificate-lifecycle.service.ts`
- Modify: `apps/api/src/pki/certificate-lifecycle.service.spec.ts`

**Interfaces:**
- Consumes: Task 1의 잠금 helper와 reconciliation API.
- Produces: CA 서명 전·후 authoritative inventory/device certificate/pointer/gateway assignment 검증과 성공 원장 취소.

- [ ] **Step 1: 각 경로의 실패 단위 테스트 작성**

  MQTT issue와 device renew가 서명 뒤 disabled/status/pointer/assignment 변경을 거부하고 원장을 남기는지, activation이 같은 잠금 뒤 revoked/pending drift를 거부하는지, 최초 issue가 공통 잠금을 쓰는지 검증한다.

- [ ] **Step 2: RED 확인**

  Run: `pnpm --filter @led-control/api exec jest src/pki/manufacturing-enrollment.service.spec.ts src/pki/gateway-certificate.service.spec.ts src/pki/certificate-lifecycle.service.spec.ts --runInBand`

  Expected: CA 뒤 재검증·잠금·원장 assertion이 FAIL.

- [ ] **Step 3: 최소 production 변경**

  사전 조회는 유지하되 transaction에서 공통 lock 뒤 재조회하고, 서명 직후 원장을 독립 commit한 다음 저장 직전 다시 조회한다. 성공 commit은 certificate row와 원장 `cancelledAt`을 함께 반영한다.

- [ ] **Step 4: GREEN 확인**

  Run: `pnpm --filter @led-control/api exec jest src/pki/manufacturing-enrollment.service.spec.ts src/pki/gateway-certificate.service.spec.ts src/pki/certificate-lifecycle.service.spec.ts --runInBand`

- [ ] **Step 5: 중간 커밋**

  `git add apps/api/src/pki && git commit -m "fix(api): serialize certificate issuance with inventory state"`

### Task 3: disable·revoke·site deletion logical revocation

**Files:**
- Modify: `apps/api/src/gateway-onboarding/gateway-onboarding.service.ts`
- Modify: `apps/api/src/gateway-onboarding/gateway-onboarding.service.spec.ts`
- Modify: `apps/api/src/operator-site-admins/operator-site-admins.service.ts`
- Modify: `apps/api/src/operator-site-admins/operator-site-admins.service.spec.ts`
- Modify: `apps/api/src/pki/certificate-lifecycle.service.ts`
- Modify: `apps/api/src/pki/certificate-lifecycle.service.spec.ts`

**Interfaces:**
- Consumes: `stageInventoryRevocation`과 공통 inventory lock.
- Produces: disable commit과 동시에 `revocation_pending`, cleared device pointers, durable revocation jobs.

- [ ] **Step 1: disable/revoke 실패 테스트 작성**

  단일 inventory disable과 site deletion 다건 disable이 ID 정렬 잠금, row lock, logical revoke, pointer clear, job upsert를 같은 transaction에서 수행하고 반복 호출이 idempotent인지 검증한다.

- [ ] **Step 2: RED 확인**

  Run: `pnpm --filter @led-control/api exec jest src/gateway-onboarding/gateway-onboarding.service.spec.ts src/operator-site-admins/operator-site-admins.service.spec.ts src/pki/certificate-lifecycle.service.spec.ts --runInBand`

- [ ] **Step 3: 최소 production 변경**

  disable transaction이 외부 CA 호출 전에 fail-closed state와 원장을 commit하게 하고, 기존 동기 응답은 worker `processNow` 결과를 사용하되 실패 원장은 보존한다.

- [ ] **Step 4: GREEN 확인**

  Run: `pnpm --filter @led-control/api exec jest src/gateway-onboarding/gateway-onboarding.service.spec.ts src/operator-site-admins/operator-site-admins.service.spec.ts src/operator-site-admins/site-deletion-cleanup.service.spec.ts src/pki/certificate-lifecycle.service.spec.ts --runInBand`

- [ ] **Step 5: 중간 커밋**

  `git add apps/api/src/gateway-onboarding apps/api/src/operator-site-admins apps/api/src/pki && git commit -m "fix(api): fail closed during inventory certificate revocation"`

### Task 4: 실제 PostgreSQL 경쟁 회귀와 문서·최종 검증

**Files:**
- Create: `apps/api/src/pki/certificate-concurrency.integration.spec.ts`
- Modify: `apps/api/test/gateway-pki.e2e-spec.ts`
- Modify: `docs/database-schema.md`
- Modify: `docs/menus/settings.md`
- Modify: `docs/project-status.md`
- Modify: `docs/superpowers/plans/2026-09-12-pki-disable-issuance-concurrency.md`

**Interfaces:**
- Consumes: Task 1~3의 공통 lock·reconciliation 계약.
- Produces: 두 Prisma connection과 deferred CA barrier를 쓰는 실제 PostgreSQL 경쟁 증거.

- [ ] **Step 1: 실제 DB 실패 회귀 작성**

  disable-first issue/renew/activate, sign-first issue/renew 뒤 disable, activate-first disable을 각각 barrier로 고정한다. 모든 종료 상태에서 disabled inventory의 active/pending 인증서와 device pointer가 없음을 literal assertion한다.

- [ ] **Step 2: 기존 구현에서 RED 확인**

  disposable PostgreSQL 16에 migration을 적용하고 `PKI_CONCURRENCY_TEST_DATABASE_URL=<temporary-url> pnpm --filter @led-control/api exec jest src/pki/certificate-concurrency.integration.spec.ts --runInBand`를 실행한다.

  Expected: 기존 경로에서 active/pending 인증서가 남거나 disable이 발급 잠금을 기다리지 않아 FAIL.

- [ ] **Step 3: 기존 정상 경로 회귀 보완**

  동시 MQTT issuance가 하나씩 직렬화되고 정상 device renewal/activation이 성공하는 assertion을 같은 disposable DB에서 유지한다.

- [ ] **Step 4: 문서 동기화**

  schema, 설정 메뉴, 상태판에 구현 범위·실제 DB 증거·Vault/CRL과 crash window의 남은 위험을 기록하고 모든 체크박스를 실제 증거와 일치시킨다.

- [ ] **Step 5: 최종 검증**

  Run: `pnpm --filter @led-control/api exec prisma validate --schema prisma/schema.prisma`

  Run: `pnpm --filter @led-control/api typecheck`

  Run: `pnpm --filter @led-control/api exec jest src/pki src/gateway-onboarding/gateway-onboarding.service.spec.ts src/operator-site-admins/operator-site-admins.service.spec.ts --runInBand`

  Run: disposable PostgreSQL integration command from Step 2.

  Run: `git diff --check`

- [ ] **Step 6: 최종 커밋**

  `git add apps/api docs && git commit -m "test(api): prove PKI disable issuance race safety"`

