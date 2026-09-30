# 제조 일련번호 기반 최초 설치 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 제조 일련번호와 장비 UUID를 하나의 제품 식별자로 사용하면서, 준비된 위치 CSV로 예정 맵 배치와 안전한 일괄 등록을 제공한다.

**Architecture:** 통신 가능한 제품은 정규화된 Device UUID 자체를 인쇄·저장 일련번호로 삼고, 위치는 별도의 `positionCode`로 식별한다. 중앙 DB의 제조 원장·층별 설치 계획을 정본으로 두고, 기존 등록 세션/MQTT outbox/terminal 처리 위에 재개 가능한 조정 계층을 얹는다. 예정 위치와 실제 Fixture, 실제 위치 확인은 분리한다.

**Tech Stack:** TypeScript, NestJS, Prisma/PostgreSQL, React/React Query, Vitest/Jest/Playwright, 기존 BLE Mesh/BIO Gateway 계약.

**Spec:** [제조 일련번호 기반 최초 설치 최종 설계](../specs/2026-09-30-serial-installation-plan-design.md)

## Global Constraints

- 사용자에게 보이는 제품 ID는 `serialNumber` 하나다. 통신 가능 제품에서는 정규화된 `deviceUuid`와 값이 같고, CSV에 두 번째 UUID 열을 만들지 않는다. `MeshNode.id`·`Fixture.id`·`meshAddress`·`positionCode`는 각각 DB 키·통신 주소·자리 번호라 합치지 않는다.
- DFK serial은 32자리 소문자 hex(라벨의 `8-8-8-8` 구분은 허용), BIO serial은 `bio:`+12자리 소문자 hex다. 대소문자는 정규화하되 정보가 빠진 짧은 별칭은 허용하지 않는다. 비통신 제품 serial은 대문자 `A-Z0-9-` 4~64자로 정규화하고 예정 표시만 가능하다.
- 입력은 UTF-8 CSV `floorCode,positionCode,x,y,serialNumber`이며 현장 선택 후 `floorCode→Floor.id` 매핑을 확정한다. 파일당 최대 2 MiB·총 20,000행·층당 2,000행; `x/y`는 현재 맵 논리 좌표다. 미리보기는 쓰기를 하지 않고 일부 행만 적용하지 않는다.
- 기존 수동 Gateway claim/조명 등록·맵 편집·제어·통계 동작을 유지한다. 기존 설정 등록 route는 manage 전용이며 viewer의 계획 조회는 모니터링에서 제공한다. 등록 terminal 성공 전에는 Fixture를 생성하지 않는다. 등록된 계획 좌표는 `placed`이되 `positionVerifiedAt=NULL`이다.
- 중앙 개발/운영 DB, Gateway, 펌웨어, 실제 라벨/장비를 계획 검증에 사용하지 않는다. migration과 HIL은 별도 승인된 격리 환경에서 먼저 검증한다. 기존 데이터 삭제·초기화는 계획에 없다.
- 같은 파일 재전송, 여러 현장 경쟁, 늦은 terminal, `reconcile_required`, 맵 좌표 프레임 변경은 실패 닫힘/멱등 복구 기준을 지킨다. 등록 실패를 전체 성공으로 표시하지 않는다.
- 설정 페이지 담당 세션이 제품 구현 조정의 주 담당이다. 공유 Prisma/API 계약은 backend 소유 역할과 순차 합의 후 변경하고, UI/UX 디자이너 세션은 화면 명세·4폭 검토를 맡는다. 현재 디자인 시스템과 공통 UI 컴포넌트를 재사용한다.

## Review Focus

1. 대문자/하이픈 DFK 라벨이나 BIO 대소문자 입력은 정보 손실 없이 같은 serial로 정규화되고, 잘린 값은 거부돼야 한다 → Task 1 테스트.
2. 같은 serial이 동시에 두 현장 계획에 들어오거나 동일 commit 요청이 두 번 오면 한 예약/한 결과만 남아야 한다 → Task 3 PostgreSQL 동시성 테스트.
3. 미리보기 뒤 층 선택·맵 프레임·CSV 내용이 바뀌면 확정은 409로 멈추고 새 미리보기를 요구해야 한다 → Task 3 테스트.
4. 한 Gateway가 두 층 제품을 함께 발견해도 UUID와 계획 층으로 분류하고, 알 수 없는 장비는 자동 등록하지 않아야 한다 → Task 4 테스트.
5. 등록 terminal 중복·지연·재시작과 CAD 재적용은 Fixture/slot/계획 링크를 중복·오배치하지 않아야 한다 → Task 5 통합 테스트.

