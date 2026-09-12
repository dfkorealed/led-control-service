# P0/P1 Branch Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge every completed P0/P1 feature branch into `codex/mvp1-cloud-web` while preserving the already-landed monitoring and BIO adapter planning work, resolving schema and ingestion conflicts by retaining the union of supported behavior, and proving the combined tree with the repository gates.

**Architecture:** Integrate the branches in dependency order: monitoring ancestry, control, statistics, settings, account security, deployment/observability, then Gateway release/recovery. Resolve shared Prisma, ingestion, shell, and documentation files semantically rather than selecting one side wholesale; each merge remains a distinct merge commit so provenance and rollback boundaries stay visible.

**Tech Stack:** Git, pnpm workspace, NestJS, Prisma/PostgreSQL, React/Vite, Node.js Gateway tooling, Docker Compose.

**Spec:** `docs/project-status.md`, `docs/superpowers/plans/2026-09-12-platform-security-operations.md`, `docs/superpowers/plans/2026-09-12-platform-deploy-observability.md`, `docs/superpowers/plans/2026-09-12-gateway-release-backup-recovery.md`

## Global Constraints

- Integrate only into `codex/mvp1-cloud-web` in `/Users/kim-jh/Documents/led-control-service`; do not merge or push `main`.
- Preserve commits `099ad04`, `37c1254`, and `b3ebd92` that were added after monitoring landed.
- Do not apply migrations to a user or production database and do not deploy infrastructure.
- Preserve all completed behavior from both sides of schema, ingestion, shell, and menu-document conflicts.
- Keep every feature branch and linked worktree until the merged result passes the complete verification gate.
- Update `docs/database-schema.md` for the combined Prisma schema and every affected `docs/menus/*.md` document for combined menu behavior.

---

### Task 1: Establish the integration baseline

**Files:**
- Modify: `docs/superpowers/plans/2026-09-13-p0-p1-branch-integration.md`

**Interfaces:**
- Consumes: the seven completed feature branch heads.
- Produces: a clean `codex/mvp1-cloud-web` baseline and recorded branch identities.

- [x] Confirm `git status --short --branch` is clean on `codex/mvp1-cloud-web`.
- [x] Confirm monitoring commit `ba43f42` is an ancestor of the target and the target still contains BIO planning commit `b3ebd92`.
- [x] Record the exact head of each remaining feature branch before integration.
- [x] Ask independent reviewers to inspect control/statistics, settings/security, and deployment/Gateway conflict risks without editing the integration checkout.

Baseline evidence recorded 2026-09-13:

- Target before this plan: `b3ebd92bc5db1715133663a4a402ac81a2019d09`; working tree clean.
- Monitoring: `ba43f42ca7a0a74f61b2a9438f95ce3a9fecd17c` (already an ancestor of target).
- Control: `6bc82042d725bc5b6ee4eff36e6c90f81f043df3`.
- Statistics: `4dcf3263eb1d81531b2f96e2172c96a3e5bad0dd`.
- Settings: `cd12ef619212fd3b3c3e70d2a816724af13ca298`.
- Account security: `e6cfe40f59c0af58bb83acff87e854ed4ef21e68`.
- Deployment/observability: `c576f5c0b6c5f968171afe946587c470a736ecd0`.
- Gateway release/recovery: `21e9da6292b42af55a78390e2a6c58438a709880`.
- Read-only conflict analysis dispatched to three independent reviewers; all integration edits remain owned by the orchestrator.

### Task 2: Merge control reliability

**Files:**
- Merge: `codex/p0p1-control-reliability`
- Resolve if required: `docs/lesson_leared.md`
- Resolve if required: `docs/project-status.md`

**Interfaces:**
- Consumes: monitoring state freshness and incident behavior already in the target.
- Produces: reliable command timeout, delivery reconciliation, and recovery behavior.

- [x] Run `git merge --no-ff codex/p0p1-control-reliability`.
- [x] Resolve documentation conflicts by retaining entries from both branches.
- [x] Run `git diff --check` and the control-focused test commands named in the branch plan.
- [x] Complete the merge commit.

Verification before completing the merge: Shared build and 200/200 tests passed; API command/MQTT focused suites passed 209/209; Gateway journal/status-check/BlueZ focused suites passed 59/59; `git diff --check` passed. The first API invocation exposed a stale generated Prisma Client; schema/client comparison confirmed the merged schema had the fields while the generated client did not, and `pnpm --filter @led-control/api prisma:generate` restored the expected generated types before the same suites passed.

### Task 3: Merge statistics data operations

**Files:**
- Merge: `codex/p0p1-statistics-data`
- Resolve: `apps/api/prisma/schema.prisma`
- Resolve: `apps/api/src/energy/fixture-state-ingestion.service.ts`
- Resolve: `apps/api/src/mqtt/mqtt.service.ts`
- Resolve: `docs/database-schema.md`
- Resolve: `docs/menus/monitoring.md`
- Resolve: `docs/project-status.md`

**Interfaces:**
- Consumes: event receipt and freshness semantics from monitoring.
- Produces: high-watermark ingestion, bounded retention, report job metadata, and statistics UI state.

