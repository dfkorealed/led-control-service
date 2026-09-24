# 제어 스케줄 적용 기간 가시성 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 스케줄 빠른 설정에서 현장 기준 적용 시작·종료일을 항상 확인하고, 기본 ‘매일’ 설정이 오늘 하루만 유효하다는 점을 저장 전에 알린다.

**Architecture:** 현재 `ScheduleFormValues`와 날짜/시간 변환·제출 계약은 유지한다. 기존 `DatePicker` 두 개를 접힌 고급 설정에서 기본 ‘언제 켤까요?’ 영역으로 옮기고, 동일 날짜의 하루 적용 안내와 기간이 명시된 요약을 현재 값에서 파생한다. 새 API·상태 저장소·공통 UI는 만들지 않는다.

**Tech Stack:** React 18, TypeScript, React Aria 기반 공통 `DatePicker`, Tailwind v4 의미 토큰, Vitest/Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-15-tailwind-design-system-migration-design.md` 0장, `docs/assets/ux-refresh-2026-09-23/design-review.md`.

## Global Constraints

- 수정 범위는 제어 feature·해당 focused tests·`apps/web/e2e/calm-operations-automation.spec.ts`·`docs/menus/control.md`와 이 계획으로 제한한다.
- `createEmptyScheduleForm`의 시작일·종료일 기본값은 모두 현장 기준 오늘로 유지한다. 반복 횟수와 서버 `activeFrom`/`activeUntil` 변환을 바꾸지 않는다.
- 저장 전 fixture snapshot 재검증, 단일 Gateway/Mesh 준비 상태, gateway sync, 권한·URL 계약을 그대로 유지한다.
- 기존 공통 `DatePicker`, `Text`, `AutomationSummaryBar` 및 의미 토큰을 사용한다. 공통 UI/theme/shell은 수정하지 않는다.
- mock/Chromium 증거를 실장비·BIO HIL 증거로 표현하지 않는다.
- 병렬 checkout에서는 소유 범위의 focused Vitest/Playwright만 실행한다. 공용 Vite build·전체 Web test·workspace lint/typecheck는 총괄 최종 통합 게이트에서 직렬 실행한다. 본인 범위 타입 오류는 필요 시 단일 typecheck로 진단하고 공용 dist 동시 빌드는 하지 않는다.
- 총괄 지시에 따라 이 작업에서는 `git add`/`git commit`하지 않는다. `docs/project-status.md`는 총괄이 갱신한다.

## Review Focus

- ‘매일’과 종료일이 오늘인 조합: 사용자가 무기한 반복으로 오해하지 않도록 날짜와 ‘오늘만 적용’ 안내가 고급 설정을 열지 않아도 보이는가.
- 시작·종료일을 다른 날짜로 바꾼 조합: 하루 안내가 거짓으로 남지 않고 기간 요약이 즉시 갱신되는가.
- 기존 스케줄 수정: 저장된 날짜를 그대로 보여 주며 신규 기본값으로 덮어쓰지 않는가.
- 날짜 오류: 본문 필드에 오류와 focus가 연결되고 불필요하게 고급 설정을 여는 부작용이 없는가.
- 390/320px: 두 날짜 필드와 기간 안내가 가로 overflow·dialog clip 없이 도달 가능한가.

---

### Task 1: 스케줄 기간을 빠른 설정에 노출

**Files:**
- Modify: `apps/web/src/features/control/automation/ScheduleDialog.test.tsx`
- Modify: `apps/web/src/features/control/automation/ScheduleDialog.tsx`
- Modify: `apps/web/src/features/control/automation/automation-presenters.test.ts`
- Modify: `apps/web/src/features/control/automation/automation-presenters.ts`
- Modify: `apps/web/src/features/control/automation/ScheduleControlPanel.test.tsx` (기존 advanced 전제 assertion 갱신만)

**Interfaces:**
- Consumes: 현재 `ScheduleFormValues`, `createEmptyScheduleForm(timeZone)`, 공통 `DatePicker`, `scheduleSummary(values, dashboard)`.
- Produces: 기존 함수 시그니처와 API payload는 그대로; 기본 폼의 항상 보이는 날짜 필드·하루 한정 안내·명확한 요약 문자열.

- [x] **Step 1: RED 테스트 작성.** `ScheduleDialog.test.tsx`에 새 스케줄 기본 날짜 노출·오늘 안내와 저장된 다일 범위 확인, `automation-presenters.test.ts`에 하루/다일 요약을 추가했다. `calm-operations-automation.spec.ts`의 네 viewport 공통 여정에는 두 날짜의 기본 화면 가시성과 오늘 안내 assertion을 추가했다.
- [x] **Step 2: RED 확인.** focused Vitest 21건 중 3건이 의도한 기간 가시성/문구 원인으로 실패했다. 병렬 checkout 포트 충돌을 피하기 위해 브라우저 RED/GREEN은 총괄의 직렬 통합 게이트로 넘겼다.
- [x] **Step 3: 최소 구현.** `ScheduleDialog.tsx`의 두 `DatePicker`를 기본 ‘언제 켤까요?’ fieldset에 한 번만 렌더링한다. `createEmptyScheduleForm(timeZone)`의 현장 오늘값과 현재 선택값을 비교해 기본 단일일에는 `오늘만 적용`, 다른 단일일에는 `선택한 날짜 하루만 적용`, 다일에는 현장 시간대 안내를 노출한다. 날짜 오류는 기본 영역 필드로 focus하고 `advancedErrorKeys`에서 날짜 두 개를 제거한다. `scheduleSummary`의 단일일 문구를 `하루만 적용`으로 정돈한다. 서버 변환/검증은 수정하지 않는다.
- [x] **Step 4: GREEN 확인(단위).** focused Vitest 네 파일 61/61 통과. Playwright는 총괄 직렬 통합 게이트 대기다.
- [x] **Step 5: 범위 검토.** `git diff --check` 종료 코드 0과 소유 파일 diff를 확인했다. 변경은 날짜 UI·기간 문구·focused tests/E2E assertion·제어 메뉴 문서/계획에 한정되고 API/payload 코드는 변경하지 않았다.

### Task 2: 메뉴 현황과 전달 증거

**Files:**
- Modify: `docs/menus/control.md`
- Modify: `docs/superpowers/plans/2026-09-24-control-schedule-period-visibility.md`

**Interfaces:**
- Consumes: Task 1의 실제 UI/테스트 결과.
- Produces: 구현 상태와 한계가 일치하는 제어 메뉴 문서 및 체크리스트.

- [x] **Step 1:** 기존 문서의 ‘적용 기간은 고급 설정’ 서술을 수정하고, 현장 오늘 기본값·단일일 안내·날짜 field 기본 노출·기존 payload/HIL 한계를 기록한다.
- [x] **Step 2:** focused Vitest 61/61 통과와 `git diff --check` 종료 코드 0을 확인했다. Playwright 및 전체 Web test/build/typecheck는 병렬 checkout 충돌 방지를 위해 총괄 직렬 통합 검증 대기다.
- [x] **Step 3:** 변경 파일·focused Vitest 61/61·`git diff --check` 0·Playwright/전체 gate 미실행과 모바일 레이아웃 잔여 위험을 총괄 작업에 보고했다. 이 담당 작업은 stage/commit하지 않았다.
