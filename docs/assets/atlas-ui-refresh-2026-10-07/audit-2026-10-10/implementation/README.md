# 교정 구현·검증 보존 자료

2026-10-10 공통·모니터링·제어·통계·설정 담당과 독립 최종 code/UI·UX 담당의 결과를 총괄이 취합했다. [처리 대응표](../README.md), [실행 체크리스트](../../../../superpowers/plans/2026-10-10-atlas-ui-fidelity.md), [원본 목업](../../mockup/)이 각각 감사/실행/디자인 기준이다. 이 폴더의 담당 보고서는 최초 실패와 후속 결과를 포함한 원문 그대로 보존한다. 문서 상단의 초기 대기/실패 상태를 마지막 재확인 결과와 구분한다.

원 로그는 byte 내용을 수정하지 않고 결정적 gzip으로 보존했다. 아래 및 담당 보고서의 `*.log`는 이 폴더의 같은 이름 `*.log.gz`에 대응한다(`gzip -dc 파일.log.gz`로 원문 조회). 출력 자체의 공백·ANSI·경고·실패를 formatting하지 않았다. ignored scratch의 원 로그도 유지한다.

## 검증 source와 결과

- 출발점: `b1dd36eed1e9dd41663d17cdf94379360e539fb4`.
- 최종 제품 source: `0bba6fe16c89b5681c4d96050513ba7145bddcdd`(타입 test 수리 `1c4943a6`, 설정 수리 `da9edfee` 포함). 이후 `eef83fa3a8172efe2130df25661c163edbce7b02`까지 E2E spec만 변경했다. 마지막 기록 commit은 문서·보존 증거만 바꾼다.
- 최종 `typecheck`, `test:ui-policy`, `ui:check`, `build` 모두 exit0. 정책79 PASS/0 FAIL/0 SKIP, UI 위반 existing0/new0, Vite4696 modules/8.74초. CSS AST738개/unique738, 기존734값 보존/신규4; 승인 anchor `e841c57b`, baseline files `{}`. [정적 원문 및 최초 실패](task-11-static-validation-report.md), 동명 원본 `task-11-static-{command}.log`와 최종 `task-11-static-final-{command}.log`를 보존한다.
- 기존 main chunk930.29KB/gzip280.26KB의 500KB 초과 경고는 남는다. 오류나 성능 검증 PASS로 바꿔 쓰지 않는다.
- 브라우저 최초12는8 PASS/4 FAIL. 실패한 원 사례와 잘못된 증거 harness만 재확인: 총6회/27 case 실행이며 전체12 재실행은 없다. 마지막 PC/dark/open-dialog 국소3은3 PASS/0 FAIL/0 SKIP, exit0/16.8초. 최종 열린 실패는 없지만 **서로 다른 source의12 고유 사례 증거**이며 최종 HEAD 전체12 단일 run PASS가 아니다. [정확 run·수리·source·한계](task-11-browser-report.md), `task-11-browser-{first,focused,manual,final,ready,ready-final}.log` 참조.
- 단위 시험의 담당별 실제 범위·RED/중간 실패/필터 제외는 각 Task 보고서를 따른다. 전체 Web/583/Lab/canonical/HIL 미실행. 실제 계정/비밀번호/장비 변경, API/DB/schema/Gateway/펌웨어 변경0. Controlled API/task port15185만 사용했으며 사용자5173/4000/원목업63200은 검증 서버로 사용하지 않았다.

## 최종 리뷰

- [Code review](task-11-code-review.md): 한 독립 reviewer의 NET diff 검토와 같은 seat 국소 재검토. 비밀번호 요청/세션 refresh 동안 Dialog dismiss 차단 및 잘못된 typography utility의 두 P2를 해결했고 신규 중요 문제0, ready to merge YES.
- [UI/UX review](task-11-uiux-review.md): 원본과 대표 실제16장 및 최종 설정 수리 source에 대해 APPROVED, 새 P2 이상0. 전체138 상호작용·모든 pixel/권한/기기의 승인은 아니다.
- 원본의 가상 parking/CAD/숫자/명령 시나리오 대신 실제 renderer·query·UUID·권한·명시 Apply·draft·복구·null/0·MFA/lease owner를 유지했다. 신규 기능의 API를 목업에 맞추어 조작하지 않는다.

## 로컬 통합

