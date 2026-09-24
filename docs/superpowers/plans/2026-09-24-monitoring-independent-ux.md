# 모니터링 독립 UX 개선 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 이 작업은 총괄이 동일 checkout의 비중첩 파일을 병렬 조율하므로 별도 worktree·git commit을 만들지 않는다.

**Goal:** 모니터링의 밝기·장애 안내, 320/390px KPI, 검색/미배치 목록 접근을 승인된 UX 범위에서 개선한다.

**Architecture:** 현행 `useFloorFixtures` 페이지와 단일 `selectedFixtureId`를 그대로 사용한다. 기능 국소 발표 로직과 목록 UI만 `features/monitoring`에 추가하고 `FloorScene`, 공통 UI, 셸, query/API 계약은 수정하지 않는다.

**Tech Stack:** React, TypeScript, Tailwind v4, React Aria 기반 공통 UI, Vitest/Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-15-tailwind-design-system-migration-design.md` 0장 및 `docs/assets/ux-refresh-2026-09-23/design-review.md`.

## Global Constraints

- `apps/web/src/features/monitoring`, 해당 테스트, `docs/menus/monitoring.md`, 이 계획 문서만 수정한다.
- 상태 센터/toast, 전역 현장 선택, 공통 UI/theme/shell/floor-map, API/DB는 다른 담당 소유이므로 수정·복제하지 않는다.
- 사용 수치는 실제 fixture snapshot에서만 가져오며 미배치 조명은 지도 마커가 아니라 목록/상세에서 접근한다.
- 320/390/1024/1440px, 44px 조작 영역, read-only 지도 및 기존 refresh/pagination/선택 동기화를 보존한다.
- 실제 장비/HIL은 완료라고 기록하지 않는다. 병렬 checkout 중에는 focused Vitest/Playwright만 실행하고 공용 build/전체 test/workspace gate는 총괄 통합 단계에서 직렬 실행한다.

## Review Focus

- `lastSeenAt=null`인 등록 직후 조명에 마지막 밝기를 실제 현 출력처럼 보여주지 않는다.
- offline/stale 조명의 마지막 밝기는 마지막 수신 시각과 결합해 과거 관측임을 알린다.
- 200개 단위 페이지가 진행 중일 때 검색 0건을 최종 0건으로 단정하지 않는다.
- 미배치 조명은 저장된 도면의 마커를 임의로 생성하지 않고 목록에서 선택한다.
- 새 검색/목록이 수동 새로고침과 층 전환 뒤에도 이전 층 선택을 누출하지 않는다.

---

### Task 1: 최근 확인 밝기와 고객 언어 장애 안내

**Files:**
- Modify: `apps/web/src/features/monitoring/fixture-status-presentation.ts`
- Create: `apps/web/src/features/monitoring/fixture-brightness-presentation.ts`
- Create: `apps/web/src/features/monitoring/fixture-brightness-presentation.test.ts`
- Modify: `apps/web/src/features/monitoring/fixture-status-presentation.test.ts`
- Modify: `apps/web/src/features/monitoring/MonitoringView.tsx`
- Modify: `apps/web/src/features/monitoring/MonitoringView.test.tsx`

**Interfaces:** `presentFixtureBrightness(fixture: Pick<DashboardFixture, "brightness" | "status" | "statusReason" | "lastSeenAt">): { label: string; value: string; observedAt: string | null }`. 기존 `formatLastSeen`은 시각 보조 문구를 제공한다.

- [x] RED: offline/stale/null-last-seen 밝기 테스트와 Health fault 고객 문구 테스트를 작성한다. 상세 패널의 접근 가능한 값/시각 테스트도 추가한다.
- [x] `pnpm --filter @led-control/web exec vitest run src/features/monitoring/fixture-brightness-presentation.test.ts src/features/monitoring/fixture-status-presentation.test.ts src/features/monitoring/MonitoringView.test.tsx`에서 해당 새 케이스의 기대 실패를 확인한다.
- [x] GREEN: offline/stale는 `최근 확인 밝기`, 유효한 수신 기록이 없는 경우 `확인 전`, online/fault의 보고값은 `현재 밝기`로 표시한다. Health fault 설명/권장 조치를 고객 언어로 교체하고 기존 보조 Health 숫자 정보는 유지한다.
- [x] 같은 focused Vitest를 다시 실행하여 새 테스트와 기존 회귀 통과를 확인한다. 70/70 통과.

### Task 2: KPI의 모바일 밀도

**Files:**
- Modify: `apps/web/src/features/monitoring/MonitoringView.tsx`
- Modify: `apps/web/e2e/calm-operations-monitoring.spec.ts`

**Interfaces:** 기존 `[data-monitoring-summary]`와 `MetricCard` 4개 순서를 유지한다.

- [ ] RED: Chromium 320px 2열×2행, 390px 4열×1행 기대치를 기록하고 기존 배치와 불일치를 확인한다. 기대치는 기록했으나 병렬 서버 충돌을 피하라는 총괄 지시로 실행은 보류했다.
- [x] GREEN: 320px 2×2, 390px에서 읽을 수 있는 1×4를 적용한다. 모바일 helper는 중복 문구를 줄이고 값/라벨에 의미 토큰을 쓴다.
- [ ] focused monitoring Chromium 배치 테스트를 실행한다. 다른 담당의 공용 build와 중첩되면 충돌 없이 총괄 직렬 게이트로 넘긴다.

### Task 3: 검색 및 미배치 목록 경로

**Files:**
- Create: `apps/web/src/features/monitoring/MonitoringFixtureFinder.tsx`
- Create: `apps/web/src/features/monitoring/MonitoringFixtureFinder.test.tsx`
- Modify: `apps/web/src/features/monitoring/MonitoringView.tsx`
- Modify: `apps/web/src/features/monitoring/MonitoringView.test.tsx`
- Modify: `apps/web/e2e/calm-operations-monitoring.spec.ts`
- Modify: `docs/menus/monitoring.md`

**Interfaces:** `MonitoringFixtureFinder({ fixtures, selectedFixtureId, onSelectFixture, hasNextPage, isFetchingNextPage, onLoadMore, userRole, siteId, floorId })`. 검색은 조명 이름의 case-insensitive 부분 문자열과 `-L001` 같은 조명 번호를 포함하며, 상태 필터는 `전체/점검 필요/오프라인/미배치`로 좁힌다.

- [x] RED: 이름/번호 검색, 상태 필터, 미배치 선택, 다음 페이지 진행 중 안내, 층 전환 뒤 선택 리셋을 사용자 화면 기준으로 테스트한다.
- [x] 해당 focused Vitest의 기대 실패를 확인한다.
- [x] GREEN: 공통 `SearchField`/`Button`을 쓰는 feature-local 목록을 추가하고 하나의 `selectedFixtureId`와 연결한다. 현재 페이지가 비어도 next page가 있으면 최종 0건으로 표시하지 않는다. admin만 설정 배치 링크를 본다.
- [ ] focused Vitest/Chromium 여정을 다시 실행한다. `docs/menus/monitoring.md`에 실제 구현과 mock/HIL 한계를 갱신한다. Vitest와 문서는 완료했으나 Chromium은 총괄의 직렬 게이트 대기다.
- [x] `git diff --check`와 소유 파일 diff를 확인하고 총괄에게 파일·테스트·잔여 위험을 보고한다. 공용 Web typecheck/build/full test는 총괄의 직렬 통합 게이트에서 수행한다. `git diff --check` exit 0, 모니터링 Vitest 85/85; 현 checkout의 읽기 전용 Web `tsc --noEmit`은 다른 담당 파일 `src/api/client.ts:152:36` TS2322로 실패.

### Task 4: 승인된 phone-wide 반응형 토큰

**Files:**
- Modify: `apps/web/src/styles/theme.css`
- Modify: `apps/web/scripts/ui-policy.mjs`
- Modify: `apps/web/scripts/ui-policy.test.mjs`
- Modify: `apps/web/src/features/monitoring/MonitoringView.tsx`

**Interfaces:** `--breakpoint-phone-wide: 22.5rem`은 360px 경계이며 `phone-wide:`는 이상, `max-phone-wide:`는 미만의 모니터링 배치에만 쓴다. 정책은 이름·정확한 값과 선언 inventory를 기존처럼 검증한다.

- [x] RED: `pnpm --filter @led-control/web ui:check`에서 임의 `min-[360px]`/`max-[359px]` 3건을 재현한다.
- [x] 정책 테스트에 새 이름을 승인 전에는 거부하는 사례를 추가하고 기대 실패를 본다.
- [x] 정책 parser에 `phone-wide`를 정확히 인식시키고 정책 테스트를 다시 통과시킨다.
- [x] 새 토큰의 정확한 값·변경/누락 거부 테스트를 먼저 실패시킨 뒤 theme와 `reviewedThemeTokenAdditions`에 추가한다.
- [x] 화면 클래스를 `phone-wide:`/`max-phone-wide:`로 교체하고 `ui:check`, 정책 테스트, 모니터링 Vitest 85개, `git diff --check`를 재실행한다. UI policy 0건, 정책 58/58(실제 Vite CSS 생성 포함), 모니터링 85/85; stage/commit과 병렬 Playwright는 하지 않았다.
