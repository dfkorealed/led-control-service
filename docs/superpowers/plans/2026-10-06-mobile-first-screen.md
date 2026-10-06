# 모바일 첫 화면 적용 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 컨트롤 크기를 유지하며 모바일 알림·공통 헤더와 세 메뉴 첫 화면을 개선하고 검증 후 로컬 병합한다.

**Architecture:** 최신 메인 공통 Shell·현장 URL·계정 controller를 재사용한다. SessionStatus의 transient toast와 scope별 최근 알림 읽음을 구분하고 모바일 표시에만 연결한다. 기존 페이지 owner를 유지하며 요약/상세의 배치를 조정한다.

**Tech Stack:** React18, TypeScript, 기존 React Aria UI·Tailwind 토큰·React Query·Konva/Recharts, Vitest/Playwright, React Native WebView 소비.

**Spec:** `docs/superpowers/specs/2026-10-06-mobile-first-screen.md`

## Global Constraints

- 동일 웹의 기존 compact `<760px`를 모바일 범위로 한다. Android/iOS WebView와 모바일 브라우저가 같은 화면을 소비한다. 새 라이브러리·API·DB·네이티브 셸 변경은 필요하지 않다.
- 기존 탭 종류, 높이, 글자 크기, 버튼·SelectBox·카드 토큰을 유지한다. 별도의 시안용 통계 Select 탭을 제품에 추가하지 않는다. 모바일 조작 영역은 기존 최소 44px를 유지한다.
- 정상 100% 글자 크기의 320×568/390×844/430×932에서 첫 진입 scroll0에 모니터링·수동 제어의 실제 도면, 통계 개요 비교 그래프·분석 순위가 보인다. 그래픽의 유효 표시 높이는 320에서 최소120px, 390/430에서 최소240px를 목표/검증 기준으로 한다. 큰 글자·오류·긴 이름은 자연 스크롤을 허용하며 잘라서 맞추지 않는다. 실제 현장 전체를 한 화면에 항상 넣는다는 보장은 아니다.
- 최근 알림은 세션 메모리에 최대50개 보관한다. 같은 상태 fingerprint polling은 새 알림이 아니며 새 상태·변경 내용·별도 작업 알림은 읽지 않음으로 표시한다. toast 종료는 최근 알림 읽음/삭제가 아니다. 읽음은 장애 해결·명령 실행·지우기가 아니다.
- 데이터 집계/API payload/명령 UUID/날짜·문서 취소 계약·최신 메인 알람 개인 지우기·모바일 iOS focus helper를 보존한다. 제품·소유 경계는 순차 작업하며 각 담당자는 다른 agent를 생성하지 않는다.

## Review Focus

1. 현장 A→B→A와 이전 async 완료: 알림·미읽음·제어 결과가 다른 scope에 유출되지 않는다(Task1/2).
2. 모바일 toast 억제/desktop 전환: 종료 타이머와 최근 알림 읽음은 별도이며 과거 toast가 다시 떠오르지 않는다(Task1).
3. 320×568/긴 이름: 고정 하단 메뉴가 도면 핵심 영역·버튼·상세 진입을 가리지 않고 자연 스크롤을 허용한다(Task2/3/4).
4. drawer 닫기/resize/전체보기: camera/선택과 명령 owner/원본 UUID 유지, 자동 refresh/제어 POST 없음(Task2).
5. 추정 데이터 null·partial·gap와 잘못된 날짜 초안: 0으로 치환하거나 유효한 조회처럼 표시하지 않는다(Task3).

## 실행 기록

- [x] 사용자 A안·기존 컨트롤 크기 유지·별도 브랜치 후 병합 승인(2026-10-06).
- [x] preview 기록 ce20af4e 보존 후 최신 메인 f74fc94f를 efd3820a에서 통합. 제품 충돌0, 메뉴 문서 충돌은 양쪽 scope별 기록을 보존.
- [x] Task1 Shell·알림·계정 구현/검토 — aba7a268 + cd0f44d0, full review C0/I1 후 scoped I1 ADDRESSED·새 C/I0.
- [ ] Task2 모니터링·제어 구현/검토.
- [ ] Task3 통계 구현/검토.
- [ ] Task4 최종 검증·디자이너·전체 코드 검토.
- [ ] 총괄이 최종 상태 문서·로컬 메인 병합과 병합 후 검증을 완료한다.

---

### Task 1: 공통 헤더·모바일 최근 알림

