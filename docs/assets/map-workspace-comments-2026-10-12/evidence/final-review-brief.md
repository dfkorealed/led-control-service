# 이번 지도 작업 공간 변경 — 독립 최종 검토 기준

NEW worktree: /Users/kim-jh/Documents/led-control-service/.worktrees/map-workspace-comments-20261012. BASE f31e56fadd27d63f96824bad2ea2c4ef71581b62. HEAD/package는 총괄이 제품 완료 후 전달한다. 지금 검토 dispatch 문서가 아니다.

사용자 신규8건만 범위이며 운영 인사이트/통계/설정/API/DB/장비/다른worktree/원격 제외. 이전29/20건·전체HIL 검증을 이번 cohort로 합산하지 않는다. 구현 소유자는 기존 앱 ‘모니터링 페이지 담당자’와 사용자 링크의 ‘제어 UI 개선 담당자’, 실제 UI/UX는 기존 ‘UI/UX 디자이너’ 세션이다. 총괄이 구현하지 않는다.

## 요구사항

1. Monitoring existing manual-cad+pan: PC middle-button drag·left singleclick, touch swipe/tap, no area/multi, keyboard/Space/zoom/pinch/cancel/default/editor/embedded 유지.
2. 순수 valid snapshot>60초 stale는 기존알람센터 현재상태만, toast/새unread/serverincident0; failure/invalid/future announcements 유지·fresh복구와poll dedupe.
3. visible monitoring h1제거·sr-only보존(loading/error/main), floor/finder/time/refresh 한행·narrow44이상icons/name·HH:mm/fulltimestamp정보.
4. PC/mobile같은 map-bottom 약half nonmodaldetail: maprect/camera/renderer불변, headerclose고정/body내부scroll, Escape/returnfocus/scopereset/scroll기억, overlaywheel지도zoom0·뒤map사용가능.
5. PCselectedempty도fullrow높이. mobilecount→44전체보기→samepanel inline longlistboundedscroll/닫기·scope reset, 새drawer/query0.
6. manual-active mobile만 finiteheight/document scroll0·remainingmapdominant, floor+scope+list44 한행·brightnessnumeric/slider/Apply/More44 한행.
7. More presets/history/recovery 내부scroll·criticalcollapsedvisible/live. raw31/invalidblurEnter/첫Apply차단/explicitApply/permissionlock/UUID/recovery/stateowner/cameraDOM수명보존. 자동화/editor/defaultembedded변경0.
8. existingcommonUI/token재사용·필요optionalchrome props default보존. 메뉴 monitoring/control 다섯구성·실제완료/mock/HIL한계정합.

## 검토 방법과 결과

- 읽기 전용: tree/index/HEAD/branch/서비스/제품/기존test 수정 금지. 새subagent·새chat·다른세션 메시지 금지. root가 제공하는 fullrange package+보고서/한정actual증거를 직접읽어 spec+quality/safety 통합1회 평가한다.
- 원 실패/최종sourcecohort 구분. mock 존재/순수class字符串는actual 동작/기하 증거 아님. finalbuild(tsc 포함)/UI정책/UI검사와이번direct/browser만; 전체tests·HIL·과거매트릭스 재실행 금지. 실패에 추가진단필요하면 root에제안.
- C/I/M severity·정확file:line/사용자영향·최소수리/Ready yes/no를 이번 SDD final-review-report.md에기록, 무엇을범위밖으로판단했는지(Declined to judge) 모두명시. 실제화면없는추론은추론으로표시한다.
- 원이미지/geometry를보지않고겹침없는완료를주장하지않는다. UX finding은원owner수리후영향범위만다시검토. 기존SettingsShellbaseline1failure와chunk경고는기존범위밖한계이지현재전체PASS가아니다.
