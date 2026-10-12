# Task2 f28 actual INPUT 실패 — 읽기 전용 부모 clipping 조사

- source `f28ea638c3decae89bfd6180c8e81607226794e8`, worktree/branch 기존 grant 동일.
- 제품·문서·harness·원 evidence 변경0, browser/테스트/서비스 실행0. 현재 HEAD 그대로, git tree clean. source hash는 `page-session-control-parent-clip-readonly-source-sha.json`.
- source·PNG·기존 actual metadata만 점검했다. repair grant를 기다리며 STOP/WAIT.

## 실제 evidence

`runs/actual-two-endpoints-f28ea638-20261012/results/page-session-ux-aux-03-nar-3a191-y-and-exclusive-auxiliaries-chromium-ux-approved-aux-six-cases/attachments/failure-geometry-caebc6ad4283cf5fb30e980fc544e65de3471196.json`:

- target 확정: INPUT, ariaLabel/name `밝기 수치`, x8/y480/w48/h44/right56/bottom524, continuous44=false.
- execution 행: x8/y480/w304/h44, overflow visible. document600×320/overflow0.
- failure PNG `failure-679bd16b42314c8f2c14e2f3c20024a54ee1320a.png`에서0 thumb 중심은 약x103으로 이동하고 입력과 분리돼 있다. 흰 실행 SidePanel의 좌상/우상 rounded shape는 유지된다.
- `page-session-ux-endpoints-f28ea638.log`: case3FAIL / case5PASS, 전체17.8s. case5 재검사0. 이전 원fail 및 아직 미도달0/100/aux/invalid stage 상태는 보존한다.

## ancestor 원인

| 계층 | 현재 소스 | clipping 관계 |
|---|---|---|
| INPUT | NumberField Input에 compact `rounded-none!`, fieldControl min-h44, 폭48 | 입력 자체 모서리 예외는 이미 적용 |
| FormField | flex/min-w0/w48 | overflow/radius 없음 |
| 숫자 묶음·numeric capture owner | flex/min-w0 | overflow/radius 없음 |
| execution row/body | grid/min-h0, gap1 | overflow/radius 없음 |
| **SidePanel** | ControlView729 compact `gap-1 border-0 p-0` | **card default rounded-panel을 취소하지 않음** |
| common SidePanel7 | card default + overflow-x-hidden/overflow-y-auto | **부모의 둥근 padding edge에서 descendant hit clipping** |
| card/token | Card10 rounded-panel; theme345 radius-panel0.875rem | 일반16px root에서14px radius |
| 상위 layout/tab/Control screen | finite min-h0, mobile grid, round 없음 |320에서 compact:overflow-y-auto 미적용 |
| CustomerShell content/main/app-shell | manual px2/py1, min-h0, round 없음 | 이번 실행 모서리와 무관 |

지도 target Card의 rounded/overflow-hidden은 SidePanel의 **형제**이므로 numeric의 ancestor가 아니다. sibling 지도/보조 panel의 clipping을 바꾸는 수리는 이번 실패를 해결하지 못한다.

## source/수치 해석

- padding0/border0 SidePanel에서는 INPUT 좌상단이 부모 좌상단에 붙는다. 행/top과 INPUT top은 모두480이다. PNG의 white14px rounded edge와 일치한다.
-44 높이 INPUT에서44 연속 정사각형은 세로로 옮길 여유가 없다.48 너비에서 좌우로 옮길 수 있는 여유는4px뿐이다.
- 반경14, 맨 윗1px cell 중심 y0.5의 clip edge는 부모 왼쪽에서 약10.29px 지점이다(14−sqrt(14²−13.5²)). 후보44 폭을 오른쪽으로 최대4px 옮겨도 첫 cell 중심x4.5가 이 edge보다 왼쪽이다. 따라서 INPUT48×44의 최상단에서44 폭 연속 hit를 만들 수 없다.
- harness는 ancestor rectangular usable이48×44여도1px cell마다 elementFromPoint를 검사하므로 radius가 rectangular metadata에 드러나지 않는 이번 false와 부합한다. source+PNG 기반 강한 원인 결론이며 실제 computed ancestor radius 또는 clipping off의 browser diagnostic을 수행한 증거는 아니다.
- More도 부모의 오른쪽 상단 끝에 붙어 같은 radius clipping 위험이 있다. More 실패가 실측된 것은 아니며 지금 input에서 중단된 원fail을 넘겨 읽지 않는다.

## 가장 작은 compact-only 수리안 (미실행)

`ControlView.tsx`729의 existing singleColumnLayout true class에 **rounded-none 한 토큰** 추가:

```tsx
singleColumnLayout ? "gap-1 rounded-none border-0 p-0" : "gap-3 p-3"
```

- `cn.ts`의 radius semantic 등록과 기존 cn.test의 rounded-panel 교체 계약을 사용한다. caller class는 공통 card class 뒤에 합쳐지므로 기본 rounded-panel만 대체한다.
- shared SidePanel/Card/token/default/PC 수정0, surface/card 배경·overflow scroll 정책 그대로, height/padding/버튼 rect 확대0, 기존 draft/ref/UUID/handler 변경0.
- compact SidePanel의 모서리만 제거하면 numeric/More의 parent corner 손실을 함께 다룬다. f28 thumb 수평 gutters와 numeric square는 유지한다.
- border radius는 flow dimensions에 관여하지 않으므로 선언상 지도 높이 budget은 바뀌지 않는다. 실제 map≥240/입력·thumb0/100·Apply/More continuous44는 freeze 후 UX 관문에서 판정한다.
- repair가 허가되면 원f28 actual INPUT failure를 RED로 사용하고, 필요한 직접 consumer/type/UI 정책 + 메뉴5섹션 갱신·raw hash cohort 보고 후 대기한다. geometry class-only GREEN은 주장하지 않는다.

총괄의 source 증명/필요 diagnostic 및 명시 repair grant를 기다린다.