**Files:**
- Modify: `apps/web/src/features/shells/CustomerShell.tsx`, 해당 Shell tests, `CustomerHeaderSummarySlot.tsx`/test, `CustomerAccountPanel.tsx`/필요 회귀.
- Modify: `apps/web/src/components/ui/session-status/{SessionStatusProvider,SessionStatusCenter,ToastRegion}.tsx` 및 기존 session-status tests.
- Create if needed: 해당 공통 폴더의 순수 최근 알림 reducer/helper 및 의미있는 tests. 공통 export는 해당 기능만 연결한다.
- Test: 새 `apps/web/e2e/mobile-first-screen.spec.ts`의 공통 헤더·알림·설정 scope 시나리오(기존 fixture/support 재사용).
- Modify: `docs/menus/{monitoring,control,statistics,settings}.md`의 공통 UX 현황.

**Interfaces:**
- Consumes: 현재 `useSessionToast().publish/dismiss`, `useSessionStatus`, `useMonitoringIncidents`, guarded SiteContextControl, CustomerAccountContext, WorkspaceFocus.
- Produces: 기존 소비 API 호환을 유지한 최근 알림 상태/읽음 API; Shell compact 한 행과 전체보기 센터 접근. 추가 API 이름/타입을 report에 명시하며 Task2/3는 기존 Shell 레이아웃만 소비한다.

- [x] **Step1: baseline·변경 전 회귀 확인.** Web baseline63, 변경하지 않은 Mobile focus58 회귀. Node22/pnpm9.15/기존 준비된 의존성 사용, 명령·소스 시점은 task-1-report.md에 기록했다.
- [x] **Step2: 의미있는 실패 회귀 작성·RED 확인.** 새 recent tests2FAIL→GREEN. fingerprint/read/cap50/old callback와 기존 status/API 계약을 검증했다. 독립 gate가 실제 coverage를 확인한다.
- [x] **Step3: 구현.** aba7a268의 scoped history/provider-owned timer/compact header·집계 펼침·기존 eager 계정/단일 center 전체보기 접근을 구현했다. desktop와 서버 알람을 유지한다.
- [x] **Step4: 검증·문서.** 확장99(최종 sr-only 보완 전)·최종14·browser5·types/UI policy와 네 메뉴 문서를 보고했다. 전체 Web/Mobile·디자이너 최종 원본은 Task4다.
- [x] **Step5: scoped commit·self review·report.** aba7a268, task-1-report.md. 독립 full review와 cd0f44d0 fix1 scoped 재검토 승인. StrictMode RED1→GREEN42/typecheck, 실제 재발 의미 보존. 명령 remount 런타임은 Task2 필수 후속이다.

### Task 2: 모니터링·제어 도면 우선 배치

**Files:**
- Modify: `apps/web/src/features/monitoring/MonitoringView.tsx`, `MonitoringSummary.tsx`, 필요한 `FloorMap.tsx` 및 해당 tests.
- Modify: `apps/web/src/features/control/ControlView.tsx`, 필요한 `target-selection/{SpatialTargetSelector,TargetSelectionToolbar}.tsx`와 관련 tests.
- Create if needed: 기존 공통 `components/ui` 또는 해당 feature 내 재사용 가능한 presentation component. 공통 UI export는 한 담당자만 수정한다.
- Test: `apps/web/e2e/mobile-first-screen.spec.ts`, 기존 monitoring/control 관련 회귀.
- Modify: `docs/menus/{monitoring,control}.md`.

**Interfaces:**
- Consumes: Task1 compact Shell, 기존 map/selection/WorkspaceFocus/DetailSheet, 기존 command owner/복구 저장.
- Produces: 기존 기능/props 호환, 정상 첫 도면 우선 레이아웃; 실제 map의 bounds 측정을 위한 기존 data attribute 또는 의미있는 region.

- [ ] **Step1: 실패 재현·RED.** 3개 크기 scroll0 실제map/nav bounds를 비교해 명세 최소 가시성을 단언한다. 현장/맵 변경·카메라/선택·drawer 닫힘·명령 진행/불확정·원본 UUID 회귀를 현재 계약에서 정의한다. desktop 기준을 보존한다.
- [ ] **Step2: 구현.** selected-map 상태·도면 우선, 반복 현장 집계/검색/상세/실행 설정을 기존 펼침·drawer로 이동한다. 컨트롤 크기를 줄이지 않는다. 상태 owner는 계속 mounted이며 실행 중/unknown과 retry는 닫힌 상세 때문에 사라지지 않는다.
- [ ] **Step3: GREEN 검증.** focused units·3개 크기 가시성/터치/전체보기 및 관련 기존 monitoring/control browser 회귀를 실행한다. 레이아웃·drawer·resize로 command/refresh POST가 새로 발생하지 않는지 확인한다.
- [ ] **Step4: 메뉴 문서·scoped commit·self review·report.** 원본 로그/캡처/명령·결과·부분 노출/실장비 한계를 기록하고 총괄 review를 받는다.

