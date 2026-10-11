# Task 14 결과 — 제어 의견 반영

기준 checkout: `.worktrees/atlas-browser-comments-20261011`, branch `codex/atlas-browser-comments-20261011`. 시작 HEAD `773a5399`; 선행 공통 DataGrid 계약 `aba951f7` 소비. 단독 제품 writer로 Task14 소유 파일만 수정했다.

## 변경

- 중앙 기존 `inspectionPanel`에 `section aria-label="선택 대상 목록"`, `list aria-label="선택 조명"`, 우상단 `선택 해제`를 배치했다. 개별 선택에서도 `data-target-selection-detail-panel`과 16rem 상세 열을 유지한다. 오른쪽 `밝기 실행` 내 중복 list/clear는 제거하고 단일 선택 수 live announcement와 실행 badge를 유지한다.
- `밝기 초안`은 `밝기`로 표시한다. raw draft/empty·decimal·range/blur·Enter/same-click Apply·선택·오프라인·UUID·ACK·복구 상태와 handler는 변경하지 않았다.
- 스케줄 중복 제목줄은 제거하고 유일한 생성 CTA/ref를 기존 `AutomationRuleControls.actions`로 이동했다. global 계약 부재에는 같은 `스케줄 목록 조건` region에 생성 CTA를 노출해 ref/focus를 유지한다. viewer 조회 전용 상태 유지.
- 활성 표시/정렬 accessor는 enabled만 사용하며 기간의 시간대 caption만 제거했다. 실제 시간 변환과 Dialog 안내 유지. 이름 left/나머지 center를 명시해 선행 공통 DataGrid 계약을 소비한다.
- 이벤트 소제목·제어 ATLAS를 제거하고 이벤트 생성 CTA/ref·조회 전용 badge 유지.
- 그룹 Gateway 열·Mesh 버전/주소 안내 제거, ready는 준비됨 badge 표시. 비정상 사유·오류·재동기화 및 실제 권한/잠금/UUID 경로는 유지. 이름 left/나머지 center.

## 검증과 실패

모든 명령은 `PATH='/tmp/atlas-ui-fidelity-node22.xde1wS/bin':$PATH`를 사용했다.

1. RED: `pnpm --filter @led-control/web test src/features/control/ControlView.test.tsx src/features/control/ManualExecutionPanel.test.tsx src/features/control/automation/ScheduleControlPanel.test.tsx src/features/control/automation/VehicleEventControlPanel.test.tsx src/features/control/groups/FixtureGroupsPanel.test.tsx -t 'fidelity|list toolbar|duplicate panel heading|only the ready badge|places full names'` → exit1, 실제 pnpm forwarding은 `-t`를 전달하지 않아 5 suites 전체 실행, 338개 중 9 FAIL/329 PASS. 실패는 기존 ATLAS, 중앙 목록 없음, 초안, Gateway/ready metadata, 스케줄 sync/시간대 및 중복 소제목 계약이었다. 잘못된 필터 전달은 감추지 않으며 이 실행을 focused 일부만 실행한 것으로 보고하지 않는다.
2. GREEN: `pnpm --filter @led-control/web exec vitest run src/features/control/ControlView.test.tsx src/features/control/ManualExecutionPanel.test.tsx src/features/control/automation/ScheduleControlPanel.test.tsx src/features/control/automation/VehicleEventControlPanel.test.tsx src/features/control/groups/FixtureGroupsPanel.test.tsx src/features/control/target-selection/SpatialTargetSelector.test.tsx src/features/control/automation/components/AutomationRuleControls.test.tsx` → exit0, 7 suites/373 PASS, 43.14초. ControlView162/Manual8/Schedule83/Event77/Groups8/Spatial32/Controls3. GREEN 추가 실패·재실행0.
3. `git diff --check` → exit0. 문서·staged diff 확인은 commit 직전 추가 확인.

## 소유 파일 / commit

- 제품7: ControlView, ManualExecutionPanel, SpatialTargetSelector, ScheduleControlPanel, VehicleEventControlPanel, AutomationRuleControls, FixtureGroupsContent.
- 직접 테스트5: ControlView, ManualExecutionPanel, ScheduleControlPanel, VehicleEventControlPanel, FixtureGroupsPanel.
- 문서: `docs/menus/control.md`.
- scoped commit `d3010fc708b4b0a1bc4e888eb4c101cee6835e9d`은 명시 13파일만 stage했다. `git diff --cached --check`와 commit은 exit0이다. QA의 `apps/web/e2e/atlas-ui-fidelity.spec.ts`와 계획·상태·공통·통계·DB는 stage/수정하지 않았다. commit 뒤 남은 tracked 변경은 QA 소유 E2E 한 파일뿐이다.

## 한계

전체/type/UI/build/browser/HIL은0이며 root/QA 최종 묶음으로 남긴다. 새로운 drawer/detail 없이 요청된 metadata를 숨겼다. 스케줄 sync 필터·오류 알림·최근 결과는 유지한다. 화면 실제 geometry/양 테마/mobile evidence는 이번 단위시험의 범위가 아니다. 메뉴 문서와 제품은 같은 scoped commit에 포함한다.