- [ ] Run `git merge --no-ff codex/p0p1-statistics-data`.
- [ ] Union the Prisma models, relations, indexes, and enums from monitoring and statistics.
- [ ] Preserve monitoring quarantine/receipt logic while adding statistics high-watermarks and retention behavior.
- [ ] Reconcile MQTT routing and all affected documentation.
- [ ] Run Prisma validation/generation, `git diff --check`, and statistics-focused tests.
- [ ] Complete the merge commit.

### Task 4: Merge settings and asset operations

**Files:**
- Merge: `codex/p0p1-settings-assets`
- Resolve: `apps/api/prisma/schema.prisma`
- Resolve: `apps/api/src/app.module.ts`
- Resolve: `apps/api/src/energy/fixture-state-ingestion.service.ts`
- Resolve: ingestion integration and unit tests
- Resolve: `docs/database-schema.md`
- Resolve: `docs/lesson_leared.md`
- Resolve: `docs/project-status.md`

**Interfaces:**
- Consumes: the merged monitoring/statistics data model.
- Produces: durable asset upload lifecycle and safe site/floor/fixture settings operations.

- [ ] Run `git merge --no-ff codex/p0p1-settings-assets`.
- [ ] Union schema and module registration without removing monitoring/statistics providers.
- [ ] Preserve all ingestion tests and combine assertions where fixtures overlap.
- [ ] Reconcile database, lesson, project, settings, and monitoring documentation.
- [ ] Run Prisma validation/generation, `git diff --check`, and settings-focused tests.
- [ ] Complete the merge commit.

### Task 5: Merge account security

**Files:**
- Merge: `codex/p0p1-platform-security-ops`
- Resolve: `apps/web/src/features/shells/CustomerShell.tsx`
- Resolve: `docs/database-schema.md`
- Resolve: `docs/lesson_leared.md`
- Resolve: `docs/menus/monitoring.md`
- Resolve: `docs/project-status.md`

**Interfaces:**
- Consumes: the combined API and Web application surface.
- Produces: audited Redis rate limiting, TOTP MFA, rotating sessions, and security settings UI.

- [ ] Run `git merge --no-ff codex/p0p1-platform-security-ops`.
- [ ] Preserve monitoring navigation and recovery UI while adding account-security navigation and state.
- [ ] Union all schema migrations and documentation chronologically.
- [ ] Run Prisma validation/generation, `git diff --check`, and security-focused API/Web tests.
- [ ] Complete the merge commit.

### Task 6: Merge deployment and observability

**Files:**
- Merge: `codex/p0p1-platform-deploy-observability`
- Resolve shared shell and documentation files against the result of Task 5.

**Interfaces:**
- Consumes: account security and the combined application shell.
- Produces: health/metrics/logging, immutable production images, production Compose, and app-shell recovery.

- [ ] Run `git merge --no-ff codex/p0p1-platform-deploy-observability`.
- [ ] Combine account-security shell behavior with offline, authorization, and lazy-load recovery behavior.
- [ ] Preserve all security and deployment documentation entries.
- [ ] Run `git diff --check` and deployment/observability contract tests.
- [ ] Complete the merge commit.

### Task 7: Merge Gateway release and recovery

**Files:**
- Merge: `codex/p0p1-platform-gateway-release`
- Resolve shared project and operations documentation against the result of Task 6.

**Interfaces:**
- Consumes: the common platform hardening base.
- Produces: signed release bundles, atomic activation/rollback, encrypted backup/restore, and protected release gates.

- [ ] Run `git merge --no-ff codex/p0p1-platform-gateway-release`.
- [ ] Preserve the already-merged security, deployment, and Gateway release documentation.
- [ ] Run `git diff --check`, Gateway release contract tests, and Gateway unit tests.
- [ ] Complete the merge commit.

### Task 8: Reconcile combined documentation and verify the integrated tree

**Files:**
- Modify: `docs/database-schema.md`
- Modify: `docs/menus/monitoring.md`
- Modify: `docs/menus/control.md`
- Modify: `docs/menus/statistics.md`
- Modify: `docs/menus/settings.md`
- Modify: `docs/project-status.md`
- Modify: `docs/superpowers/plans/2026-09-13-p0-p1-branch-integration.md`

**Interfaces:**
- Consumes: the complete merged application.
- Produces: synchronized documentation and final verification evidence.

- [ ] Verify every menu document retains `구현 완료`, `미구현`, `부족하거나 개선이 필요한 기능`, `관련 파일`, and `갱신 규칙`.
- [ ] Compare `docs/database-schema.md` with the final Prisma schema and migration directory.
- [ ] Run `pnpm --filter @led-control/api exec prisma validate --schema prisma/schema.prisma` and Prisma generation.
- [ ] Run `pnpm test`, `pnpm lint`, `pnpm typecheck`, and the workspace production audit command present after integration.
- [ ] Run `git diff --check` and inspect the complete integration diff and merge graph.
- [ ] Dispatch an independent whole-branch code review and address any load-bearing findings.
- [ ] Record exact commands and results in this plan, commit the integration documentation, and leave feature branches/worktrees intact unless cleanup is separately requested.