## File Structure and Ownership

- `packages/shared/src/product-identity.ts`: 라벨 serial/Device UUID의 단일 정규화 함수. 기존 parser를 재사용한다.
- `apps/api/prisma/schema.prisma`, 새 migration, `docs/database-schema.md`: 제조 원장, 계획/항목, 진행 run, `Floor.coordinateFrameVersion` 및 유일성·FK.
- `apps/api/src/pki/manufacturing-luminaire.*`: 기존 제조 스테이션 mTLS guard 안의 원장 일괄 등록.
- `apps/api/src/installation-plans/*`: CSV 검증·미리보기, 확정/조회, 진행 run/worker를 파일 책임별로 분리.
- `apps/api/src/mqtt/provisioning-device-terminal.service.ts`: 기존 terminal 거래의 계획 링크·좌표 적용만 추가.
- `apps/api/src/floor-import/floor-import.service.ts`, `apps/api/src/floor-editor/map-document-reset.service.ts`, `apps/api/src/floor-editor/map-document-staging.service.ts`, `apps/api/src/floor-editor/map-document-mutation.service.ts`, `apps/api/src/floor-map/floor-map.service.ts`: 좌표 프레임 버전 증가와 계획 stale 전환.
- `apps/web/src/features/settings/registration/*`: 기존 `RegistrationPanel`을 보존하며 계획 업로드·미리보기·진행·예외를 추가.
- `apps/web/src/features/monitoring/*`: 예정 마커를 실제 Fixture와 분리해 읽기 전용 표시. 공통 지도 좌표 변환을 사용한다.

---

### Task 1: 단일 제품 식별자와 제조 원장

**Files:** Modify `packages/shared/src/product-identity.ts`, `packages/shared/src/product-identity.test.ts`, `apps/api/prisma/schema.prisma`, `apps/api/src/pki/pki.module.ts`, `docs/database-schema.md`; create `apps/api/src/pki/manufacturing-luminaire.controller.ts`, `apps/api/src/pki/manufacturing-luminaire.service.ts`, `apps/api/src/pki/manufacturing-luminaire.controller.spec.ts`, `apps/api/src/pki/manufacturing-luminaire.service.spec.ts`, `apps/api/src/pki/manufacturing-luminaire.integration.spec.ts`, `apps/api/prisma/migrations/20260930100000_luminaire_inventory/migration.sql`.

**Interfaces:** Produce `normalizeLuminaireSerial(raw: string, connectivity: "dfk" | "bio" | "none"): string`; `LuminaireInventory(serialNumber PK, connectivity, modelCode, ratedWatt, manufacturingStatus)`; `POST /manufacturing/luminaires`는 기존 `ManufacturingAuthGuard`를 쓰고 원자적 batch upsert가 아닌 충돌 검증 후 생성만 한다. DFK/BIO 값은 실제 광고 UUID와 동일하다.

- [ ] **Step 1: 실패 테스트 작성** — DFK/BIO 전체 값 정규화, 짧은/잘린 값·잘못된 family 거부, 같은 serial 중복·출고 후 정정 차단, 비통신 serial의 자동 등록 불가를 단위/격리 PostgreSQL 테스트로 고정한다.
- [ ] **Step 2: RED 확인** — `pnpm --filter @led-control/shared exec vitest run src/product-identity.test.ts`와 `pnpm --filter @led-control/api exec jest src/pki/manufacturing-luminaire --runInBand`; 새 계약 부재 때문에 실패해야 한다.
- [ ] **Step 3: 최소 구현** — 제조 mTLS 경계, Inventory 제약과 migration을 추가한다. 기존 `DiscoveredMeshNode.serialNumber`/`MeshNode.serialNumber`는 wire/DB 호환 별칭으로 유지하되 새 제품 번호를 생성하지 않는다. `docs/database-schema.md`를 같은 커밋에서 갱신한다.
- [ ] **Step 4: GREEN·커밋** — 두 집중 테스트, `prisma validate/generate`, disposable PostgreSQL의 전체 `migrate deploy`가 통과하면 Task 1 파일만 커밋한다.