- 기본 `codex/mvp1-cloud-web`이 clean/기준 `b1dd36ee`인 것을 새로 확인하고 `git merge --ff-only codex/atlas-ui-fidelity-20261010`을 실행했다. exit0, 실제 첫 FF HEAD `b8c545168be5e66ae3cb249cfe6dd6b4a5bc2e53`, 기본/correction HEAD 일치·clean을 확인했다. `0bba6fe1` 이후 제품 `apps/web/src`/`packages` diff0이므로 전체 검증을 반복하지 않는다. 이후 closeout commit은 문서만 변경한다.
- 기존 stash `eecf13ef` 등과 다른 worktree/실서비스5173·4000은 유지했다. 원목업63200도 열어 두었다. 원격 push/PR/배포/실장비 변경은 하지 않았다.
- 이번 페이지용4 worktree/merged branch는 정리했다. 통합 worktree도 최종 완료 기록 FF 확인 후 정리한다. 필요한 ignored `.superpowers`5묶음과 monitoring `test-results`는 기본 checkout의 `.superpowers/sdd/atlas-fidelity-backup-20261010.GvemD0/`에 복사 보존했다. tracked 구현·원문 보고·최종 이미지/압축 로그는 Git에서 복구할 수 있다. unrelated worktree 정리·force 삭제·전체 prune는 하지 않았다.

## 보존 화면

모든 실제 PNG는 재가공하지 않은 Playwright 화면이며 같은 이름의 `-metrics.json`에 URL/viewport가 있다. 아래16장만 최종 UI/UX 승인 자료다.

| 범위 | 보존 PNG | viewport |
| --- | --- | --- |
| PC light 4메뉴 | [모니터링](screenshots/pc-monitoring.png), [제어](screenshots/pc-control.png), [통계](screenshots/pc-statistics.png), [설정](screenshots/pc-settings.png) | 1440×900 |
| Dark 4메뉴 | [모니터링](screenshots/dark-monitoring.png), [제어](screenshots/dark-control.png), [통계](screenshots/dark-statistics.png), [설정](screenshots/dark-settings.png) | 1440×900 |
| Dark portal 2개 | [현장 선택](screenshots/dark-site-portal.png), [알림](screenshots/dark-alarm-portal.png) | 1440×900 |
| 열린 설정 Dialog 2개 | [현장 편집](screenshots/settings-site-edit-open.png), [비밀번호](screenshots/settings-password-dialog-open.png) | 1440×900 |
| 도면 gallery | [실제 readonly snapshot](screenshots/gallery-real-snapshot.png) | 1024×768 |
| Mobile | [로고·compact select·모니터링](screenshots/responsive-562-monitoring.png) | 562×844 |
| Finder | [공유 검색/목록 상태](screenshots/finder-shared-state.png) | 390×844 |
| 짧은 manual | [내부 recovery scroll](screenshots/short-manual-recovery.png) | 1024×600 |

원본 대표 캡처도 별도로 보존했다: [PC 모니터링](screenshots/mock-monitoring-pc.jpg), [수동 제어](screenshots/mock-manual-pc.jpg), [통계](screenshots/mock-statistics-pc.jpg), [설정](screenshots/mock-settings-pc.jpg)(1304×1229), [mobile light](screenshots/mock-monitoring-562-light.jpg) / [dark](screenshots/mock-monitoring-562-dark.jpg)(562×1229). 실제562×844와 원본562×1229를 동일 높이 비교로 주장하지 않는다. 모바일 로고·128/144px select는 원본 이후 사용자가 승인한 변경이다.

## 남는 증거 한계

- 초기 PASS로 표시됐어도 floorless/placeholder PC·dark 캡처는 최종 승인에서 제외했다. 위 실제 ready 조건 이후 화면만 채택한다. 잘못 이름 붙은 옛 `mock-monitoring-mobile.jpg`도 제외했다.
- monitoring 지도 집계 `—`/ticker 오류 및 알림 오류는 해당 fixture의 미제공 데이터 상태다. 정상 범례/집계/ticker 모두의 pixel 증거가 아니며 해당 source/unit 보존과 구분한다. manual 범례+camera footer는 실제로 촬영했다.
- mobile320/390/759/760 및 통계0/gap은 최초 PASS 증거가 있으나 당시 임시 PNG가 삭제됐다. 전체 모바일 PNG 행렬이나 전체 대비 계산을 주장하지 않는다.
- gallery는 실제 configured1층 snapshot fixture다. 최대2 ceiling/DOM disconnect는 browser,3개 이상 offscreen/resource fanout은 unit 근거이며 대형 CAD/GPU 성능을 검증하지 않았다.
- 열린 password Dialog browser 사례는 실제 credential 제출을 하지 않았다. 요청 중 dismiss/성공·실패·세션 refresh는 별도 보안38개 unit 증거다. 원목업 예시와 다른 실제 도형/숫자는 결함으로 제거하지 않는다.
- eyebrow의 기존11px overline/상속 자간은 승인된 nearest-token 근사다. 모든 상세 route·숨겨진 하단·권한별 분기·실장비·native OS·전체 브라우저/성능 검증은 범위 밖이다.
