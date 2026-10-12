### Task 1: 모니터링 C1–5

**실행 경계:** NEW worktree `.worktrees/map-workspace-comments-20261012`, NEW branch `codex/map-workspace-comments-20261012`, baseline f31e56fa. 운영 인사이트/통계/설정/API/DB/장비/다른 worktree/stash/원격/배포/기존 서비스는 변경하지 않는다. 기존 공통 UI/token을 재사용하고 공통 overlay가 두 소비자에 필요할 때만 최소 API를 추가하여 총괄에게 알린다. 실패 테스트 먼저 실행하고 직접 suite만 검증한다. 계획 전체가 아니라 이 task brief와 applicable AGENTS/skills만 읽는다.

**소유:** MonitoringView/FloorMap/직접 tests/docs/menus/monitoring.md. 필요 최소 common maps component/export/test만 이 담당 소유. FloorMapViewport 기본 정책·session provider 전역 변경은 먼저 보고한다.

**필수 문맥:** 위 공통 제약 전부 적용. 기존 `manual-cad` + `interactionPolicy="pan"` 소비. 순수 snapshot stale만 announce false. loading/error/main visible title 제거하되 h1 sr-only. floor/search/time/refresh 한 행, narrow icon-only44·time HH:mm/full accessible 설명. 기존 별도 aside/mobile modal을 지도 하단 비모달 약 절반으로 통일; map rect/camera/remount 불변, close/Escape/return focus/scroll 기억과 지도 interaction 유지.

1. 새 동작을 실제 컴포넌트로 관찰하는 실패 테스트를 먼저 작성·실행한다. snapshot 경계60000/60001·복구와 failure/invalid 안내, real marker gesture 및 single selection/no area, overlay lifecycle 중심. CSS geometry는 Task3 browser 관문이다.
2. 최소 제품 구현, 직접 suite GREEN. 프레임워크나 mock 존재 assertion 대신 소비자 동작 검증.
3. 공통 overlay 추가 시 최소 API/경로/기본값·Task2 소비 방법을 보고한다. 기존 공통 Card/Button 재사용으로 충분하면 불필요 API를 만들지 않는다.
4. 메뉴 문서 다섯 구성 유지·mock/HIL 한계 기록, diffcheck, 자기 리뷰·소유 파일만 source commit.
5. task-1-report.md에 base/source SHA·변경 파일·원 RED/GREEN 로그·검증된 동작/누락/경계 API를 기록한다. 총괄 plan/status 수정 금지, 다른 writer 호출 금지.

**검증:** 직접 Monitoring/FloorMap 및 필요한 공통 overlay suites만. 원 로그는 이 작업 SDD workspace. 제품 구현 후 Task2에 source checkpoint 전달.