### Task 2: 계획 스키마와 맵 좌표 프레임

**Files:** Modify `apps/api/prisma/schema.prisma`, `apps/api/src/floor-import/floor-import.service.ts`, `apps/api/src/floor-editor/map-document-reset.service.ts`, `apps/api/src/floor-editor/map-document-staging.service.ts`, `apps/api/src/floor-editor/map-document-mutation.service.ts`, `apps/api/src/floor-map/floor-map.service.ts`, `apps/api/src/floor-import/floor-import.integration.spec.ts`, `apps/api/src/floor-editor/map-document-reset.integration.spec.ts`, `apps/api/src/floor-editor/map-document-staging.integration.spec.ts`, `apps/api/src/floor-map/floor-map.integration.spec.ts`, `docs/database-schema.md`; create `apps/api/prisma/migrations/20260930110000_installation_plan/migration.sql`.

**Interfaces:** Produce `Floor.coordinateFrameVersion Int @default(0)`; `InstallationPlan`(floor/site/version/status/commitKey/sourceSha256/frameVersion/mapRevision), `InstallationPlanItem`(planId/positionCode/serialNumber/x/y/fixtureId?/slotId?/reserved), `InstallationCommissioningRun`(site/floor/gateway/session?/runGroupKey/status). DB partial unique `InstallationPlanItem.serialNumber WHERE reserved`, plan별 positionCode unique, 한 층의 active 계획 하나. `reserved`는 active/stale에서 유지하고 superseded 때 같은 거래에서 해제한다.

- [ ] **Step 1: 실패 테스트 작성** — CAD 재적용/맵 reset·resize는 frame version 증가와 계획 stale을 원자적으로 수행하고, 단순 장식 편집은 증가시키지 않는지 격리 PostgreSQL에서 검증한다.
- [ ] **Step 2: RED 확인** — `pnpm --filter @led-control/api exec jest src/floor-import/floor-import.integration.spec.ts src/floor-editor/map-document-reset.integration.spec.ts --runInBand`의 새 단언이 실패해야 한다.
- [ ] **Step 3: 최소 구현** — Floor 잠금과 기존 editor lease/revision을 유지한 채 버전·상태를 같은 거래에서 바꾼다. 슬롯은 CAD 후보 전용으로 유지하고 plan row에는 가짜 후보를 만들지 않는다. 기존 Fixture 미배치 전환은 유지한다.
- [ ] **Step 4: GREEN·커밋** — 집중 테스트, DB 제약/동시성 테스트와 disposable DB migration 검증 후 schema 문서를 함께 커밋한다.

### Task 3: 설치 CSV 미리보기·확정·조회 API

**Files:** Create `apps/api/src/installation-plans/installation-plan-csv.ts`, `installation-plan-csv.spec.ts`, `installation-plan.service.ts`, `installation-plan.integration.spec.ts`, `installation-plan.controller.ts`, `installation-plan.controller.spec.ts`, `installation-plan.module.ts`; modify `apps/api/src/app.module.ts`, `apps/api/src/api-body-parser.ts` and its spec.

**Interfaces:** `preview(user, siteId, csvText, floorBindings): Promise<InstallationPlanPreview>`는 쓰기 없이 행별 오류·지도 오버레이·`previewDigest`(파일 해시+현장+정렬된 층 ID 매핑+mapRevision+frameVersion)를 반환한다. `commit(user, siteId, csvText, floorBindings, previewDigest, commitKey): Promise<InstallationPlanSummary>`는 같은 값을 거래 안에서 재검사한다. Web은 파일을 UTF-8 text로 읽고 JSON 본문에 전달하며, 두 route만 3 MiB JSON body limit를 적용한 뒤 CSV 원문은 별도 2 MiB로 검사한다. `commitKey`는 확인 동작당 새 UUID이고 동일 현장·같은 digest에서만 멱등이다. `GET /sites/:siteId/installation-plans?floorId=...`는 권한 있는 viewer에게 예정 항목과 상태를 반환한다.

