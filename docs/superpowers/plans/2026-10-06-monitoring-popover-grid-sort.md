# 모니터링 Popover·Grid 정렬 실행 체크리스트

> 담당 구현 에이전트는 자신의 작업 설명만 읽고 구현·검증한다. 총괄이 상태와 검수를 취합한다.

**Goal:** 모니터링 주석 3건을 수정하고 기존 공통 DataGrid에 접근 가능한 컬럼 정렬을 적용한다.

**Architecture:** React Aria와 기존 Popover·반응형 DataGrid 구조를 유지한다. 새로운 Grid 라이브러리나 API 정렬 계약은 도입하지 않는다.

**Tech Stack:** React 18, react-aria-components 1.21.1, TypeScript, Vitest, Playwright.

**Spec:** 사용자의 2026-10-06 브라우저 주석 3건과 Grid 정렬 요청. 기존 흐름의 제한된 수정이며 이전 사용자의 바로 진행·단순화·별도 브랜치 병합 지시를 따른다.

## 공통 제약

- 작업 폴더: `/Users/kim-jh/Documents/led-control-service/.worktrees/operations-ui-refinement-20261004`, 브랜치: `codex/monitoring-popover-grid-sort-20261006`, BASE: `f74fc94f3b573054d7437eef926a7aa5f95414d6`.
- 메인 폴더, 기존 서비스·DB·게이트웨이·센서, API·공유 패키지 계약, 패키지 의존성은 변경하지 않는다.
- 기존 React Aria overlay·버튼·필드와 디자인 토큰을 사용한다. 수정에 해당하는 메뉴 문서를 함께 갱신한다.
- 구현 담당은 서브에이전트를 추가로 생성하지 않고 소유 파일만 커밋한다. 각 작업은 RED→GREEN과 표적 회귀 증거를 남긴다.
- 정렬은 Grid에 전달된 현재 목록 범위다. 서버 커서 페이지 전체 정렬로 표시하지 않으며 원본 배열을 변경하지 않는다.
- 총괄이 마지막에 Web 전체 단위 테스트·typecheck·build·UI 정책과 관련 화면 검증을 한 번 취합한다. 이전 Gateway 타임아웃을 해결했다고 주장하지 않는다.

## 검수 초점

- popover의 Escape/바깥 클릭 닫기·초점 복귀와 좁은 화면에서 내용/상세 접근.
- 검색·상태 필터 변경 후 맵 표시 및 기존 선택 조명만 상세 표시.
- 한글·영문·숫자·날짜·동일값·누락값의 정렬과 원본 배열 불변.
- 좁은 카드형 목록의 동일 정렬, 넓은 표의 aria-sort·키보드 동작.
- 헤더 집계의 한글 glyph·대수 표기가 1706px/390px/200% CSS 확대에서 잘리지 않음.

### Task 1: 모니터링 검색 Popover와 헤더 잘림

**소유 파일:** `apps/web/src/features/monitoring/MonitoringView.tsx`, `MonitoringSummary.tsx`, 필요한 검색/상세 컴포넌트와 대응 테스트, `apps/web/src/features/shells/CustomerHeaderSummarySlot.tsx` 및 대응 테스트, `apps/web/e2e/monitoring-surface-access.spec.ts`, `docs/menus/monitoring.md`.

**인터페이스:** 기존 모니터링 검색·상태 필터·선택 상세의 상태를 유지하고 기존 공통 Popover를 소비한다. 공통 Grid 파일과 다른 메뉴는 편집하지 않는다.

- [x] 기존 화면을 재현하고 검색·상세가 popover에 표시되며 맵 선택 오른쪽에 있는 회귀 테스트를 먼저 작성한다.
- [x] 별도의 우측 맵 상태 필터 버튼을 제거하고 그 기능을 맵 선택 오른쪽의 단일 `조명 검색·상세` 버튼 popover에 합친다. 기존 검색·목록·선택한 조명 상세 흐름을 유지한다.
- [x] `표시 상태: 전체 조명` 등의 표시 상태 설명을 제거하고 헤더 집계에 충분한 line-height·패딩/줄바꿈을 보장한다.
- [x] 관련 단위 테스트와 1706×1226/390×844 화면의 실제 브라우저 검색·필터·초점·글씨 경계를 확인한다.
- [x] 메뉴 문서를 갱신하고 소유 파일만 커밋해 변경 파일·검증 명령/결과·제한을 보고한다.

검수: 제품 `9b4f2113`, 단위106PASS·브라우저13PASS. 독립 코드 Spec✅/QualityApproved/C0/I0, 디자이너 원 PNG8장·bounds 대조로 주석3건 승인/차단0. CSS200과 native/browser zoom·HIL은 구분하며 기존 실행 환경 경고를 보존했다.

### Task 2: 공통 Grid 정렬과 소비자 적용

