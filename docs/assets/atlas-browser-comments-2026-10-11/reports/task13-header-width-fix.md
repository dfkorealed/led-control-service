# 공통 헤더 긴 현장명 폭 후속 수리

- 기준 `72bbd2e1`, 수리commit `45b22fce` (5files,11insertions,1deletion). 소유파일 CustomerShell.tsx·네 메뉴 문서만 commit; QA E2E 변경/증거와 root 상태/계획은 제외했다.
- 원 actualbug: plain 긴 현장명으로 바뀐 뒤 첫 grid track `minmax(0,auto)`가 폭을 소모하고 집계 `minmax(0,1fr)`가 압축된다. 집계 내부 intrinsic dl은 줄지 않아 action과 겹쳤다. 기존 document overflow0/gap12만으로는 header 내부 겹침을 놓쳤다.
- QA 기존PCmetriccase RED1회 exit1, 변경전CustomerShell SHA256 f822c2bdeca3a3c3e155041ea44a47699a9d50080b4f402761634b6c53c5a54d: 1280 context248..990.078/summary1006.078..1072폭65.922/actualchildren1006..1177.297/actions1088..1252, themecenterreachablefalse.760 context108..536/summary552..552폭0/actualchildren552..723.219/actions568..732/themefalse.1440/1280/760 PNG+JSON을 `.superpowers/sdd/2026-10-10-atlas-ui-fidelity/task-16-header-red-results/atlas-ui-fidelity-browser--9d461-header-metrics-stay-compact-chromium/comments-pc-header-{width}{.png,-metrics.json}`에 보존한다. 원 실패 삭제0.
- 최소수리: compact desktop grid recipe를 `minmax(0,1fr)_auto_auto`로 변경해 집계/action intrinsic 폭을 확보하고 현장명에 남은 폭을 준다. 기존 site Text min-w0/truncate를 그대로 사용하고 이유 주석을 추가했다. 모바일2열·집계4동일행·로고·gap12/44px·조회/URL권한/logout dirty guard/API/DB/token/dependency 변경0.
- 직접관련 검증 한 번: `PATH='/tmp/atlas-ui-fidelity-node22.xde1wS/bin':$PATH pnpm --filter @led-control/web exec vitest run src/features/shells/CustomerShell.test.tsx -t 'keeps desktop context and summary in one header' --reporter=dot` exit0,1PASS/61비선택,2.22초. 기존 DOM/owner 보존 회귀이며 actual geometry 증거가 아니다. git diff --check/cached --check exit0.
- QA GREEN 기존PCcase1회1440/1280/760 실제 rect/nonoverlap/reachable44 후속 대기. root ui/build 한 번 후속이며 별도 전체unit/type/policy/build/browser 실행0. 실제 성공은QA결과회수뒤 기록한다.

## 계정 링크 연속 조작 영역 후속

- 첫GREEN case exit1: 수리된 헤더의 세 폭 nonoverlap/gap12/documentoverflow0/각targetcenterreachable44 geometry 단언은 전부PASS였다. 추가 strict continuous44 검사에서 기존 계정 Link44×44 rounded-control만 hasMinimumArea=false였고 bell/theme52는PASS였다. `task-16-header-green-results` 원 PNG/JSON/failure를 보존한다.
- 이 계정 Link min-h11/min-w11/roundedcontrol은 기본d8dbfcd1에도 같은 클래스였으며 grid수리에서 새로 바꾼 code가 아니다. Root가 docs/ui-spacing.md 연속44 hit 계약을 존중하도록 같은 헤더 조작영역 범위에 한정 승인했다.
- `b70f037f`: 기존 공통52px icon target 크기인 min-h13/min-w13 두utility만 변경하고 네menu에 기록했다(5files,9insertions,1deletion). Link href/semantics/focus/route·mobilehidden·계정본문/Nav/MFA 변경0. diffcheck/cachedcheck exit0. source-string unit/new tests/전체unit 반복0; actual RED는 위 strict44 failure다.
- QA SAMEPCmetriccase1회1440/1280/760 최종GREEN 및 root ui/build 수리source 확인 대기. 기존 fail을 숨기거나 첫GREEN 전체case가PASS였다고 기록하지 않는다.
