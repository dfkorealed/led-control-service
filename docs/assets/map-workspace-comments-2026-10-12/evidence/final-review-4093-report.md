# 지도 작업 공간 — 4093 후속 독립 source review

상태: **source delta 검토 완료 / actual 6개 관문 대기 / Ready No**.

- 작업은 신규 2026-10-12 C1–8이다. 전체 BASE `f31e56fadd27d63f96824bad2ea2c4ef71581b62`, 현재 frozen HEAD `4093ff536e2ded9edfb1d1f1c3b25f53b54989b3`이며, 마지막 read-only 확인 시 tracked clean이다.
- 같은 독립 seat에서 이미 검토한 `bea0dacb` 이후 `69b1e9a3` 및 `4093ff53`의 제품/직접 테스트 delta를 검토했다. full-range package와 최종 handoff, 현재 승인 계약, 두 제어 담당 보고서, 관련 메뉴 문서와 최종 raw log를 대조했다. 이전 bea 전 범위를 중복 재감사하지 않았다.
- `superpowers:requesting-code-review` 및 reviewer template을 사용했다. 테스트/브라우저/서버/포트/새 agent 실행 0, 제품/test/docs/index/HEAD/branch 변경 0. 이 ignored 보고서만 작성했다.

## Strengths

- `ControlView.tsx:697`의 provider는 수동 제어 분기에만 있고 주체/현장/선택방식 scope를 사용한다. `ManualAuxiliaryPanel.tsx:18`의 상태는 presentation 종류뿐이다. query, 선택, raw draft, frozen command/UUID/recovery를 새 owner로 복제하지 않는다.
- `ManualAuxiliaryPanel.tsx:64`는 고정 portal target을 유지하고 실제 host만 이동한다. mobile/desktop 전환 때 React owner를 새로 mount하는 문제를 피하며, 연결되고 표시된 기존 focused element만 복원한다. default provider 없는 소비자는 원 inline 경로를 유지한다. 테스트도 동일 DOM/owner와 내부 action focus를 확인하며 단순 class 검사에 머물지 않는다.
- `ManualAuxiliaryPanel.tsx:23`의 단일 active 종류, `:29`의 scope 초기화, SpatialTargetSelector의 층/현장 변경 close, Escape의 defaultPrevented 존중과 opener 복귀가 서로 연결된다. map viewport는 reader를 열고 닫을 때 reparent되지 않는다. actual geometry/focus 결과까지 이 source 판단으로 대신하지 않는다.
- `SpatialTargetSelector.tsx:167`–174의 reader는 지도 wrapper의 absolute sibling이며 지도 wheel listener의 자손이 아니다. legend/층 상태/선택 목록은 기존 data와 callbacks를 사용한다. `ControlView.tsx:658`의 모바일 mode tabs/현장 요약 이동과 `CustomerShell.tsx:341`의 중복 summary 숨김은 사용자 승인한 chrome 축소 범위다. sr-only h1과 현재 수동 제어 식별자는 유지된다.
- `ManualExecutionPanel.tsx:68` 이후 변경은 More 표시/배치이며 숫자 raw 검증, invalid 첫 Apply 차단, blur/Enter 복귀 및 명시적 submit 처리 경로는 유지된다. 중요한 상태는 shared reader가 열려도 실행행 아래에 남는다. 직접 consumer 테스트는 raw31, invalid999, 42.5 복귀, 명시 POST, 상호배타·scope·Escape를 검사한다.
- `ControlView.tsx:698`–701의 명시적 finite rows 및 `:80`의 history caller-only wrapping은 앞선 원인에 한정된다. 공통 ticker/history/API/renderer를 수정하지 않는다. desktop은 inline presentation을 유지하며 좁은 350px history 내 action만 wrap한다.
- 메뉴 문서는 다섯 구성과 실제 geometry/하드웨어 검증 한계를 유지한다. 수정된 단위 테스트를 실제 지도 높이·continuous44 통과 증거로 표현하지 않았다.

## Issues

### Critical (Must Fix)

새 delta에서 확정된 Critical source finding 없음.

### Important (Should Fix)

새 delta에서 확정된 Important source finding 없음. 단, **이전 actual에서 확정된 지도 높이 실패는 현재 source의 actual 재검사 전까지 닫지 않는다.**

- 관련 경로: `apps/web/src/features/control/ControlView.tsx:698`–704, `apps/web/src/features/control/target-selection/SpatialTargetSelector.tsx:167`–174, `apps/web/src/features/control/manual-workspace/ManualAuxiliaryPanel.tsx:52`–61.
- 기존 사용자 영향: bea 모바일 320×600/390×600/717×1227에서 지도·canvas 높이 0. 69b1에서도 short viewport 기본 지도 62/70px, 목록을 연 뒤 지도 0/canvas 단절이 실제로 관찰됐다. 문서 scroll 0만으로 지도 작업 공간이 usable하다고 볼 수 없다.
- 현재 최소 해결 방향: 승인된 단일 out-of-flow reader와 chrome 축소가 실제로 기본 지도 높이/노출을 확보하고 목록/More 전환에서 동일 map rect·camera·renderer를 유지하는지, 원 실패를 보존한 같은 6개 사례에서 확인한다. 소스만 보고 수리 완료로 표시하거나 추가 범위의 제품 수리를 제안하지 않는다.