**소유 파일:** `apps/web/src/components/ui/DataGrid.tsx` 및 대응 테스트, 필요할 때 같은 UI 폴더의 정렬 유틸리티/헤더 셀, `features/control/automation/ScheduleControlPanel.tsx`, `VehicleEventControlPanel.tsx`, `components/AutomationRuleTable.tsx`, `features/statistics/reports/ReportJobList.tsx`, `features/settings/users/SiteUsersView.tsx`, `features/operator/site-admins/SiteAdminManagementView.tsx`, `features/operator/LandingInquiriesView.tsx` 및 대응 테스트·E2E, 영향받는 `docs/menus/control.md`, `statistics.md`, `settings.md`, `operator.md`.

**인터페이스:** `DataGridColumn<T>`에 선택적 `sortValue(row: T): string | number | boolean | Date | null | undefined`를 추가한다. 접근자가 없는 작업 컬럼은 정렬하지 않는다. 기존 props는 계속 호환한다.

- [x] 현 Grid가 React Aria Table인지 확인하고 결과를 보고서에 적는다. 정렬 RED 시험을 작성한다.
- [x] 공통 Grid에서 컬럼 헤더 버튼으로 오름차순/내림차순을 전환하고 `aria-sort`와 방향 아이콘을 제공한다. 한국어/numeric 문자열 비교·날짜/숫자 비교·동일값 안정 정렬·누락값 마지막 배치를 보장한다.
- [x] 카드형 목록에도 기존 공통 SelectBox/버튼으로 정렬 컬럼과 방향을 제공한다. 컬럼이 바뀌거나 데이터가 갱신돼도 유효한 정렬만 사용하고 원본 배열/행 작업을 보존한다.
- [x] 모든 기존 DataGrid 소비자의 의미 있는 컬럼에 typed 접근자를 적용한다. 스케줄/이벤트에 같은 정렬 경험을 제공하고 작업 버튼은 제외한다.
- [x] 공통/소비자 단위 회귀와 스케줄/이벤트 실제 브라우저 정렬을 확인하고 메뉴 문서와 소유 파일만 커밋한다.

검수: 정렬 `b6dc5645`, 최소 관문 보완 `92f0f159`. 표적235PASS/브라우저2PASS, 보완22PASS/브라우저5PASS. 최초 최종 검사에서 test 옵션 타입오류·lazy route 대기 전제·미승인 typography를 발견해 수정했고 독립 scoped 재검수에서 전부 ADDRESSED/새 차단0을 확인했다. 보완 후 전체 Web3242PASS·기존3SKIP, typecheck/build/UI-policy0. 원 실패/경고 및 현 목록·CSS 확대 한계를 보존한다.

### Task 3: 총괄 검수·병합

- [x] 담당 에이전트 결과와 변경 diff를 취합하고 독립 코드·UI/UX 검수로 주석 3건 및 정렬 계약을 확인한다.
- [x] 현재 소스에서 Web 전체 단위 테스트·typecheck·build·UI 정책과 관련 브라우저 회귀를 실행해 실제 결과를 기록한다.
- [x] 검수 차단 오류를 보완한 뒤 기본 브랜치에 로컬 병합하고 사용자 화면 반영 및 상태판/체크리스트를 완료로 갱신한다. 원격 push·DB/장비 변경은 하지 않는다.

최종 취합(제품 `1c600eda`): 최신 기본 브랜치 `2e78b51f`의 모바일/iOS 완료분을 보존 통합했다. 첫 통합 관련33회귀의32PASS/보고서320px 1FAIL은 정렬 도구의 선행 높이 때문이었으며 compact 공통 한행 정렬·보고서 파일 작업 우선 배치로 최소 보완했다. 원 실패·PNG/trace를 보존하고 변경 소스의 전체 Web226파일/3261테스트=3258PASS·0FAIL·기존3SKIP, typecheck/build/UI-policy0, 관련33브라우저33PASS를 fresh 실행했다. 독립 코드 whole-branch C0/I0/M1의 옛 모바일 검색 배치 문장은 완료문서에서 수정했고, 최소 보완 scoped C0/I0/M0·UI/UX 대표6장+보완2장 차단0을 회수했다.

로컬 `codex/mvp1-cloud-web`은 `2e78b51f→1c600eda` ff-only 병합했고 제품 트리가 검증 후보와 일치한다. 기본 checkout에서 표적118PASS·typecheck0을 재확인했다. 실행 중인 localhost5173의 단일 검색/상태 Popover와 헤더, 스케줄 표의 이름 정렬/aria-sort=ascending을 실제 사용자 탭에서 확인·캡처했다. 기존 Web58125/API58193은 유지했고 자기 격리Vite53146만 종료했다. 별도 센서 브랜치·API/DB/장비·원격push·물리 native/HIL·genuine zoom 및 과거 Gateway timeout은 이번 완료 범위가 아니다. 재사용 worktree/브랜치와 ignored 검증 증거는 보존한다.
