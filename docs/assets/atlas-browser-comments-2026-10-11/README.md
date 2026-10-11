# 2026-10-11 브라우저 주석 교정·한정 검증

기준 `d8dbfcd1`, 격리 `codex/atlas-browser-comments-20261011`, 병합 대상 `codex/mvp1-cloud-web`. 모니터링/공통·제어·통계 담당이 구현하고 UI 검증 담당과 독립 최종 리뷰 담당이 협업했다. 최종 제품 source `b70f037f`, 최종 테스트 source `18f5a0eb`. 사용자 요청 로컬 FF를 완료했고 원격 push/PR/배포는 없다.

## 29개 주석 대응

| 주석 | 반영 내용 | 구현 |
| --- | --- | --- |
| 2, 4, 19 | 현장 선택·전환 전용 코드 제거, 현재 현장 일반 텍스트, PC 집계 일정 간격/모바일 네 동일 폭 셀 | `aba951f7` |
| 1, 3, 27, 28, 29 | 모바일 지도 남은 공간 확장, ATLAS·보이는 지도 제목 제거, 짧은 화면 자연 스크롤 | `aba951f7`, `4802b641` |
| 5, 6, 7, 8 | 개별 조명도 중앙 선택 목록, 오른쪽 chips 제거, 밝기 초안 문구 제거, 선택 해제 우상단 | `d3010fc7` |
| 9, 10, 11, 12 | 기간 시간대 caption 제거, 활성만 표시/정렬, 이름 외 가운데, 중복 제목줄 제거·추가 CTA를 툴바로 이동 | `d3010fc7` |
| 13, 18 | 이벤트 소제목·제어 ATLAS 제거, 생성 진입/조회 전용 상태 유지 | `d3010fc7` |
| 14, 15, 16, 17 | 그룹 Gateway 열·ready 부가 문구 제거, 준비됨 badge만 표시, 이름 외 가운데 | `d3010fc7` |
| 20, 21, 22, 23, 24, 25, 26 | 통계 ENERGY 제거, 개요 표시 제목/상단 CTA 제거, 보고서 공통 검색·필터·초기화·CSV, 목록 시간대 caption 제거 | `e9d72b91` |

현재 customer admin/viewer 최대 한 현장은 DB unique와 접근 권한 경로로 확인했다. `useSites` 권한 확인/현재 현장 조회/URL scope/로그아웃 dirty guard는 유지한다. 삭제된 전환 전용 4파일은 Git 이력으로 복원 가능하다. DataGrid explicit align을 공통으로 적용하고 undefined 기존 기본값은 보존한다. 실제 시간대 계산·명령 UUID/명시 Apply·선택/초안/복구·보고서/다운로드 상태 owner, API/DB/Gateway/펌웨어/토큰/의존성은 변경하지 않았다. 네 메뉴 문서를 구현 commit에서 갱신했다.

## 검증과 수리