- [ ] **Step 1: 실패 테스트 작성** — CSV 헤더/UTF-8/중복/2 MiB·20,001총행·2,001층행/비유한·범위 밖 좌표, 없는 제조 serial, 비통신 제품 표시, 층 코드 매핑 누락·중복, 기존 등록 충돌, preview 무쓰기, digest drift/동시 현장 예약/중복 commit을 검증한다.
- [ ] **Step 2: RED 확인** — `pnpm --filter @led-control/api exec jest src/installation-plans --runInBand`가 새 테스트에서 실패해야 한다.
- [ ] **Step 3: 최소 구현** — 사이트 manage 조회/거래 재인가, Floor·Inventory 행 잠금, Serializable 거래와 `reserved` partial unique를 사용한다. 모든 층을 함께 적용하거나 전부 rollback한다. 미리보기의 한 행도 DB에 저장하지 않는다.
- [ ] **Step 4: GREEN·커밋** — unit·격리 PostgreSQL integration, API typecheck를 통과하고 Task 3 파일만 커밋한다.

### Task 4: 재개 가능한 일괄 등록 조정

**Files:** Create `apps/api/src/installation-plans/installation-commissioning.service.ts`, `installation-commissioning.service.spec.ts`, `installation-commissioning.integration.spec.ts`, `installation-commissioning.worker.ts`, `installation-commissioning.worker.spec.ts`; modify `apps/api/src/installation-plans/installation-plan.controller.ts`, `installation-plan.module.ts`, `apps/api/src/registration/registration.service.ts`는 필요한 내부 호출 경계에 한정한다.

**Interfaces:** `start(user, siteId, gatewayId, runKey): Promise<InstallationCommissioningSummary>`는 plan에 있는 통신 제품만 대상으로 층별 run을 만든다. `processPending(): Promise<void>`는 DB lease로 run당 하나의 worker만 기존 `createSession`→scan 완료→`registerBatch`를 순차 실행한다. 한 등록 요청은 현재 계약의 최대 1,000노드로 자르고, `mode: "individual"`에서 `fixtureName=positionCode`, `ratedWatt=Inventory.ratedWatt`, `size=20`을 항목별 전달한다. 한 청크의 멱등 완료를 기록한 후 다음 청크로 넘어간다. `GET /sites/:siteId/installation-commissioning/:runGroupKey`는 planned/unseen/provisioning/reconcile/registered 진행률을 제공한다.

- [ ] **Step 1: 실패 테스트 작성** — 두 층을 함께 발견한 Gateway, 알 수 없는 UUID, 비통신 제품 제외, Gateway offline, 1,001개를 1,000+1 청크로 전송, 서로 다른 정격전력·위치 이름, 재시작·동시 worker, 미완료 scan, `reconcile_required` 무자동 재시도와 동일 runKey 재시도를 검증한다.
- [ ] **Step 2: RED 확인** — `pnpm --filter @led-control/api exec jest src/installation-plans/installation-commissioning --runInBand`의 새 테스트가 실패해야 한다.
- [ ] **Step 3: 최소 구현** — 기존 등록 lock/주소 배정/outbox를 우회하지 않는 조정 계층만 추가한다. run에 요청자 ID를 보존하고 worker 단계마다 현장 manage 권한을 다시 확인하며 권한이 사라지면 중단한다. 자동 identify가 필요한 제품은 기존 안전 정책이 허용할 때만 진행하고 미확인 상태를 성공으로 간주하지 않는다.
- [ ] **Step 4: GREEN·커밋** — 집중 테스트와 기존 `registration.service.spec.ts` 회귀를 통과하고 Task 4 파일만 커밋한다.

### Task 5: terminal 배치 연결·위치 확인 경계

