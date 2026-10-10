# Task 2 eyebrow 공통 후속 결과

상태: 구현·집중 검증 완료. BASE `dffb619afdbb0d23a8e4a6c1741feb1267f160e4`에서 시작한 단독 product writer 변경이다.

commit: `121cd2773e59759cc37ec03e60abcfc4a6308226` (15files/136insertions/16deletions).
커밋 뒤 담당 product/tests/menus 파일은 clean이고 총괄 소유 `docs/project-status.md`, `docs/superpowers/plans/2026-10-10-atlas-ui-fidelity.md` 두 unstaged 변경만 남았다. 두 파일은 commit에 포함하지 않았다.

## 요구 근거·공개 API·변경 범위

- canonical audit `audit-2026-10-10/monitoring.md` 행1/2/후속1 및 `common.md:69`의 optional eyebrow 계약을 확인했다. mock `atlas-operations.js:64`는 ATLAS / OPERATIONS, `atlas-insights.js:56,86,99,107`은 ENERGY INTELLIGENCE이며 settingsHead:59는 빈 eyebrow다. 각 실제 원문을 소비하며 통계까지 운영 문구로 합치지 않았다.
- `PageHeaderProps.eyebrow?: ReactNode` 하나를 추가하고 non-null slot을 기존 Typography Text overline/secondary로 h1 위에 렌더한다. ReactNode0도 표시한다. omitted default와 ref/ARIA/headingLevel/description/status/actions 동작은 유지하며 eyebrow를 DOM attribute로 전달하지 않는다.
- 운영 mock은10px/bold/.14em/secondary/아래8px, 통계는11px/bold/.16em/accent다. 새 token 없이 기존 overline11px/16px leading·bold·상속 자간·내부 gap2(8px)를 재사용한다. 통계의 slot inline span은 기존 text-action-primary만 전달하며 모든 eyebrow 배치·타이포·margin owner는 공통 PageHeader다. 페이지별 header wrapper는 복제하지 않는다. mock의 exact10px/.14/.16 자간과 같다고 주장하지 않는다.
- source6파일: components/ui/PageHeader.tsx; monitoring/MonitoringView.tsx; control/ControlView.tsx; statistics/StatisticsOverviewPage.tsx; statistics/analysis/StatisticsAnalysisPage.tsx; statistics/reports/StatisticsReportsPage.tsx.
- monitoring main·loading/error·installation pending에 연결한다. loading/error는 원본 FeedbackState/retry handler 앞에 동일 PageHeader를 배치한다. control은 기존 modeTabs의 PageHeader 하나로 모든 manual/다른mode/loading/error/no-data를 소비한다. overview/analysis는 같은 pageHeader element를 main/loading/error에서 재사용하고 reports는 항상 렌더되는 기존 PageHeader가 history loading/error를 계속 소유한다.
- test6파일: CustomerPresentation.test.tsx 및 위5 메뉴 소비자의 기존 .test.tsx. 공통 case1개와 monitoring loading/error2개 추가, 기존 단일h1·CTA·manualhierarchy·ranking·CSV진입 case의 직접 표현 assertion 보완.
- docs/menus/{monitoring,control,statistics}.md는 동일 변경에 갱신하고 예전 eyebrow 대기 문장을 당시 이력으로 명확히 했다. 설정·root plan/status/progress·token/registry/policy/dependency/API/backend·DB·서버·실장비 불변이다.

## RED/GREEN 실제 증거

모든 명령은 worktree cwd와 `PATH="/tmp/atlas-ui-fidelity-node22.xde1wS/bin:$PATH"` Node22.20.0/pnpm9.15.0을 사용했다. install/prepare 재실행 없음.