- 직접 변경 회귀: 공통/모니터링 190 PASS, 제어 373 PASS, 통계 155 PASS. 높이 수리 focused2 PASS·헤더 focused1 PASS. 각 RED·중간 기대값 실패·실제 실행 필터 범위는 [담당 보고서](reports/task-13-report.md), [제어](reports/task-14-report.md), [통계](reports/task-15-report.md)에 분리했다.
- 정책 테스트 한 번 79 PASS/0 FAIL/0 SKIP, 타입 exit0, UI 위반0·0, 빌드 exit0. 제품 수리 뒤에는 해당 UI/build(tsc 포함)만 재확인했고 최종 `b70f037f`도 exit0이다. 기존 main930.29KB 큰 chunk 경고1은 남는다. [원 로그](logs/)에 source별 결과를 보존했다.
- Browser **7개 고유 사례·6회·15개 실행**: 최초7=5PASS/2FAIL → 국소2=1PASS/1FAIL → 높이 수리3PASS → 헤더 RED1FAIL → 헤더 부분 GREEN1FAIL(기존 계정 hit-shape) → 최종 PC1PASS. 최종 HEAD 전체7 일괄 재실행 결과가 아니다. 원 실패를 보존하고 변경에 영향 받는 사례만 다시 확인했다. [브라우저 보고서](reports/task-16-report.md), [원 실패](original-failures/).
- 짧은390×600: 최대 scroll179에서 tickerbottom591>nav532인 실제 결함을 수리했다. 최종 document847/scroll247=max247, tickerbottom523<nav532/44px/hit-test PASS. tall578·681×1227 map630px·panelbottom1141/nav1159 유지. 공통240px 지도 하한·camera/renderer 불변. [수리](reports/task-13-short-mobile-fix.md).
- 긴 현장명 PC1280/760에서 집계가 action을 덮는 실제 회귀를 수리했다. 집계/action 고유 폭을 확보하고 현장명은 남은 폭에서 줄임표 처리한다. 기존 계정 Link44px rounded hit-shape 실패도 기능은 그대로52px 영역만 보완했다. 최종1440/1280/760 실제 네 셀/action 비겹침·16px 분리·집계12px gap·3대상52×52/연속44·center hit/가로 overflow0 PASS. [헤더 수리](reports/task13-header-width-fix.md).
- 수동 선택/clear/밝기31 입력 owner·theme/resize 보존, 스케줄 유일 CTA/focus·중앙 정렬, dark 통계 실제 데이터/필터/CSV 진입을 확인했다. Controlled API fixture 쓰기0, task 전용15186 서버 종료, 기존5173/4000/63200 보존. 전체 Web/E2E/Lab/HIL/native WebView/GPU/실장비는 검증하지 않았다.
- **기존 실패:** SettingsShell ‘현장 관리’ group 테스트1은 동일한 기본 `d8dbfcd1`에서도 재현됐다. 해당 제품·실패 test는 불변이며 이번 PASS에 포함하지 않았다. 전체 suite 통과로 보고하지 않는다.
- [동일 독립 리뷰 자리](reports/task-17-review.md)에서 모바일/헤더 P2 해결 확인, 미해결 Critical/Important/Minor0/0/0, Ready to merge YES. 추가 리뷰 자리/전체 재감사 없이 발견된 수리만 국소 확인했다.

## 대표 실제 화면

- [모바일578](screenshots/comments-tall-578.png), [모바일681](screenshots/comments-tall-681.png), [짧은 모바일 로그](screenshots/comments-short-monitoring.png), [짧은 모바일 제어](screenshots/comments-short-manual.png): 높이 수리 source4802b641. 뒤 헤더 수리는 PC-only라 해당 모바일 layout 불변.
- [최종 PC1280](screenshots/comments-pc-header-1280.png), [경계760](screenshots/comments-pc-header-760.png), [PC1440](screenshots/comments-pc-header-1440.png): 최종 제품sourceb70f037f.
- [다크 보고서](screenshots/comments-dark-reports.png), [열린 필터](screenshots/comments-dark-reports-filters.png): 실제 통계sourcee9d72b91, 뒤 Shell 수리는PC-only·모니터링 수리는타메뉴로 해당 기능 불변.
- [표 정렬](screenshots/comments-pc-tables.png), [선택/clear](screenshots/comments-manual-central-clear.png): 헤더 수리 전 해당 기능 증거. 특히 후자의 헤더 중첩은 원 상태로 남겨놓았으며 **최종 헤더 승인 이미지가 아니다**.

각 PNG의 인접 `*-metrics.json`에 실제 좌표·쓰기0을 보존했다. 보고서는 당시 작업 checkout 경로를 유지하는 원문이다. 현재 재사용 파일은 이 디렉터리의 reports/logs/screenshots이며, ignored 원자료는 완료 후 기본 repo의 task 전용 backup에 보존한다. 원 결과/단위시험만으로 모든 상세 UI·모든 기기·실장비 완료라고 확대하지 않는다.

## 통합

기본 `codex/mvp1-cloud-web`과 격리 branch가 clean임을 새로 확인하고 `git merge --ff-only codex/atlas-browser-comments-20261011`로 첫 FF를 완료했다(exit0): `d8dbfcd10a6b5a00bafbfca65cb8652d0bb08508` → `28bdcae1ec5eedf770d100f07033cd12db38aa22`. merge 뒤 clean/실제 HEAD와 `git diff --exit-code b70f037f HEAD -- apps/web/src packages apps/web/package.json pnpm-lock.yaml` exit0를 확인했다. 검증 제품source와 같으므로 전체 검증은 반복하지 않는다. 이 완료기록은 같은 격리 branch의 문서 전용 후속이며 같은 FF 방식으로 반영한다.

Ignored 원 보고서/계획 ledger/전체 browser 결과와 Web test-results를 기본 repo `.superpowers/sdd/atlas-browser-comments-backup-20261011.1bJzXB/`에 복사해 보존했다. 이번에 만든 worktree/merged branch만 정리하며 원 Git commits·tracked 증거·기존 stash/다른 checkout/5173·4000·63200은 유지한다.
