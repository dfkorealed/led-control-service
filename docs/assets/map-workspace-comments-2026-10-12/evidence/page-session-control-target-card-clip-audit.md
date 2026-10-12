# f292 actual toolbar list RED — compact ancestor 읽기 전용 감사

- source f2926e927ab8c976ef1dbb282c932bdddfdf8685. 감사 단계 제품/browser 변경0.
- 원 actual `actual-one-parent-clip-f2926e92-20261012` 실패는 조명 목록48×44 hasMinimumArea=false. toolbar row x8/y87/w304/h44/right312/bottom131. 개별 list x/y는 원 실패 error에 없으며 source flex-end + width48로 x264/y87/right312/bottom131를 유도한다. 별도 browser 측정으로 주장하지 않는다. 원PNG 우상끝 둥근 잘림과 일치한다.
-0/100 각각 원 attachment의 four targets(input/thumb/Apply/More)는 continuous44=true. thumb52 rect의 usable height48도 true. f292 INPUT 실패가 아니며 이후 toolbar list에서 중단된 새 RED다. 미도달 auxiliary/invalid 단계는 보존한다.

| narrow target | 실제 DOM ancestor | radius/clip 감사 결과 |
|---|---|---|
| toolbar 조명 목록48×44 | Button(square)→flex actions row→toolbar→Spatial root→Control target Card | outer card rounded14/overflowhidden + padding0; list 우상flush.48폭4여유/44높이0여유로 상단clip을 피할44 영역 불가. 원 실제 RED와 부합 |
| toolbar 층/범위 Select | native trigger→FormField→같은 outerCard | 왼쪽 층도 부모top-left radius영향; 버튼 폭이48보다 넓어 가운데44 영역 여유. 개별 실제 실패없음, 해당소자수리0 |
| 선택 전체 보기 | square fullwidthButton→ManualSelectionPanel→detail wrapper→Spatial content/root→outerCard | panel compact 자체 round/overflow없음. outerCard 아래 모서리가 가장자리 외곽을clip할 수 있지만fullwidth304라 중앙44 영역 여유. 동일outerCard radius수리 범위로함께 해소 |
| More 실행 opener/Apply/input/thumb | ManualExecution row/body→SidePanel→Control layout | f292 SidePanel square, 원0/100 eight actualtarget PASS. outer targetCard는 sibling이므로 ancestor아님 |
| auxiliary close48×44 | header px2→auxsection(round/nooverflow)→OperationMapPanel(round/overflowhidden)→outerCard | header좌우8px inset·panel upper row. 자체auxsection round는 overflowvisible이라hitclip원인아님. map의 bottom corner와 헤더는 떨어짐; 아직 actual미도달이므로 PASS단정0 |
| selection clear/More presets·history/recovery actions | fixed portal target→auxbody(p2/overflowyauto, round없음)→auxsection→innerMapPanel→outerCard | 실제 DOM portal host기준. body끝8px inset으로 innerMap radius 모서리와분리. 내포된 text/list round는 조작버튼ancestorclip이아님. actual미도달, 추가확정miss없음 |

- common Card rounded-panel/token14 유지, inner OperationMapPanel rounded/overflowhidden 유지. 전역overflowvisible/height/버튼확대/handler 변경 필요없음.
- Root 승인과 원 source/PNG 대조 일치: outer targetCard caller만 `singleColumnLayout && rounded-none!` 추가+예외주석. 다른확정miss없어범위확대0.
- 실제 computed ancestor/corner hit diagnostic 실행0. 위는 source + 원 실제 수치/PNG 감사이며 후속actual 판정별도.
