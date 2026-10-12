# 지도 작업 공간 — f28 endpoint 최소 delta 독립 리뷰

**Source delta 검토 완료 / Ready to merge: No / actual case3·5 증거 대기.**

## 범위와 읽은 증거

- 동일 reviewer seat, BASE `2290a877d880efc60f91bbd3396a47d9361b3fbf` → clean HEAD `f28ea638c3decae89bfd6180c8e81607226794e8`를 확인했다. 이전 전체 source 재감사는 하지 않았다.
- `review-2290..f28-endpoint.diff` 3파일 전체, slider-endpoint 담당 report/source-sha/postcommit/direct-result/typecheck-result/ui-check-result, 직접 log 및 final-f28 정책/build 원문을 읽었다. class 전달 대상 확인을 위해 무변경 Slider/NumberField/FormField 구현만 직접 대조했다.
- 소유3파일 current SHA256은 source/commit 감사값과 일치한다. 보호9파일 및 총12파일의 current/blob 보존은 담당/root 감사 기록으로 확인했다. diff는 ManualExecutionPanel 제품1, 직접 test1, control 메뉴1뿐이다.
- `superpowers:requesting-code-review` 형식 적용. 제품/index/HEAD/branch/test/원 evidence 변경0, 테스트/browser/port/server/새 agent 실행0. 이 ignored 보고서만 작성했다.

## Strengths

- `ManualExecutionPanel.tsx:95`의 compact 숫자 입력 모서리와 `:105`의 Slider shell padding만 제품 변경이다. 공통 NumberField/Slider/default·PC에는 스타일을 전파하지 않고, 기존48×44 numeric 크기와 실행행 높이도 변경하지 않는다.
- Slider class는 FormField shell에 전달된다. shared thumb52px의 endpoint26px 돌출을 caller 좌우28px로 자기 열 안에 배치하려는 수정은 원 관측과 일치하며 주석이 이유를 설명한다. 새 wrapper/key/ref/handler/track hook을 추가하지 않았다.
- raw invalid/blur·Enter 복귀/첫 Apply 차단, onBrightnessChange/onSubmit, disabled/권한, command UUID/frozen request 및 aux owner/focus 수명은 delta상 불변이다.
- `ManualExecutionPanel.test.tsx:38`의 compact false/true 두 회귀는 Home/End 값·숫자 동기화·동일 slider DOM/focus·More 후 draft·명시 Apply만 submit을 검사한다. 이전 source에서도 통과한 안전 동작 테스트임을 보고서가 명시하므로 실제 CSS hit의 RED/GREEN을 위조하지 않는다.
- 메뉴 문서는 다섯 구성과 원 actual 실패/미수집 target-name 한계·actual 재판정 필요를 유지한다.

## Issues

### Critical

새 delta에서 확정 finding 없음.

### Important

새 source 회귀는 확인하지 못했다. **원 endpoint actual failure는 아직 open이다.**

- 위치: `apps/web/src/features/control/ManualExecutionPanel.tsx:95`–105.
- 원 영향: 2290 actual case3 Home→0 뒤 `[input, thumb, Apply, More]` cohort의48×44 target이 continuous44를 충족하지 못했다. 원 에러가 target 이름을 남기지 않아 numeric 단독 결함이라고 확정하지 않는다. 당시 map269px/document overflow0은 현재 f28의 실측값이 아니다.
- 최소 후속: 승인된 f28 case3/5에서0·100 양끝 numeric/thumb/Apply/More 각각의 실제 hit 및 지도240+/row·nav/aux·touch/resize 계약 도달 여부를 판정한다. padding은 track의 사용 가능 길이를 줄이므로 320px 실제 drag/endpoint가 usable한지 역시 같은 원 사례의 결과로 확인해야 한다. 이는 새로운 확정 finding이나 추가 suite 요청이 아니다.
- 2290 case5의 정상 선택 empty live 영역을 visible로 강제한 harness 실패는 source-proof 교정 후 해당 actual 재검사로 구분한다. 제품 결함으로 단정하거나 source-only로 actual gate를 닫지 않는다.

### Minor

별도 finding/nitpick 없음.

## Evidence / cohort

- 최종 direct: **5files81PASS/242skip**, exit0, wall15.535s/Vitest13.74s. Control18+Shell6+Spatial33+ManualExecution11+Viewport13이다. 새2개는 이81에 포함되며83으로 더하지 않는다. 수정 전 native Home/End 포함11PASS는 기존 동작 baseline이지 geometry RED가 아니다.
- owner type: exit0/진단0, wall19.326s. UI check: existing0/new0, exit0, wall3.636s. 각 result JSON의 정확 command/UTC/exit와 원 log를 대조했다.
- 동일 f28 root policy: **79PASS/0FAIL**,31.698s, 총괄 exit0. 타입 포함 `tsc --noEmit && vite build` 성공10.80s, 총괄 exit0. 기존 main932.47kB/>500kB warning 유지.
- 이전4093 direct118/actual1PASS5FAIL, c9 direct79, d2a111PASS5FAIL, App67PASS2FAIL→69PASS 및 타입 outer1/nested2 RED→2290 fresh type0 등의 원 cohort는 이전 보고서대로 보존하며 현재81/79와 합산하지 않는다.
- 최신2290 actual5 결과는 총괄 인계상 **3PASS(case1/2/4)/2FAIL(case3/5)**이다. f28 후속 case3/5의 최종 원 보고서는 아직 pending이며, 여기서 실제 GREEN을 확인했다고 주장하지 않는다. PC case6은4093의 source-equivalent false-prop carry이지 f28 새 PASS가 아니다.

## Declined to judge — 기존6개 / 승인 Ruling 유지

새 scope 제외·자율 판정 추가0. 이전 보고서의 다음 경계를 유지한다.

- 과거29/20 및 대형 matrix 전체: 이번 신규8건 밖이며 과거 수를 합산하지 않는다.
- API/DB/장비/서버 incident/별도 세션·원격 배포 및 독립 Operator/API/CI 작업의 재감사·수리: UI 소유 범위 밖이다. 새 MAIN `53f48c69`는 아직 이 source에 통합되지 않았으며 본 리뷰가 그 미래 구성을 승인하지 않는다.
- 전체Web/HIL/native WebView/GPU/물리 OS keyboard/전체 viewport-theme 조합: 기존 LEAN 관문 밖. 지정 actual/direct/source 증거만 판정한다.
- 기존 SettingsShell baseline/chunk warning 수리: 변경 밖 한계이며 새 실패를 가리는 근거로 쓰지 않는다.
- 승인된 제목/modal/aside/부가UI 제거·이동의 복구: 승인 계약과 반대다. 이동 UI의 접근성·command 수명은 계속 필수다.
- MAIN 반영/backup/cleanup 실행: 총괄의 미래 실행 증거 전 인증하지 않는다. 사용자 MAIN unstaged AGENTS 보존도 총괄 후속 감사 대상이며 본 reviewer는 MAIN에 쓰지 않는다.

## Assessment

**Ready to merge? No — actual case3/5 최종 증거 대기.**

최소 caller-only delta와 직접/정적 회귀 증거에서 새 확정 source 문제는 없다. 그러나 원 endpoint 실패 및 아직 도달하지 못한 actual 계약을 source/class로 닫을 수 없다. 같은 seat에서 최종 raw/geometry/PNG 및 실제 소스 연결을 인수한 뒤 이 보고서의 결론을 갱신한다.
