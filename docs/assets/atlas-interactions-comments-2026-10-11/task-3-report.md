# Task 3 — 공통 헤더·모니터링

- 시작 source: `195974a7` / branch `codex/atlas-interactions-comments-20261011`.
- 최종 scoped commit: `9ba48ee7ddd95b100c7349042b62530e5f367fb7` (`feat(web): unify monitoring fixture finder and canonical legend`), 13 owned files. commit exit 0; 이후 dirty는 root-owned 두 문서만 남음.
- C12: 현재 현장 label을 site.name만 표시. 권한/URL/logout guard, grid/truncate, 52px 계정 hit, short-mobile 여백 그대로.
- C19–21: desktop floor `compact:w-64`; 단일 조명 검색/목록 + 항상 표시되는 scroll 목록; 공통 Popover bottom-sheet opt-in; renderer 5상태 범례를 데이터 presence와 무관하게 표시.
- row 선택은 기존 camera/focusRequest/pin callback, 미배치/위치 불명 상세 경로를 재사용. 중복 상세 SelectBox·목록 collapse·initialView/defaultOpen 전용 상태 제거.

## 소유 파일

- `apps/web/src/features/shells/CustomerShell.tsx`, `CustomerShell.test.tsx`, `CustomerShell.monitoring.test.tsx`.
- `apps/web/src/features/monitoring/{MonitoringView,MonitoringFixtureFinder,FloorMap}.tsx`와 각각 `.test.tsx`.
- `docs/menus/{monitoring,control,statistics,settings}.md`.
- 직접 소비 Shell.monitoring 테스트도 제거된 SelectBox 대신 실제 row→pin→상세 경로로 수정. root-owned project-status/plan dirty는 보존하고 staging 제외.

## RED / GREEN 증거

모든 명령은 `PATH=/tmp/atlas-ui-fidelity-node22.xde1wS/bin:$PATH`와 `pnpm --filter @led-control/web exec vitest run` 사용. 다음 파일명은 `src/features/` 기준이며 tests only 실행.

1. RED: Shell/Finder/View/FloorMap `-t 'keeps mobile brand|single unified|opens the existing fixture list|canonical statuses' --reporter=dot`: exit 1, 4 FAIL/3 PASS. 처음 unified test가 describe 바깥에 있어 mock setup 실패도 섞임. describe 안으로 수정 후 Shell/View `-t 'keeps mobile brand|single unified'` exit 1, 4 FAIL/1 PASS. cached-site loading/error 기대값을 실제 context p로 정정; 실제 site-only/single-opener RED 확인. RED 출력은 실행 대화 기록에 남음.
2. 초기 직접 네 파일 전체: exit 1, 104 FAIL/87 PASS (`/tmp/atlas-task3-test.log`). 범례 presence 정리 중 renderer에 필요한 unobserved IDs도 제거한 구현 실수로 ReferenceError cascade. `observedFixtureIds`/`unobservedFixtureIds`를 원상 복구.
3. 같은 네 파일 직접 실행: exit 1, 184 PASS/7 FAIL (`/tmp/atlas-task3-test2.log`). Finder 8/FloorMap 15 PASS; Shell 61 PASS 및 sidebar 1 실패; View 이전 SelectBox/collapse test helpers와 focus 타이밍 기대 실패. Sidebar exact focused 재실행은 PASS; 원인은 확정하지 않았으며 제품 변경하지 않음.
4. Shell/View `-t 'collapses the wide sidebar|N1 preserves intentional|N1 never schedules stale focus|mobile fixture selector|prior floor search|long map name'`: exit 1, 5 PASS/4 FAIL (`/tmp/atlas-task3-test3.log`). row helper는 pin focus 완료를 기다려 재진입하도록 수정; map marker 재클릭은 filter를 해제하므로 사용하지 않음.
5. View `-t 'N1 preserves intentional|N1 never schedules stale focus|prior floor search'`: exit 0, 6 PASS (`/tmp/atlas-task3-test4.log`).
6. View 직접 파일 전체: exit 1, 106 PASS/1 FAIL (`/tmp/atlas-task3-final-monitoring.log`). 유일한 placement helper 실패: 기존 desktop aside 상세를 dialog로만 검사해 불필요 pin 대기. dialog/aside 양쪽을 인식하도록 정정.
7. Shell/FloorMap `-t 'keeps mobile brand|plain information|collapses the wide sidebar|canonical statuses'`: exit 0, 7 PASS. 수정된 site-only/5상태(all-offline 포함)와 sidebar 재검증.
8. Shell.monitoring/View `-t 'customer shell monitoring details|automatically removed by placement|selects a matched row'`: exit 1, 8 PASS/1 FAIL (`/tmp/atlas-task3-last.log`). Shell.monitoring 7와 matched row numeric search→pin 신규 1 PASS. placement는 새 단일 opener가 영구 header 버튼이어서 이전 disconnected 기대가 틀렸음.
9. View `-t 'automatically removed by placement'`: exit 0, 1 PASS (`/tmp/atlas-task3-placement.log`); placement의 영구 opener 기대만 정정. 통과된 전체 파일들을 반복 실행하지 않고 마지막 실패만 재검증.
10. `git diff --check`: exit 0.

## 자체 검토 / 한계

- useFloorFixtures cursor/next-page/partial-error/expectedTotal 안내 유지. 검색은 로드된 rows의 이름 문자열(그 안의 번호) 검색이며 서버 전체 검색/API number 필드를 추가하지 않음.
- snapshot-only unknown pin 식별 유지; renderer 5상태 정상/장애/오프라인/상태 확인 대기/조명 정보 확인 전을 항상 표시. camera/pin/detail ownership은 기존 그대로.
- API/DB/토큰/dependency/서버/HIL 변경 없음. Task2 manual gesture opt-in/모니터링 default 및 C8 운영 인사이트 미변경.
- bottom-sheet/층 선택 너비/5범례 footer의 실제 geometry·짧은 화면/중첩 select·최종 UI/type/build/review는 총괄·QA 후속 확인. 이 작업에서 브라우저나 whole-web suite/static gates는 실행하지 않음.
- 여러 단계의 실패와 helper 수정 기록을 분리 보존함. 단일 final whole-suite PASS로 포장하지 않고 마지막 직접 파일 결과 및 실패 case의 국소 GREEN을 기록함.