**Files:** Modify `apps/api/src/mqtt/provisioning-device-terminal.service.ts`, `apps/api/src/mqtt/provisioning-device-terminal.service.spec.ts`, `apps/api/src/installation-plans/installation-plan.service.ts`, `apps/api/src/installation-plans/installation-plan.controller.ts`; create `apps/api/src/installation-plans/installation-terminal.integration.spec.ts`.

**Interfaces:** `bindProvisionedFixture(tx, deviceUuid, sessionFloorId, fixtureId): Promise<void>`는 terminal 성공 거래에서 계획 serial/층/frame과 실제 Fixture를 재검사하고 x/y를 적용하며 `positionVerifiedAt=null`로 남긴다. 이미 등록된 제품의 serial 변경은 Task 3 계획 확정에서 409로 거부한다. 기존 맵 편집의 사람 위치 확인 경로를 재사용한다.

- [ ] **Step 1: 실패 테스트 작성** — terminal 성공 1회/중복·늦은 ACK, 다른 층·stale frame·기존 Fixture 충돌, slot의 정확한 좌표·1:1 조건, 계획 충돌 시 기존 이력 불변, 사람 확인 전/후 시간을 검증한다.
- [ ] **Step 2: RED 확인** — `pnpm --filter @led-control/api exec jest src/mqtt/provisioning-device-terminal.service.spec.ts src/installation-plans --runInBand`의 새 단언이 실패해야 한다.
- [ ] **Step 3: 최소 구현** — 기존 terminal 거래 안에서만 plan과 Fixture를 연결하고, 기존 unplanned 수동 등록 경로는 그대로 둔다. 불확실 terminal은 `reconcile_required`를 유지한다.
- [ ] **Step 4: GREEN·커밋** — focused unit/격리 PostgreSQL integration 및 기존 registration·floor-editor 관련 테스트를 통과하고 커밋한다.

### Task 6: 설정 페이지 설치 계획 UI

**Files:** Create `apps/web/src/api/installation-plans.ts`, `apps/web/src/features/settings/registration/InstallationPlanPanel.tsx`, `InstallationPlanPreview.tsx`, `InstallationCommissioningProgress.tsx`, 각 test; modify `RegistrationSettingsView.tsx`, `docs/menus/settings.md`.

**Interfaces:** 기존 `/settings/registration?siteId=...` 안에 `설치 계획`/`수동 등록` 내부 탭을 두고 Gateway claim/기존 수동 등록 세션은 탭 왕복에도 유지한다. 계획 가져오기·확정은 Gateway가 0개여도 접근 가능하고, 일괄 등록 시작만 Gateway 연결 뒤 활성화한다. 계획 카드에는 CSV 선택, `floorCode→Floor.id` 매핑, 맵 미리보기·행 번호 오류표, 확정, 일괄 등록 시작/진행/재개가 있다. 등록된 제품의 교체는 지원하지 않음을 안내하고 서버 409도 재시도 버튼 없이 같은 의미로 표시한다. 제품 표시 ID는 serial 하나이고 목록 축약 시 상세에서 전체 값 확인·복사가 가능하다. 수동 등록의 신규 제품은 serial/UUID 중복 표시를 제거하되 서로 다른 레거시 값은 기술 정보에서 둘 다 보존한다.

- [ ] **Step 1: UI/UX 디자이너 세션의 화면 명세를 확인하고 실패 테스트 작성** — admin만 설정 등록 route 접근, viewer는 기존처럼 리다이렉트하고 모니터링에서 읽기, Gateway 없음에도 계획 확정 가능, Gateway offline에서 등록 시작 차단, 잘못된 파일·행 번호와 전체 확정 차단, 부분 성공·reconcile, 등록 제품 교체 안내·차단, 수동 등록 탭 왕복/serial·UUID 레거시 표시, 새로고침 뒤 run 복구, 키보드/스크린리더와 320/390/1024/1440px를 고정한다.
- [ ] **Step 2: RED 확인** — `pnpm --filter @led-control/web exec vitest run src/features/settings/registration`과 관련 Chromium spec에서 새 화면 단언이 실패해야 한다.
- [ ] **Step 3: 최소 구현** — 공통 Button/Card/Dialog/Feedback를 재사용하고 설치 계획 화면을 기존 수동 등록과 나란히 둔다. `docs/menus/settings.md`에는 실제 구현과 HIL 한계를 함께 기록한다.
- [ ] **Step 4: GREEN·커밋** — 집중 unit/Chromium, Web typecheck, UI 정책 검사가 통과하면 Task 6 파일만 커밋한다.

