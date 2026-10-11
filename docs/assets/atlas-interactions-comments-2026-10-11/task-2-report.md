# Task 2 결과 — C13–16 수동 지도·툴바

- 제품 source/commit: `195974a77a4bd9ce8d8d35248cb0f607762decb0` (기준 `16b6c032`). 같은 checkout의 총괄 소유 상태판·계획 dirty 2개는 보존하고 커밋하지 않았다.
- 변경 10파일: `apps/web/src/features/floor-map/{FloorMapViewport.tsx,FloorMapViewport.test.tsx,FloorScene.test.tsx}`, `features/control/{ControlView.tsx,ControlView.test.tsx}`, `features/control/target-selection/{SpatialTargetSelector.tsx,SpatialTargetSelector.test.tsx,TargetSelectionToolbar.tsx,TargetSelectionToolbar.test.tsx}`, `docs/menus/control.md`.
- C13: 기존 중앙 inspection slot에 themed panel 배경/둥근 테두리/inset 적용. 선택 이름/선택 해제·목록 owner 유지.
- C14: manual-workspace만 `toolModePolicy="manual-cad"`. 중간 버튼/Space drag pan, 왼쪽 drag area, touch swipe pan/no long-hold area. 8px 기준은 client 좌표다. marker는 threshold 뒤에만 capture하여 native pointerup tap을 유지하고 FloorScene의 기존 drag/second-pointer/cancel 억제를 소비한다. Space는 부모 capture-down에서 marker press 생성 전 처리한다. keyboard/detail=0 보존. 잠금/aggregate는 left selection 금지, middle/Space/touch/pinch navigation 가능.
- C15: 층+조명 목록 한 행, scope 탭 유지. manual 관리/현황 button·Dialog·전용 state/ref/reset setter 제거. embedded 목록명/관리 action·disclosure는 유지한다.
- C16: 모든 control mode/loading/error의 기존 단일 제목 owner를 sr-only h1으로 바꿨다.
- `FloorScene.tsx` 제품/monitoring/editor/default direct-selection은 무수정이며 새 공유 flag나 dependency/API/DB/hardware 변경은 없다. 기존 240px/scroll/camera/coordinate transform/wheel zoom/clamp/resize lifetime·명시 Apply·UUID/ACK/recovery owner는 유지한다. C8 제외 유지.

## 실행 증거

모든 runtime 명령은 `PATH=/tmp/atlas-ui-fidelity-node22.xde1wS/bin:$PATH` (Node v22.20.0)로 격리 checkout에서 실행했다.

1. 최초 지도 RED: `pnpm --filter @led-control/web test src/features/floor-map/FloorMapViewport.test.tsx -t manual-cad` exit1. pnpm script가 -t를 소비해 실제 전체 해당 파일 38개 실행: 새4 FAIL/기존34 PASS. 실패 원인은 marker touch/middle scroll0, touch700ms hold area 발생, left-marker8px area 없음이다.
2. 지도 최소 GREEN: `pnpm --filter @led-control/web exec vitest run src/features/floor-map/FloorMapViewport.test.tsx` exit0, 38/38.
3. UI RED: `pnpm --filter @led-control/web exec vitest run src/features/control/target-selection/TargetSelectionToolbar.test.tsx src/features/control/target-selection/SpatialTargetSelector.test.tsx src/features/control/ControlView.test.tsx -t 'manual fixture selection|manual navigation|fidelity reads|atlas execution|saved-zone scope'` exit1, 5 FAIL/1 PASS/189 비선택. 삭제 예정 tool/관리 button·새 목록 접근 이름의 기존 계약을 확인했다.
4. 직접5suite 중간 실행: 162 FAIL/128 PASS. 원인은 제거된 Dialog state의 reset setter 두 군데 잔여 참조였다. 제거 후 다음 동일 범위는 2 FAIL/293 PASS(기존 tool 기대 2개). 새 navigation/즉시 밝기 표현 계약으로 갱신했다. 원 실패를 최종 PASS에 합산하지 않는다.
5. ControlView162/162 exit0. raw31 입력→선택해제 후31 유지/noPOST, uncertain command 중 middle navigation/테마/resize 후 frozen UUID 및 POST1 유지도 실제 소비자에서 확인했다.
6. 최종 동일 제품 source 5suite: `pnpm --filter @led-control/web exec vitest run src/features/floor-map/FloorMapViewport.test.tsx src/features/floor-map/FloorScene.test.tsx src/features/control/target-selection/TargetSelectionToolbar.test.tsx src/features/control/target-selection/SpatialTargetSelector.test.tsx src/features/control/ControlView.test.tsx` exit0, 295 PASS/0 FAIL/0 SKIP (23:36:09 시작, 23.28초). 파일별43/57/1/32/162. 이후 제품 변경 없음; 문서만 추가했다.
7. `git diff --check` exit0. 소유10파일만 commit했고 root-owned dirty2개는 그대로다.

## QA 전달·한계

- 새 실제 FloorScene+Viewport 조합 tests는 marker touch/middle 시작 pan/no pointerup false toggle/다음 tap, stationary Space no toggle/다음 tap/keyboard를 확인한다. Viewport tests는7/8px·좌표 변환·700ms hold noarea·cancel/lostcapture/blur/Escape·pinch/lock/Space, 기존 정책 suite를 확인한다.
- 단위 DOM은 실제 browser capture/scroll bounds/양 테마/320·short desktop geometry를 증명하지 않는다. 승인 LEAN대로 전체 Web·타입·UI정책·build·browser/실장비는 미실행, 총괄 QA가 최종 관문을 소유한다.
- QA/E2E에서 manual opener는 `조명 목록`, embedded opener는 `조명 목록 열기`다. PC middle/wheel/left marquee 및 touch marker-start swipe/tap/long-hold/pinch 두 사례와 central panel·층+목록 row·short viewport·추가POST0를 확인한다.
