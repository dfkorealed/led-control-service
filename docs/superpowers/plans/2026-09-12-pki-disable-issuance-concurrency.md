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

- [x] **Step 1: 원장·worker 실패 테스트 작성**

  issuer+serial/fingerprint idempotency, PEM/CSR 미저장, `FOR UPDATE SKIP LOCKED` claim, lease owner fencing, revoke 성공+CRL 실패의 CRL-only 재시도, 최대 1시간 backoff, 성공 저장 취소를 검증한다.

- [x] **Step 2: RED 확인**

  Run: `pnpm --filter @led-control/api exec jest src/pki/certificate-revocation-reconciliation.service.spec.ts --runInBand`

  Expected: 새 서비스·Prisma delegate가 없어 FAIL.

- [x] **Step 3: additive schema/migration과 최소 worker 구현**

  `revocation_pending` enum과 FK 없는 durable ledger를 추가하고, signed metadata만 저장하는 lease-fenced worker를 구현한다. 완료 row는 삭제하지 않는다.

- [x] **Step 4: GREEN 및 Prisma 검증**

  Run: `pnpm --filter @led-control/api exec jest src/pki/certificate-revocation-reconciliation.service.spec.ts src/pki/pki.module.spec.ts --runInBand`

  Run: `pnpm --filter @led-control/api exec prisma validate --schema prisma/schema.prisma`

  증거: 최초 worker/helper·module import 부재 RED를 확인했다. Focused worker/module 33개, PKI 전체 107개(환경 의존 1개 제외), API 전체 1,078개(환경 의존 272개 제외), Prisma generate/validate와 API typecheck/build를 통과했다. 스키마 검증은 연결되지 않는 임시 `DATABASE_URL`로 실행했으며 사용자 DB migration은 실행하지 않았다. Task 2는 export된 `CERTIFICATE_TRANSACTION_TIMEOUT_MS = 140000`을 사용해야 180초 arm 유예를 보장한다. 설정 token/type은 순환 의존 방지를 위해 별도 파일로 분리하고 기존 lifecycle import를 re-export로 유지했다.

  Fix round 1: 서로 다른 원장 행의 동시 CRL read/publish가 v1을 마지막에 덮어쓰는 RED와, 300초 transaction 종료 뒤 같은 row 재임대가 먼저 배포하는 RED를 확인했다. 목적별 two-int advisory namespace `PKIC`를 예약하고 read → publish → fenced finalize를 직렬화했다. 매 배포 직전 transaction/lease를 조회하고 배포 뒤 CA를 재조회하며 최대 3회 배포·검증 후에도 달라지면 backoff한다. CA read 총 4회×120초 상한에 로컬 I/O 여유를 둔 15분 transaction으로 5분 row lease 이후에도 기존 callback이 끝날 때까지 잠금을 유지한다. Focused 43개, PKI 전체 117개(환경 의존 1개 제외), API typecheck/build와 diff 검증을 통과했다. 단위 테스트의 DB 경계 모형이며 실제 PostgreSQL 경쟁은 Task 2에서 검증한다.

- [x] **Step 5: 중간 커밋**

  `git add apps/api/prisma apps/api/src/pki && git commit -m "feat(api): add durable certificate revocation reconciliation"`

### Task 2: 전체 발급·활성화·disable·revoke 경쟁 방어

**Files:**
- Modify: `apps/api/src/pki/manufacturing-enrollment.service.ts`
- Modify: `apps/api/src/pki/manufacturing-enrollment.service.spec.ts`
- Modify: `apps/api/src/pki/gateway-certificate.service.ts`
- Modify: `apps/api/src/pki/gateway-certificate.service.spec.ts`
- Modify: `apps/api/src/pki/certificate-lifecycle.service.ts`
- Modify: `apps/api/src/pki/certificate-lifecycle.service.spec.ts`
- Modify: `apps/api/src/gateway-onboarding/gateway-onboarding.service.ts`
- Modify: `apps/api/src/gateway-onboarding/gateway-onboarding.service.spec.ts`
- Modify: `apps/api/src/operator-site-admins/operator-site-admins.service.ts`
- Modify: `apps/api/src/operator-site-admins/operator-site-admins.service.spec.ts`
- Create: `apps/api/src/pki/certificate-concurrency.integration.spec.ts`

**Interfaces:**
- Consumes: Task 1의 잠금 helper와 reconciliation API.
- Produces: CA 서명 전·후 authoritative inventory/device certificate/pointer/gateway assignment 검증, 성공 원장 취소, disable commit의 logical revoke와 실제 PostgreSQL 경쟁 증거.