### Task 3: 통계 그래프·순위·최근 리포트 우선

**Files:**
- Modify: `apps/web/src/features/statistics/{StatisticsShell,StatisticsOverviewPage}.tsx` 및 tests.
- Modify: `apps/web/src/features/statistics/analysis/{StatisticsAnalysisPage,EnergyRankingDetailPanel}.tsx`, `reports/StatisticsReportsPage.tsx` 및 필요한 기존 tests.
- Test: `apps/web/e2e/mobile-first-screen.spec.ts`, 해당 기존 statistics 흐름/표시 회귀.
- Modify: `docs/menus/statistics.md`.

**Interfaces:**
- Consumes: 기존 UnderlineNavigation·FilterPanel·DatePicker/DateRangePicker·scoped query·차트·report 목록/파일 계약, Task1 compact Shell.
- Produces: 개요 comparison/ranking/report action의 첫 화면 배치. 새 계산·필터 상태·탭 컴포넌트 API를 만들지 않는다.

- [ ] **Step1: RED·기존 계약 확인.** 기존 1열 KPI가 그래프를 미는 것을 3개 크기에서 단언하고 ranking 첫 행/리포트 첫파일 작업 접근을 확인한다. null/partial/gap와 invalid 날짜 초안·scope 변경 회귀는 실제 data contract로 확인한다.
- [ ] **Step2: 구현.** 핵심 요약을 기존 토큰으로 압축 배치하고 비교 그래프/순위/최근 리포트를 올린다. 상세 KPI/조건·히트맵/파일 작업은 모두 명시적으로 접근 가능하다. 기존 밑줄 탭/입력 크기와 API 의미·기간 범위를 유지한다.
- [ ] **Step3: GREEN 검증.** focused units/typecheck·3크기 첫graphic·desktop·날짜/filter/report 취소 관련 회귀를 실행한다. PDF/CSV 기능·null을 가짜 통과값으로 대체하지 않는다.
- [ ] **Step4: 메뉴 문서·scoped commit·self review·report.** 명령/결과와 소스가 맞는 원본 캡처, 데이터/파일/실장비 한계를 보고한다.

### Task 4: 최종 통합 검증과 인계

**Files:**
- Modify only if necessary: `apps/web/e2e/mobile-first-screen.spec.ts`의 통합 coverage/검증 코드와 해당 기능 최소 보완. 범위 확대 시 총괄에 알린다.
- Artifacts: 이 plan의 ignored SDD workspace에 최종 로그·캡처·검토 report.
- 총괄 소유: plan 체크리스트·`docs/project-status.md`, 최종 명세/문서 정합 및 로컬 병합.

**Interfaces:**
- Consumes: 앞 세 task 승인 commit·최종 소스/브라우저 fixture.
- Produces: 최종 Web test/typecheck/build/UI policy, Mobile 기존109회귀 등 현재 실제 suites, 3개모바일/desktop 캡처·클릭·가시성·독립 UI/코드 review 근거.

- [ ] **Step1: 최종 suite 한 번.** `pnpm workspace:prepare`, `pnpm --filter @led-control/web typecheck`, `pnpm --filter @led-control/web test`, `pnpm --filter @led-control/web build`, Web `test:ui-policy`/`ui:check`, Mobile `test`/`typecheck`를 순차 실행한다. unrelated Gateway/root timeout을 무작정 확장·반복하지 않는다.
- [ ] **Step2: 관련 Playwright·최종 캡처.** `mobile-first-screen.spec.ts`와 영향받는 Shell/monitoring/control/statistics/settings flows를 필요한 범위로 실행한다. mock API인지 native인지 증거를 구분한다. renderer/input/페이지 조작으로 만든 원본을 보존한다.
- [ ] **Step3: 디자이너 기존 채팅 검토.** 최종320/390/430 및 desktop 정상 원본·실제 기존 크기를 전달하고 확인된 지적을 같은 소유 담당자에게 최소 보완으로 반환한다.
- [ ] **Step4: report·필요한 검증 코드 scoped commit.** 전체 실행 결과·known warning/한계·자기 생성 자원 정리를 보고한다. 총괄 whole-branch 독립 review 후 로컬 메인 병합·병합 후 Web 검증을 수행한다.
