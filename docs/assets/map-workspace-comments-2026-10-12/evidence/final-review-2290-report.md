# 지도 작업 공간 — 2290 compact hit / 통합 lookup 후속 리뷰

**Source delta 검토 완료. Ready to merge: No — 실제 failed 5개 재검사 증거 대기.**

## 범위 / 방법

- 같은 독립 reviewer seat. 현재 clean HEAD `2290a877d880efc60f91bbd3396a47d9361b3fbf`를 확인했다. 이전 `4093ff53` 전체 source review를 반복하지 않았다.
- `final-review-2290-handoff.md`, `review-4093..c9-hit.diff` 전체, `review-d2a..2290-test.diff` 전체, hit 담당 보고서/SHA, root 통합 proof, 직접/통합/정적 원 로그를 읽었다. 실제 `d2a..2290`은 `App.test.tsx` 한 파일뿐이며 merge 부모는 `c9b65514`/`7c7c8ee4`이다.
- `superpowers:requesting-code-review`와 기존 reviewer template을 적용했다. 제품/index/HEAD/branch/test/원 evidence 수정 및 테스트/browser/port/server/새 agent 실행 0. 자신의 ignored 보고서만 작성했다.

## Strengths

- `FloorMapViewport.tsx:713`–723의 camera 수정은 `compactChrome=true` 표현에 한정된다. 아이콘 52px·배율 최소52px이고 overlay 배치/zoom/reset/fit handlers/ref/renderer 경로는 불변이다. default/editor/PC false 경로에 새 스타일을 적용하지 않는다.
- `ManualAuxiliaryPanel.tsx:5`–9의 공통 feature class는 basic 행 높이44를 유지하고 최소너비48/사각 hit를 재사용한다. `ManualExecutionPanel.tsx:65`, `ManualSelectionPanel.tsx:19`, `TargetSelectionToolbar.tsx:48`의 compact 분기에만 적용되며 원 disabled/권한/raw invalid/첫 Apply/선택/복구 callback은 바뀌지 않는다. portal focus·scope·command owner도 변경하지 않았다.
- 카메라 coarse frame과 basic row 높이를 구분한 예외 이유를 코드 주석/메뉴 문서에 남겼다. 공통 Button/default 스타일을 확대하지 않았고, 실제 continuous44 통과를 CSS 선언으로 대신하지 않았다.
- `App.test.tsx:357`–361, `:928`, `:1183`의 세 조회 지점은 승인된 nonmodal complementary 역할에 맞춘다. 내부 선택 상세/조명명, 검색/목록, floor keyboard focus, viewer 권한 검증을 삭제하지 않는다. 별도 비밀번호 modal을 일괄 complementary로 바꾸지 않았다. unsupported `exact` 옵션 제거는 타입 적합성 수리이며 해당 role name의 기존 기본 matching을 약화하는 변경이 아니다.
- 현재 여섯 소유 파일 SHA256을 직접 계산해 담당 기록과 일치함을 확인했다. 통합 proof의 UI17/upstream32 보존 보고, 유일 status 양쪽 기록 보존 및 user MAIN AGENTS SHA를 읽었으며, scoped git diff상 UI 영역의 upstream 추가는 별도 `FixtureGroupDialog.test.tsx`이고 기존 UI 제품 변경은 통합 과정에서 추가되지 않았다. 이후2290은 App test-only다.

## Issues

### Critical (Must Fix)

새 source delta에서 확정 finding 없음.

### Important (Should Fix)

새 source delta에서 별도 확정 finding 없음. **원 actual camera continuous44 실패는 아직 열려 있다.**

- 관련 위치: `apps/web/src/features/floor-map/FloorMapViewport.tsx:713`–726. 기존4093의 compact camera 44px frame이 실제 연속44px hit를 제공하지 않아 모바일 case3–5가 중단됐다. aux 마지막 action/slider endpoint/native touch/resize는 그 실행에서 미도달이었다.
- 이번 수정 방향은 원인에 한정되지만, 실제 camera 및 basic action hit/지도240·nav/aux 내부 scroll·동일 rect/camera/canvas를 새 source에서 확인하기 전에는 해결됨으로 닫지 않는다. 원4093 지도320=251px/390=249px·document overflow0도 현재2290 새 실측값이 아니다.
- 최소 후속은 승인된 동일 failed cases1–5의 원 보고서/PNG/geometry 인수다. 별도 전체 실행·추가 reviewer·임의 제품 확대 수리는 요구하지 않는다.

### Minor (Nice to Have)