- [ ] **Step 1: 각 경로의 실패 단위·실제 PostgreSQL 테스트 작성**

  MQTT issue와 device renew가 서명 뒤 disabled/status/pointer/assignment 변경을 거부하고 원장을 남기는지, activation이 같은 잠금 뒤 revoked/pending drift를 거부하는지, 최초 issue가 공통 잠금을 쓰는지 검증한다. 두 Prisma connection과 deferred CA barrier로 disable-first issue/renew/activate 및 sign-first issue/renew/activate 뒤 disable을 재현하고 최종 active/pending과 pointer 부재를 literal assertion한다.

- [ ] **Step 2: RED 확인**

  Run: `pnpm --filter @led-control/api exec jest src/pki/manufacturing-enrollment.service.spec.ts src/pki/gateway-certificate.service.spec.ts src/pki/certificate-lifecycle.service.spec.ts src/gateway-onboarding/gateway-onboarding.service.spec.ts src/operator-site-admins/operator-site-admins.service.spec.ts --runInBand`

  Run: `PKI_CONCURRENCY_TEST_DATABASE_URL=<temporary-url> pnpm --filter @led-control/api exec jest src/pki/certificate-concurrency.integration.spec.ts --runInBand`

  Expected: CA 뒤 재검증·잠금·원장 assertion이 FAIL.

- [ ] **Step 3: 최소 production 변경**

  사전 조회는 유지하되 transaction에서 공통 lock 뒤 재조회하고, 서명 직후 원장을 독립 commit한 다음 저장 직전 다시 조회한다. 성공 commit은 certificate row와 원장 `cancelledAt`을 함께 반영한다. disable과 site deletion은 같은 잠금 transaction에서 `revocation_pending`, pointer clear, job upsert를 먼저 commit하고 worker `processNow`를 호출한다.

- [ ] **Step 4: GREEN 확인**

  Run: `pnpm --filter @led-control/api exec jest src/pki/manufacturing-enrollment.service.spec.ts src/pki/gateway-certificate.service.spec.ts src/pki/certificate-lifecycle.service.spec.ts src/gateway-onboarding/gateway-onboarding.service.spec.ts src/operator-site-admins/operator-site-admins.service.spec.ts src/operator-site-admins/site-deletion-cleanup.service.spec.ts --runInBand`

  Run: disposable PostgreSQL integration command from Step 2 and expect PASS.

- [ ] **Step 5: 중간 커밋**

  `git add apps/api/src/gateway-onboarding apps/api/src/operator-site-admins apps/api/src/pki && git commit -m "fix(api): serialize inventory disable and certificate issuance"`

### Task 3: 문서·최종 검증

**Files:**
- Modify: `apps/api/test/gateway-pki.e2e-spec.ts`
- Modify: `docs/database-schema.md`
- Modify: `docs/menus/settings.md`
- Modify: `docs/project-status.md`
- Modify: `docs/superpowers/plans/2026-09-12-pki-disable-issuance-concurrency.md`

**Interfaces:**
- Consumes: Task 1~2의 공통 lock·reconciliation 계약과 실제 PostgreSQL 경쟁 증거.
- Produces: 문서화된 운영 계약과 최종 검증 기록.

- [ ] **Step 1: 기존 정상 경로 회귀 보완**

  동시 MQTT issuance가 하나씩 직렬화되고 정상 device renewal/activation이 성공하는 assertion을 같은 disposable DB에서 유지한다.

- [ ] **Step 2: 문서 동기화**

  schema, 설정 메뉴, 상태판에 구현 범위·실제 DB 증거·Vault/CRL과 crash window의 남은 위험을 기록하고 모든 체크박스를 실제 증거와 일치시킨다.

- [ ] **Step 3: 최종 검증**

  Run: `pnpm --filter @led-control/api exec prisma validate --schema prisma/schema.prisma`

  Run: `pnpm --filter @led-control/api typecheck`

  Run: `pnpm --filter @led-control/api exec jest src/pki src/gateway-onboarding/gateway-onboarding.service.spec.ts src/operator-site-admins/operator-site-admins.service.spec.ts --runInBand`

  Run: disposable PostgreSQL integration command from Step 2.

  Run: `git diff --check`

- [ ] **Step 4: 최종 커밋**

  `git add apps/api docs && git commit -m "test(api): prove PKI disable issuance race safety"`
