# 설정 자산·운영 데이터 안전성 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 비공개 도면 저장·회수와 설치 후 운영 설정 CRUD를 권한·tenant·삭제 경합까지 포함해 구현한다.

**Architecture:** FloorAsset pending row를 signed PUT보다 먼저 commit하고 background sweeper가 미완료 object를 회수한다. 도면 조회는 인증된 API가 300초 signed GET으로 redirect하며, 설정 운영 화면은 Site/Floor/Fixture/기존 FixtureGroup API를 사용한다.

**Tech Stack:** NestJS, Prisma/PostgreSQL, AWS SDK S3/MinIO, React, React Query, TypeScript, Vitest/Jest, Playwright

**Spec:** `docs/superpowers/specs/2026-09-12-settings-assets-operations-design.md`

## Global Constraints

- 사용자 로컬 DB에 migration을 적용하지 않는다.
- S3 network call을 PostgreSQL transaction 안에서 실행하지 않는다.
- API write는 transaction 내부 Site 재인가를 유지한다.
- mock/자동 검증을 실장비 또는 운영 object storage 검증으로 기록하지 않는다.

---

### Task 1: 비공개 FloorAsset 접근 계약

**Files:**
- Modify: `apps/api/src/storage/object-storage.service.ts`
- Modify: `apps/api/src/floor-editor/floor-assets.controller.ts`
- Modify: `apps/api/src/floor-editor/floor-assets.service.ts`
- Modify: `docker-compose.yml`
- Test: `apps/api/src/storage/object-storage.service.spec.ts`
- Test: `apps/api/src/floor-editor/floor-assets.service.spec.ts`

**Interfaces:**
- Produces: `createFloorAssetDownloadUrl(objectKey): Promise<string>`, `getContentRedirect(user, floorId, assetId)`

- [x] 공개 URL 반환을 거부하는 failing unit test를 작성한다.
- [x] 테스트를 실행해 현재 공개 URL 반환 때문에 실패하는지 확인한다.
- [x] 300초 signed GET과 tenant-safe content endpoint를 구현한다.
- [x] Compose의 `floor-assets` anonymous policy를 `none`으로 바꾼다.
- [x] 관련 unit test와 Compose contract를 통과시킨다.
- [x] `feat(api): protect floor asset downloads`로 커밋한다.

### Task 2: DB-first 업로드 원장과 pending sweeper

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260912090000_floor_asset_private_ledger/migration.sql`
- Create: `apps/api/src/floor-editor/floor-asset-cleanup.service.ts`
- Modify: `apps/api/src/floor-editor/floor-editor.module.ts`
- Modify: `apps/api/src/floor-editor/floor-assets.service.ts`
- Modify: `apps/api/src/operator-site-admins/operator-site-admins.service.ts`
- Test: `apps/api/src/floor-editor/floor-assets.service.spec.ts`
- Test: `apps/api/src/floor-editor/floor-asset-cleanup.service.spec.ts`
- Test: `apps/api/src/operator-site-admins/operator-site-admins.integration.spec.ts`

**Interfaces:**
- Produces: `FloorAsset.uploadExpiresAt`, DB-first `createUploadIntent`, `FloorAssetCleanupService.processPending()`

- [x] presign 실패 뒤 pending row가 남는 failing test를 작성한다.
- [x] pending expiry와 Site deletion 경합 failing test를 작성한다.
- [x] schema/migration을 추가하고 Prisma Client를 생성한다.
- [x] object key 생성, row commit, presign 순서로 service를 분리한다.
- [x] 만료 점유를 회수하는 bounded sweeper를 구현하고 module lifecycle에 연결한다.
- [x] Site 삭제가 같은 Site lock 뒤 모든 asset key를 cleanup 원장에 복사하게 한다.
- [x] disposable DB migration과 focused tests를 통과시킨다.
- [x] `feat(api): make floor uploads recoverable`로 커밋한다.

### Task 3: 맵 편집 실도면 업로드 UI

**Files:**
- Modify: `apps/web/src/api/floor-editor.ts`
- Create: `apps/web/src/features/floor-editor/FloorAssetUploadPanel.tsx`
- Modify: `apps/web/src/features/floor-editor/FloorEditorView.tsx`
- Modify: `apps/web/src/features/floor-editor/editor-types.ts`
- Test: `apps/web/src/features/floor-editor/FloorAssetUploadPanel.test.tsx`
- Test: `apps/web/src/features/floor-editor/FloorEditorView.test.tsx`

**Interfaces:**
- Consumes: upload intent `{ assetId, uploadUrl, accessPath, expiresInSeconds }`
- Produces: upload callback returning ready asset and floor plan draft update

- [ ] PNG/JPG/PDF 검증, upload lock, 실패 보존 failing tests를 작성한다.
- [ ] Web Crypto SHA-256과 intent/PUT/complete API client를 구현한다.
- [ ] 공통 Button/FeedbackState를 사용하는 upload panel을 구현한다.
- [ ] 성공한 이미지 ready asset만 draft 배경으로 적용하고 PDF는 원본으로만 연결한다.
- [ ] editor save/restore/floor switch가 업로드 중 잠기도록 연결한다.
- [ ] Web unit과 Chromium asset workflow를 통과시킨다.
- [ ] `feat(web): add recoverable floor plan uploads`로 커밋한다.

### Task 4: Site/Floor/Fixture 운영 설정 API

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260912100000_site_floor_operations/migration.sql`
- Create: `apps/api/src/site-settings/site-settings.module.ts`
- Create: `apps/api/src/site-settings/site-settings.controller.ts`
- Create: `apps/api/src/site-settings/site-settings.service.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/fixtures/fixtures.controller.ts`
- Modify: `apps/api/src/fixtures/fixtures.service.ts`
- Test: `apps/api/src/site-settings/site-settings.service.spec.ts`
- Test: `apps/api/src/fixtures/fixtures.service.spec.ts`