### Task 7: 모니터링의 예정·실제 분리

**Files:** Create `apps/web/src/features/monitoring/PlannedFixtureMarkers.tsx`와 test; modify `apps/web/src/features/monitoring/MonitoringView.tsx`, `FloorMap.tsx`, 관련 API query, `docs/menus/monitoring.md`.

**Interfaces:** `GET installation-plans`의 예정 항목을 `FloorMapViewport` 논리 좌표에 별도 레이어로 그린다. 실제 Fixture가 연결되면 예정 마커를 중복 표시하지 않는다. 예정/등록·위치 미확인/위치 확인은 범례·접근성 문구로 구분하며 실제 KPI·제어·통계 대상 수는 기존 Fixture 기반 그대로다. stale 계획은 정상 예정 위치처럼 그리지 않고 재확정 안내를 표시한다.

- [ ] **Step 1: 실패 테스트 작성** — Fixture 0/계획 2, 등록 1/예정 1, 비통신 제품, stale 맵의 잘못된 마커 숨김, 읽기 전용 viewer, 마커의 목록 대안·층당 2,000개 렌더/스크롤·320px 범례와 실제 KPI 불변을 검증한다.
- [ ] **Step 2: RED 확인** — `pnpm --filter @led-control/web exec vitest run src/features/monitoring`의 새 테스트가 실패해야 한다.
- [ ] **Step 3: 최소 구현** — 기존 FloorScene 실제 조명 마커 선택·팝오버·카메라 기능을 보존하면서 계획 레이어만 추가한다. `docs/menus/monitoring.md`를 같은 커밋에서 갱신한다.
- [ ] **Step 4: GREEN·커밋** — 집중 unit/Chromium과 4폭 시각 검토 후 Task 7 파일만 커밋한다.

### Task 8: 전체 연결·회귀·인수

**Files:** Add `apps/web/e2e/installation-plan-journey.spec.ts`; update only 실제 구현에 따라 `docs/menus/settings.md`, `docs/menus/monitoring.md`, `docs/database-schema.md`, `docs/project-status.md` and this checklist.

**Interfaces:** 격리 PostgreSQL/Redis/MQTT·test Gateway simulator에서 제조 원장→CSV 500행/두 층→예정 맵→부분 검색/terminal→실제 배치→위치 확인/예외를 검증한다. HIL은 software 인수와 별도로 남긴다.

- [ ] **Step 1: E2E 실패 테스트 작성·RED 확인** — 실백엔드 여정은 한 파일에서 기존 수동 등록 회귀와 새 일괄 등록을 함께 검증한다.
- [ ] **Step 2: 최소 연결 보완** — 테스트에서 드러난 계약/권한/캐시 invalidation 결함만 담당 소유 파일에서 수정한다.
- [ ] **Step 3: 최종 검증** — `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm --filter @led-control/web ui:check`, 새 격리 DB migration/E2E를 fresh 실행하고 실패·skip을 그대로 보고한다.
- [ ] **Step 4: 검토·기록** — 독립 코드 리뷰, API·DB·Web diff 및 문서 일치 확인 후 상태판과 체크리스트를 갱신한다. 중앙 DB migration, 제품 라벨 발행, 실장비 HIL, 운영 배포는 별도 승인 전 실행하지 않는다.

## 실행 관문

이 계획은 사용자가 읽고 승인하기 전 제품 코드 구현을 시작하지 않는다. 승인 후 설정 페이지 담당 세션이 구현 조정의 주 담당이며, 공유 DB/API 변경은 backend 소유 역할과 계약·순서를 확인하고, UI/UX 디자이너 세션의 화면 명세를 Task 6 전에 반영한다. 각 Task의 RED→GREEN·리뷰·커밋을 체크리스트에 기록한다.