- 공통 RED: `pnpm --filter @led-control/web exec vitest run src/components/ui/CustomerPresentation.test.tsx -t "optional eyebrow"` → exit1,1FAIL/0PASS/8filtered SKIP(9),2.11초. 실제 eyebrow 미렌더 예상 실패, task-2-eyebrow-red.log.
- 소비자 RED: `pnpm --filter @led-control/web exec vitest run src/features/monitoring/MonitoringView.test.tsx src/features/control/ControlView.test.tsx src/features/statistics/StatisticsOverviewPage.test.tsx src/features/statistics/analysis/StatisticsAnalysisPage.test.tsx src/features/statistics/reports/StatisticsReportsPage.test.tsx -t "monitoring eyebrow|single monitoring h1|calm operations hierarchy|single overview page heading|shows ranked usage|from CSV entry"` → exit1,8FAIL/0PASS/398filtered SKIP(406),3.59초. monitoring loading/error의 h1 부재2, main 모바일/desktop eyebrow 부재2, control/overview/analysis/reports eyebrow 부재각1. import/fixture 오류 아님. task-2-eyebrow-consumer-red.log.
- 공통 GREEN: `pnpm --filter @led-control/web exec vitest run src/components/ui/CustomerPresentation.test.tsx src/components/ui/Typography.test.tsx` → exit0,2files/33PASS/0FAIL/0SKIP,3.11초. task-2-eyebrow-green.log. omitted default·ref/ARIA·heading/actions·ReactNode0와 기존 Typography 소비를 확인했다.
- 소비자 GREEN: RED와 동일5파일 및 `-t "monitoring eyebrow|single monitoring h1|calm operations hierarchy|single overview page heading|shows ranked usage|from CSV entry|reports loading and mismatched site|retries summary errors"` → exit0,5files/10PASS/0FAIL/396filtered SKIP(406),3.36초. task-2-eyebrow-consumer-green.log. 직접 관련 원본 loading/site/summaryretry2를 추가로 선택했다. 관측 명령 전송·보고서 생성/다운로드·CTA routing owner를 변경하지 않는다.
- RED8와 소비자GREEN10은 선택 수가 다르며 단위 결과를 합산하거나396 비선택을 PASS/환경skip으로 기록하지 않는다. 테스트의 예상 밖 실패/fixture 수리/경고는 없다. 최종 소스 점검에서 초기 tracking-widest가 ui-policy.mjs:480의 unapproved-typography 금지 utility임을 발견했다. 기존 policy를 확장하지 않고 클래스 하나를 제거해 상속 자간을 유지했다.
- 단일 PageHeader 소스의 기존 `inspectUiSource` 함수를 Node로 호출한 최소 재현: `node --input-type=module -e 'import { readFileSync } from "node:fs"; import { inspectUiSource } from "./apps/web/scripts/ui-policy.mjs"; const p="src/components/ui/PageHeader.tsx"; const r=inspectUiSource(p,readFileSync("apps/web/"+p,"utf8")); console.log(JSON.stringify(r)); if(r.length) process.exitCode=1;'` → 초기 exit1/unapproved-typography tracking-widest1개(task-2-eyebrow-policy-red.log), 클래스 제거 후 exit0/[](task-2-eyebrow-policy-green.log). full UI/전체 policy 실행이 아니다.
- 클래스 제거 후 공통 GREEN 명령을 같은2파일로 다시 실행했다: exit0,2files/33PASS/0FAIL/0SKIP,1.95초(task-2-eyebrow-final-green.log). 소비자 source/handlers/assertions는 이전 GREEN 뒤 불변이며 전체 소비자 재실행으로 확대하지 않는다. GREEN 로그 warning/stderr/FAIL0. `git diff --check` exit0.
- 전체 Web/type/UI/build/browser/E2E/583/Lab/canonical/HIL 미실행. Task11의 통합 검증을 반복하지 않았다. class/DOM 증거는 실제 bounds/dark 대비·전체 제품 회귀나 HIL 증거가 아니다.

## 인계 한계

- exact mock 자간은 승인 generic tracking token이 없고 기본 tracking utility가 정책상 금지되어 상속을 유지한다. 10px은 기존11px scale로 근사했다. 실제 좁은 header 높이·longtitle/refresh/actions wrap·dark/portal은 Task11에서 확인한다.
- eyebrow 없는 SettingsShell과 public/operator는 기존 단순형 그대로다. 의존성·runtime 설정/사용자 기본 Node24/global pnpm은 바꾸지 않았다.