제품에 별도 nitpick 없음. 2e 타입 exit는 수집층을 구분한다. 총괄이 수집한 outer pnpm process는 exit1(session73202), 원 `final-2e-typecheck.log`의 nested tsc는 exit2/TS2769다. 서로 대체하지 않고 둘 다 보존한다. handoff의 exit1은 outer process 표기이므로 불일치 finding으로 세지 않는다.

## 검증 cohort / 원 실패 보존

- hit 소유 source `c9b65514`: 직접 **5files79PASS/242비선택**,19.45s. Control18/Shell6/Spatial33/ManualExecution9/Viewport13이다. owner type exit0/출력0, UI existing0/new0를 확인했다. 이전4093의118 및 root policy79와 합산하지 않는다.
- merge `d2a83cfb`: 원 통합 **4files111PASS/5FAIL**(116 전체GREEN 아님),26.43s. App helper 중간 **67PASS/2FAIL**, 이후2e **69PASS**10.91s지만 타입은 outer pnpm exit1 / nested tsc exit2·TS2769였다. 이 실패들을 보존한다.
- 최종2290 App 원 `page-session-monitoring-app-role-options-unit.log`: **69PASS**,10.57s. 담당 type0 및 root fresh `final-2290-typecheck.log` 출력0/총괄 session86203 exit0 기록과 함께 읽었다. 원4suite116을 최종 일괄116PASS로 바꾸지 않는다.
- d2a 원 policy **79PASS/0FAIL**29.89s, `tsc --noEmit && vite build` 성공14.54s. 기존 main932.47kB/>500kB 경고 보존. 이후 source는 test-only이며 root2290 fresh tsc0이 별도 보강이다. current2290에서 build/policy를 새로 재실행한 것으로 표현하지 않는다.
- 모니터링127 및 이전41/83/118 등은 앞선 보고서의 각 source cohort다. 이번 수와 더하지 않는다.
- actual4093 원6은 **1PASS(case6 PC)/5FAIL**, exit1. Monitoring1/2는 미배치 fixture에 배치됨 literal을 기대한 harness mismatch로 root/UX가 source 대조 후 한 줄 기대값만 교정한 것으로 인계됐다. 지금은 해당 후속 actual 결과를 받지 않았다.
- PC case6의4093 PASS는 이번 compact false 경로 source-equivalent carry일 뿐 current2290 신규 PASS가 아니다. 이전 bea0/6 및69b1 2/4 원 결과도 보존한다.
- `page-session-ux-hit-2290a877-report.md`는 현재 pending이다. 실제 새5GREEN/최종 전체6PASS/전체Web/HIL/OS keyboard/GPU 완료 주장은 하지 않는다.

## Declined to judge — 기존 승인 6개 / Ruling1 유지

새 자율 scope 제외 없음. 기존 executor가 각각 수용한 경계를 그대로 유지한다.

- 과거29/20건 및 대형 matrix 전체 재검사: 신규8건 밖이며 과거 evidence를 이번 수에 더하지 않는다.
- API/DB/장비/서버 incident/다른 세션 업무/원격 배포: UI 소유 범위 밖이다. 통합된 별도 API/CI/Operator 작업을 다시 심사하거나 수정하지 않는다. incoming preservation만 이번 handoff 범위에서 확인했다.
- 전체Web/HIL/native WebView/GPU/물리 OS keyboard/모든 viewport-theme 조합: 승인 LEAN 관문 밖. 지정 실제 사례와 source/direct cohort만 판정한다.
- 기존 SettingsShell baseline 및 chunk warning 수리: 변경 밖 한계이며 새 실패를 덮는 근거가 아니다. 이번 원 통합 App/type 실패는 별도로 보존·후속 증거로 판정했다.
- 승인된 제목/modal/aside/항상 펼친 부가UI 제거·이동의 원상복구: 승인 계약과 반대다. 이동된 UI 접근성과 command 수명은 계속 필수 관문이며 제외하지 않는다.
- MAIN 반영/backup/cleanup 실행: 이 checkout의 regular merge/source 보존은 읽었지만 향후 사용자 MAIN 업데이트/정리는 수행 증거 전 인증하지 않는다.

## Assessment

**Ready to merge? No — actual 재검사 관문 대기.**

새 compact hit 및 nonmodal test lookup delta는 기존 동작·default·권한·UUID·focus 경계를 보존하며 새 확정 source 회귀를 발견하지 못했다. 원 실제 camera 실패와 이후 미도달 계약은 동일 failed5의 actual 원 증거가 인계된 뒤에만 닫는다. 같은 seat의 다음 단계는 증거/필요 delta 판정이며 전체 source 재감사가 아니다.
