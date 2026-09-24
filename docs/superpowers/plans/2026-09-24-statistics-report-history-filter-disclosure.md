# 통계 보고서 이력 필터 위계 구현 계획

> **실행 담당:** 통계 페이지 담당. `superpowers:test-driven-development`로 각 단계의 RED→GREEN을 확인한다. 이 공유 checkout에서는 다른 담당자의 파일을 stage/commit하지 않는다.

**Goal:** 보고서 이력의 검색·상태·요청 기간을 기본 필터로, 형식·범위를 접근 가능한 상세 필터로 표시하면서 필터 값과 cursor/URL/브라우저 이력을 보존한다.

**Architecture:** 기존 `ReportHistoryFilters`의 controlled `value`/`onChange`와 서버 query schema를 그대로 사용한다. 상세 패널의 열림 여부만 로컬 UI 상태로 관리하며 필터 변경을 발생시키지 않는다. `StatisticsReportsPage`의 URL·history-state·pagination 로직은 변경하지 않는다.

**Tech Stack:** React, TypeScript, React Aria 기반 공통 UI wrapper, Vitest/Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-15-tailwind-design-system-migration-design.md` 0장, `docs/assets/ux-refresh-2026-09-23/design-review.md` 05 보고서 시안.

## Global Constraints

- 수정 범위는 `apps/web/src/features/statistics/reports`의 제품·테스트 파일, `apps/web/e2e/statistics-flow.spec.ts`, `docs/menus/statistics.md`, 이 계획 파일뿐이다. 공통 UI/셸, API, shared, theme, 다른 E2E 및 `docs/project-status.md`는 수정하지 않는다.
- 공통 현장 선택/상태 센터 공개 계약이 확정되기 전까지 연동하지 않는다.
- 검색 debounce 300ms, 요청 기간 최대 90일, URL 정규화, site/filter fingerprint cursor, Back/Forward, 3초 polling은 보존한다.
- 파일 7일 만료와 재생성, PDF/XLSX 동일 불변 문서, CSV 별도 내보내기, 새 signed download URL은 변경하지 않는다.
- CSS literal/새 spacing token/로컬 overlay를 만들지 않고 기존 `Button`, `SelectBox`, `DateRangePicker`, semantic utility를 사용한다.
- 병렬 checkout에서는 소유 범위 focused Vitest만 실행한다. Playwright는 spec만 갱신하고 총괄의 직렬 통합 게이트에서 실행한다. 공용 Web 전체 test/typecheck/build, workspace lint/build도 총괄의 직렬 gate에서 실행한다. 필요한 단일 typecheck는 총괄과 시점을 맞춘다.
- mock UI/브라우저 증거를 실제 장비 HIL로 기술하지 않는다.

## Review Focus

1. URL에서 `format=pdf&scope=floor`가 복원돼도 상세 패널이 접힌 상태로 값/활성 chip을 확인할 수 있는가.
2. 상세 패널을 열고 닫는 것만으로 `onChange`, query key, URL 또는 cursor page가 바뀌지 않는가.
3. 상세 필터 하나를 지워도 나머지 조건과 페이지 크기는 유지되고 첫 페이지로 돌아가는가.
4. 유효하지 않은 90일 초과 날짜 초안이 상세 패널 토글로 URL에 반영되지 않는가.
5. 보고서 요청일과 보고서 본문 대상 기간의 설명이 서로 다른 기간임을 드러내는가.

---

### Task 1: 기본·상세 필터와 접근 가능한 disclosure

**Files:**
- Modify: `apps/web/src/features/statistics/reports/ReportHistoryFilters.test.tsx`
- Modify: `apps/web/src/features/statistics/reports/ReportHistoryFilters.tsx`

**Interfaces:** 기존 `ReportHistoryFiltersProps`의 `value`, `onChange`, `className`을 유지한다. 새로운 서버/query 필드는 없다.

- [x] **Step 1: RED 테스트 작성.** 처음에는 검색·상태·요청 기간만 보이고 `상세 필터` 버튼은 `aria-expanded=false`이며, 클릭 후 형식·범위 선택이 나타나는 것을 검증한다. 활성 `format=pdf`, `scope=floor`의 chip/개수를 닫힌 상태에서 확인하고 다시 열어 선택값이 유지됨을 검증한다.
- [x] **Step 2: RED 확인.** 새 테스트 2개가 상세 disclosure 부재로 실패했다.
- [x] **Step 3: 최소 구현.** `useState(false)`로 상세 패널만 토글한다. 기존 controlled `SelectBox` 2개를 `aria-controls`가 가리키는 패널에 배치하고 HTML `hidden` 속성과 CSS `hidden` 클래스로 숨긴다. 적용 개수는 현재 `value.format`/`value.scope`에서만 도출한다. 토글 핸들러에서 `onChange`를 호출하지 않는다.
- [x] **Step 4: GREEN 확인.** focused Vitest에서 새·기존 테스트가 모두 통과했다.

### Task 2: 페이지 이력 불변과 기간 의미 회귀

**Files:**
- Modify: `apps/web/src/features/statistics/reports/StatisticsReportsPage.test.tsx`
- Modify: `apps/web/src/features/statistics/reports/ReportHistoryFilters.test.tsx`
- Modify: `apps/web/src/features/statistics/reports/ReportHistoryFilters.tsx`
- Modify: `apps/web/src/features/statistics/reports/ReportCreateDialog.tsx`

**Interfaces:** `StatisticsReportsPage`의 필터 직렬화/커서 state, `ReportCreateDialog` 요청 payload와 날짜 상한은 변경하지 않는다.

- [x] **Step 1: RED 테스트 작성.** 2페이지+기존 `format=pdf&scope=floor` URL/history fixture에서 토글 전후 URL·page·query arguments가 같고, 상세 항목은 열기 전에도 chip으로 표시됨을 검증한다. 보고서 생성 dialog에는 ‘대상 기간’ 설명이 있고 목록 요청일 필터에는 ‘보고서를 요청한 날짜’ 설명이 있는지 검증한다.
- [x] **Step 2: RED 확인.** 새 의미 설명 테스트 2개가 실패했고 커서 불변 테스트는 구현 전부터 통과했다.
- [x] **Step 3: 최소 구현.** 필터의 `DateRangePicker` `description`과 생성 dialog의 기간 안내만 추가했다. 토글 UI 외의 필터 및 pagination state 코드는 수정하지 않았다.
- [x] **Step 4: GREEN 확인.** 최종 reports 폴더 focused Vitest 4 files·67/67 통과.

### Task 3: 브라우저 회귀·문서·인수 보고

**Files:**
- Modify: `docs/menus/statistics.md`
- Modify: `apps/web/e2e/statistics-flow.spec.ts`

- [x] **Step 1: 브라우저 회귀 spec 갱신.** 기존 responsive 보고서 테스트의 형식·범위 touch assertion을 상세 버튼 펼침 뒤로 옮기고 키보드 개폐·활성 조건·URL/표시 범위 불변을 검증하도록 작성했다. 실제 브라우저 실행은 아직 하지 않았다.
- [ ] **Step 2: 브라우저 회귀 실행 인계.** `pnpm --filter @led-control/web exec playwright test e2e/statistics-flow.spec.ts --workers=1 -g 'report history'`는 단일 공유 Vite 서버·dist 충돌을 막기 위해 총괄의 직렬 gate에 맡긴다. 이번 담당 결과에서는 미실행으로 명시한다.
- [x] **Step 3: 문서 갱신.** `구현 완료`, `부족하거나 개선이 필요한 기능`, `관련 파일`, `갱신 규칙` 구조를 유지하며 기본 3+상세 2, 접힌 활성 조건, 이력 불변과 소프트웨어 검증 한계를 적었다.
- [x] **Step 4: 정적 검증.** reports 폴더 focused Vitest 67/67 통과, 실제 Tailwind 컴파일로 `tablet` 4열·date span·button 폭 CSS 생성 확인, 소유 UI 소스 정책 위반 0건, `git diff --check -- <이번 작업 파일>` exit 0 및 소유 파일 상태를 확인했다. 전체 `ui:check`는 다른 담당 범위 `MonitoringView.tsx`의 `min-[360px]` 1건·`max-[359px]` 2건으로 실패했다. 공용 typecheck/build/전체 Web test는 총괄 직렬 gate 결과를 인수한다.
- [ ] **Step 5: 총괄 보고.** 파일 목록, RED/GREEN 수치, browser/typecheck/build 미실행과 총괄 gate 명령, 공통 API 미연동, PDF/XLSX·7일 정책 변경 없음, HIL 미실시를 전달한다. `git add`/`git commit`은 하지 않는다.

## Self-review

- [x] 설계 0장/05 시안과 기본·상세 위계가 일치한다.
- [x] 상세 패널 토글이 controlled filter state를 건드리지 않는다.
- [x] 새 disclosure/기간 설명 테스트는 기능 부재로 RED가 된 뒤 GREEN이 되었다.
- [x] 기존 보고서 요청/생성/다운로드 계약을 수정하지 않았다.
- [x] 다른 담당자의 파일이나 공용 dist를 변경하지 않았다.