### Minor (Nice to Have)

별도 확정 finding/nitpick 없음.

## 남은 actual 관문 / Recommendations

1. 320/390 short 및 717 tall에서 map 기본 높이·240 목표·document scroll 0·하단 nav reserve를 실측하고, selection/More 상호배타 전환 및 닫기 전후 map rect/camera/renderer 유지 여부를 판정한다. 현재 reader의 `max-h-[75%]` 및 fixed header/internal scroll이 마지막 action을 실제로 노출하는지 확인한다.
2. 기존 카메라/목록/More 및 새 reader 닫기의 rounded 44px action은 bounding box만이 아니라 실제 continuous44 hit를 확인한다. Slider 0/100 endpoint와 numeric/Apply 간섭·clipping은 아직 source risk이지 확정 별도 결함이 아니다.
3. PC inline presentation과 mobile↔desktop 전환 시 raw draft, pending/recovery action owner, 내부 focus 및 Escape/opener를 실제로 확인한다. 숨긴 모바일 chrome은 More에서 접근할 수 있어야 하며 지도 behind-reader 입력과 reader 내부 wheel을 분리한다.
4. 모니터링 actual overlay ratio·map rect/renderer·native pan/tap·detail wheel/close는 이전 source 판정과 별개로 기존 6개 관문에서 확인한다. 새 전체 suite 또는 추가 reviewer를 요구하지 않는다.

## 원 증거 / source cohort

- 모니터링 direct **127PASS**는 `ac323a3d`/문서 `87f658ef` cohort다. 현재 전체 4093에서 다시 실행한 것으로 표현하지 않는다.
- bea direct **41PASS**와 그 안의 identity 2개 국소 검사는 이전 cohort이며 43개로 합산하지 않는다. 중간 85/68도 현재 최종 수에 더하지 않는다.
- 69b1 direct **83PASS**는 별도 cohort다. 원 82PASS/1timeout, 분리 3개 및 동일 최종83 원 로그가 보존되어 있으며 4093의118에 더하지 않는다.
- 현재 4093 final 원 `page-session-control-bottom-panel-final.log`: **7files / 118PASS / 244비선택**, 16.48s, 담당 기록 exit0. Control18/Shell8/Spatial33/ManualExecution9/Viewport13/History30/Ticker7의 직접 선택 cohort다. 중간115/ready118/분리5 및 원 RED/focus/Escape 실패는 별도 보존하며 합산하지 않는다.
- 동일 HEAD의 `final-4093-ui-policy.log` 원문 **79PASS/0FAIL**, 22.98s; `final-4093-build.log`는 `tsc --noEmit && vite build` 성공, Vite8.62s이며 총괄 exit0 기록이다. 기존 main932.47kB/>500kB 경고를 보존한다. 담당 type0/UI existing0·new0은 보고된 별도 명령 증거이지 policy/build 원문이 증명하는 별도 UI 검사로 확대하지 않는다.
- 실제 첫 6개 **0PASS/6FAIL**, 69b1 재검사 **2PASS/4FAIL** 및 harness/config body 문제 기록을 유지한다. 이번 4093 actual6은 이 보고서 작성 시 아직 결과가 인계되지 않았다. 단일 최종 전체PASS/전체Web/HIL/native OS keyboard/GPU 완료 주장은 없다.

## Declined to judge — 기존 executor 승인 6개 유지

새로 범위 밖으로 제외한 행동 없음. 다음은 총괄이 각각 기존 승인/Ruling1과 일치한다고 수용한 항목이다. 제거 UI의 접근성·command 수명은 제외하지 않으며, 새 실패를 baseline으로 덮지 않는다.

- 이전29/20건 및 과거 대형 matrix 전체 재검토/재실행: 신규8건 범위 밖이며 과거 증거는 이번 cohort에 합산하지 않는다.
- API/DB/장비/서버 incident 설계·다른 세션 장비 업무·원격 배포: 이 UI source 범위 밖이다. 실제 장비 안전 검증을 대신하지 않는다.
- 전체Web/HIL/native WebView/GPU/물리 OS keyboard/모든 viewport-theme 조합: 승인 LEAN 관문 밖이다. 지정6개 실제 사례와 직접 증거만 판정한다.
- 기존 SettingsShell baseline failure 및 기존 chunk warning 수리: 변경 밖 한계다. 새 regression 은폐 근거로 쓰지 않는다.
- 명시적으로 제거/이동한 보이는 제목·모바일 modal·desktop aside·항상 펼쳐진 부가 UI의 원상복구: 승인 계약과 반대다. 새 단일 reader, 이동한 chrome의 접근성 및 기존 command 수명은 계속 필수다.
- MAIN 반영·backup·cleanup: 총괄이 실행 후 제출한 실제 증거로만 판정할 후속 작업이며 현재 read-only review가 미래 실행을 인증하지 않는다.

## Assessment

**Ready to merge? No — source delta는 통과 가능한 상태이나 actual 관문 미완료.**

단일 reader/고정 portal/fallback/command 수명에서 새 확정 source 회귀는 확인하지 못했다. 그러나 앞선 실측 지도 붕괴와 핵심 hit·height·native interaction 계약을 현재 4093의 actual 증거로 닫기 전에는 최종 승인하지 않는다. 같은 seat에서 인계된 원 증거와 필요한 delta만 후속 판정한다.
