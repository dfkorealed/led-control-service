# BIO 센서 기능 로컬 병합 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사용자 요청대로 검토 완료 센서 브랜치를 `codex/mvp1-cloud-web`에 병합하고 남은 제품 과제를 보고한다.
**Architecture:** 깨끗한 기존 센서 worktree에서 최신 기본 브랜치를 먼저 통합·검증한다. 기본 checkout의 미커밋 목업 문서 2개는 최종 ff-only 전까진 변경하지 않으며, 필요하면 정확한 두 경로만 내구 stash로 보존·복원한다. 전체 센서 코드를 다시 구현하거나 운영 환경에 적용하지 않는다.
**Tech Stack:** Git, React/Vitest/Playwright, TypeScript, NestJS/Prisma, BIO Gateway.
**Spec:** `../specs/2026-10-08-common-bio-sensor-configuration-design.md` 및 사용자 `그럼 일단 머지를 하고, 완벽한 이벤트 기능을 위한 남은 과제는 뭐야`.

## Global Constraints

- 기본 브랜치 기준 `5e173fb4`, 센서 승인 기준 `247a837d`; 양쪽 모바일·지도·알림 lifecycle·정렬·BIO 준비/권한/복원 기능을 보존한다.
- 정상·미준비 등록 조명 inspection, server eligibility-only confirmation, BIO hold10..1800/default60, 공통 준비 패널·모바일 pinch를 유지한다.
- 승인 profile empty·policy OFF, 운영 DB/Pi/RF/PKI/서버 재시작/push 금지. 실제 DB migration은 실행하지 않는다.
- 공유 수정은 `packages/shared/tsconfig.esm.json`의 양쪽 include 목록 결합만 승인한다. 새로운 계약/스키마/기능은 추가하지 않는다.
- 기본 checkout 미커밋 `docs/menus/control.md`, `docs/menus/monitoring.md` 목업 section은 사용자 변경으로 보존하고 병합 커밋에 섞지 않는다.
- 기존 기능 전체 suite/HIL 반복 대신 충돌·자동 합성 접점의 집중 검증과 변경 앱 타입/빌드를 수행한다. 이전 검증 수치를 새 통과로 복사하지 않는다.

## Review Focus

- 최신 모바일 높이/알림 owner를 보존하면서 BIO telemetry와 preparation inspection을 결합한다.
- 미준비 marker는 검사 가능하지만 source 확정은 현재 서버 판정으로 제한한다.
- 최신 컴팩트 이력 UI의 props·접근성·필터와 BIO 전용 이력을 모두 보존한다.
- Shared ESM/browser/CJS export와 최신 통계/화면 소비자 include가 함께 build된다.
- 기존 사용자 목업 문구와 양쪽 메뉴/상태 이력이 유실되지 않는다.

### Task 1: 격리 worktree의 양쪽 변경 통합·검증

**Owner:** web integration 단일 소유자; root 승인 범위에서 docs/Shared include만 함께 해결.
**Files:** 충돌 `apps/web/e2e/{calm-operations-manual-control,control-map-target-selection}.spec.ts`, `apps/web/src/features/control/{CommandHistoryPanel,ControlView}.tsx`, `automation/VehicleEventControlPanel{,.test}.tsx`, `target-selection/SpatialTargetSelector.tsx`; `packages/shared/tsconfig.esm.json`; `docs/{lesson_leared,project-status,menus/control,menus/monitoring,menus/settings}.md`. 자동 합성 Web/Shared/Prisma 접점도 읽기 검증한다.
**Interfaces:** 기존 양쪽 props/typed API를 합성하며 새로운 서버 계약을 만들지 않는다. 한 merge commit과 검증 보고서를 반환한다.

- [ ] 양쪽 parent와 conflict hunk를 대조해 기존 독립 기능이 필요한 접점을 확인한다. conflict가 RED이며 별도 신규 기능의 TDD로 과장하지 않는다.
- [ ] `apply_patch`로 충돌을 최소 합성하고 필요한 기존 focused 회귀만 보강한다. ours/theirs 파일 전체 선택으로 기능을 버리지 않는다.
- [ ] workspace prepare, 필요한 Prisma generate(사용자 DB 접근0), Shared export smoke·Web 충돌 관련 단위·API/Gateway 공통 경로 최소 회귀·앱 타입/빌드·UI정책·실제 기존 Chromium PC/mobile/pinch 표적을 검증한다. 실패는 정확한 원인과 최소 수정 범위를 보고한다.
- [ ] 충돌 markers0·diffcheck와 원래 양쪽 기능/문서 보존 자체검토 뒤 소유 merge commit/report를 인계한다. root 독립 통합 검토 후 Task2로 이동한다.

### Task 2: 기본 checkout 로컬 반영·사용자 문서 복원·인계

**Owner:** root orchestration.
**Interfaces:** Task1 검토 완료 merge HEAD를 기본 `codex/mvp1-cloud-web`에 ff-only 반영; 기존 사용자 2문서 diff는 동일 내용으로 uncommitted 복원.

- [ ] 기본/작업 HEAD와 dirty target2 경로를 다시 확인한다. 원격 동기화가 필요하면 fetch/ff-only만 허용하고 unrelated 원격 병합·push는 하지 않는다.
- [ ] 두 문서만 필요시 exact stash로 보존한 뒤 승인 HEAD를 ff-only 반영한다. stash는 검증 전 삭제하지 않는다.
- [ ] 사용자 문구·미커밋 상태 보존 및 기본 HEAD의 센서·최신 UI 포함을 확인한다. local workspace producer/대표 consumer smoke·diffcheck로 병합 후 상태를 확인한다.
- [ ] 상태판/체크리스트 동기화 후 로컬 merge 결과와 필수 실장비/운영 과제 및 선택 확장을 분리해 보고한다. 임시 기존 보호 자료가 있는 센서 worktree는 보존한다.