**Interfaces:**
- Produces: `PATCH /sites/:siteId/settings`, floor create/update/archive endpoints, `PATCH /sites/:siteId/floors/:floorId/fixtures/:fixtureId`

- [ ] strict DTO, tenant, role, row-lock failing tests를 작성한다.
- [ ] `Site.currency`, `Floor.status`, `Floor.displayOrder` schema/migration을 추가한다.
- [ ] Site와 Floor CRUD/archive service/controller를 구현한다.
- [ ] fixture name/ratedWatt metadata update를 transaction 내부 재인가로 구현한다.
- [ ] 층 archive가 fixture/active group 존재 시 `409`인지 검증한다.
- [ ] focused API tests와 disposable migration을 통과시킨다.
- [ ] `feat(api): add post-installation site settings`로 커밋한다.

### Task 5: 운영 설정 Web UI

**Files:**
- Create: `apps/web/src/api/site-settings.ts`
- Create: `apps/web/src/features/settings/site/SiteOperationsView.tsx`
- Create: `apps/web/src/features/settings/site/SiteOperationsView.test.tsx`
- Modify: `apps/web/src/features/settings/settings-sections.ts`
- Modify: `apps/web/src/features/shells/CustomerShell.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/e2e/settings-operations.spec.ts`

**Interfaces:**
- Consumes: Task 4 settings APIs and existing fixture-group API
- Produces: admin-only `/settings/site` tab

- [ ] 관리자/Viewer route와 현장 form failing tests를 작성한다.
- [ ] 현장·층·조명·구역 section을 상단부터 스캔 가능한 형태로 구현한다.
- [ ] archive 확인 dialog와 mutation error/retry를 구현한다.
- [ ] query invalidation을 site-scoped dashboard/floor fixtures/groups에 연결한다.
- [ ] 1440/390/320px Chromium 정상 흐름을 통과시킨다.
- [ ] `feat(web): add operational site settings`로 커밋한다.

### Task 6: 삭제 의미와 단일 SiteMembership 불변식

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260912110000_single_site_membership/migration.sql`
- Modify: `apps/web/src/features/operator/site-admins/SiteAdminManagementView.tsx`
- Modify: `apps/web/src/features/operator/site-admins/DeleteSiteDialog.tsx`
- Test: `apps/api/src/prisma/site-user-access-migration.integration.spec.ts`
- Test: `apps/web/src/features/operator/site-admins/SiteAdminManagementView.test.tsx`

**Interfaces:**
- Produces: unique `SiteMembership.userId`, `현장 전체 삭제` command copy

- [x] 다중 membership seed가 migration을 중단하는 failing test를 작성한다.
- [x] unique index와 명시적 preflight error migration을 구현한다.
- [x] 운영자 삭제 trigger/dialog 문구를 실제 전체 현장 삭제로 변경한다.
- [x] migration rehearsal과 Web unit을 통과시킨다.
- [x] `fix(settings): align deletion and membership semantics`로 커밋한다.

### Task 7: 문서와 최종 검증

**Files:**
- Modify: `docs/menus/settings.md`
- Modify: `docs/menus/monitoring.md`
- Modify: `docs/database-schema.md`
- Modify: `docs/project-status.md`
- Modify: `docs/lesson_leared.md`

- [ ] 구현 상태와 미구현 PDF render worker/실 object storage 한계를 문서화한다.
- [ ] Prisma validate/generate와 clean/upgrade migration rehearsal을 실행한다.
- [ ] API/Web 전체 typecheck, test, build를 실행한다.
- [ ] 관련 Playwright를 직렬 실행한다.
- [ ] `git diff --check`와 공개 URL/anonymous policy 검색을 실행한다.
- [ ] `docs: record settings asset hardening`으로 커밋한다.
