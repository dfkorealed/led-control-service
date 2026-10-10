# Task 3 고객 shell·제목·탭 결과

상태: 완료. S1–S4/S13 공통 소비 교정. root 계획/ledger/project-status는 stage하지 않았다.

commit: `de336545243097a189ac4265f45c7c9bfce1c3ee`.

## 변경 및 불변

- desktop 현장-left/실제 네 summary-center/기존 상태·테마·security Link-right 한 행. mobile logo/select 첫 행+summary 둘째 행, 360 미만 logo 및 compact selector 분기는 유지한다. shell-current-menu는 sr-only span이며 visible route h1은 본문 소유다.
- summary는 값 위 caption,0/null·scope 일치·실제 상태 tone을 유지한다. expanded sidebar inset18/item48/logo gap28/soft active; rail80/큰 hit 유지. sidebar 표현 소유자 SettingsNavigationItem은 계획 파일 외 필요한 좁은 소비 수정으로 포함했다.
- compact account strip은 eager 계정 context를 계속 소비하고 requestLogout/ref·실패 포커스·작업 차단을 유지한다. desktop Link는 기존 settings/security와 현재 search/hash를 사용한다. 신규 API/query/context 없음.
- SettingsSection.pageTitle 추가. capability-filtered 정확 여섯 목록 경로를 trailing slash 정규화 후 매칭한다. Shell h1→desktop tabs→원본 child toolbar; mobile tabs 숨김/return 유지. 여섯 child 중복 제목만 제거하고 설명/동작/상세 editor 제목은 유지한다.
- monitoring h1/갱신은 지도 앞에, control 조명 제어 h1→tabs, statistics tabs→각 경로 h1. monitoring safe-navigation clearance는 기존 마지막 refresh row에서 screen으로 이동하여 새 refresh 순서에도 보존한다. 공통 customer tab recipe만 적용하며 keyboard/URL/권한·카메라/선택/작업 owner는 변경하지 않는다.
- 네 메뉴 문서의 다섯 필수 항목 및 후속 한계를 갱신했다. palette/token/root/base/cn/API/DB/실장비/서버 불변.

## 검증

Node22.20.0/pnpm9.15.0 task runtime `PATH="/tmp/atlas-ui-fidelity-node22.xde1wS/bin:$PATH"` 재사용. 설치 재실행/lock 변경 없음.

- RED: `pnpm --filter @led-control/web exec vitest run src/features/settings/SettingsShell.test.tsx src/features/shells/CustomerHeaderSummarySlot.test.tsx src/features/shells/CustomerShell.test.tsx -t 'owns one h1|does not claim|four captioned|sole h1'` → exit1,8FAIL/1PASS/77filtered SKIP(86),2.63초, task-3-red.log. 신규 제목/배치 미구현의 예상 실패였다.
- GREEN 명령: `pnpm --filter @led-control/web exec vitest run src/features/shells/CustomerShell.test.tsx src/features/shells/CustomerHeaderSummarySlot.test.tsx src/features/control/automation/ControlModeTabs.test.tsx src/features/settings/SettingsShell.test.tsx`.
- 첫 GREEN exit1,87PASS/1FAIL/0SKIP. 새 테스트 `/settings`의 wildcard child는 index에서 렌더되지 않아 원본 동작 fixture가 없었다. 제품 수정 없이 index fixture를 추가했다. task-3-green.log 보존.
- 최종 GREEN exit0,4files/88PASS/0FAIL/0SKIP,5.27초. eager 계정·로그아웃 실패/차단·site switch·기존 탭 keyboard/URL·default 계약을 포함한다. task-3-green-final.log. warning 없음. git diff --check exit0.
- whole Web/type/UI/build/browser/E2E/Lab/canonical/HIL 미실행. mobile320/390/562·759/760/dark 실제 geometry는 Task11 한 번에 확인한다.

## concerns

- 단위 DOM/class 계약을 실제 화면 시각 일치로 확대하지 않는다. 상세 메뉴 표현은 Tasks5–10 범위다.
- SettingsShell을 제외한 child direct mount는 제목 소유 구조를 반영해 후속 소비 테스트에서 확인한다. 등록 embedded header 표현은 Task8 범위로 남는다.
