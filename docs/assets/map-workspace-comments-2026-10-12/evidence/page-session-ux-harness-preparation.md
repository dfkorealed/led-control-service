# UI/UX 실측 harness 준비 — 최종 suite 연결

- 소유: 이번 ignored SDD의 측정 지원 코드·구성·이 준비 기록만. 제품/기존 test/plan/status/index/서비스 변경 없음.
- 담당 정정: Task2 sole writer는 기존 ‘제어 UI 개선 담당자’. 모니터링 제품 ac323a3d와 인수 docs87f658ef는 별도 cohort이며 최종 제품 source로 가정하지 않는다.
- 최종 frozen source: bea0dacb07d3d5c8e0b14e4659874da12ed6b2d4. Task1 제품 ac323a3d, Task2 제품 9f3e25d7. 두 owner 최종 보고서/실제 SelectBox·detail·selection·execution·viewport source를 읽어 단일 6case spec을 연결했다.
- 정적관문완료/실행 grant 수신: 총괄 policy79PASS/tsc포함build exit0 전달. 이 기록 시점 브라우저 실행 0이며 실제 실행·원 실패·PNG·geometry 결과는 별도 실제 보고서에 기록한다.
- Ruling: API fake GET-only / nonGET 기록·abort / retries0 / 지정15188 free 검사 / fullSHA·freshRun fail-closed 유지. 기존 서비스·제품·tracked 문서 변경 없음. 실제 검증 실패 뒤 제품 수리 및 scope 승인 없는 case 재실행 금지.

## 준비 파일

- page-session-ux-support.ts: 기존 typed mock boundary/settings API/continuous44 helpers를 직접 재사용. 3/60개 UUID seed와 current timestamp/assigned light slots. nonGET은 기록·abort하며 fake success를 생성하지 않는다. 실제 테마 버튼 사용; storage payload·DOM style·camera/scroll 값 주입 없음.
- 같은 파일: phase별 viewport PNG/JSON, map box/ancestor-clipped box/실제 overlay·nav 차감 노출 영역, 문서·내부 scroll·카메라·canvas·선택·hit sample. DOM identity handles, native CDP marker-origin swipe. 샘플 hit는 continuous44 통과 증거가 아니다.
- page-session-ux.config.ts: 최종 full SHA/명시 실행 승인/새 run ID/실제 spec 없으면 fail-closed. 독립15188 free 검사, reuseExistingServer=false, workers1/retries0, run별 새 output. 기존 서비스 listener는 종료·재사용하지 않는다.
- 기존 spec 전체 import/옛 source 기본값/QA 전체 행렬 등록 없음. 준비부에 test 등록 없음.

## 최종 인계 후 연결할 최대6 고유 case

1. 1194×1227 light monitoring: 실제 middle/Space/left/wheel, toolbar 한 행, single selection, 상세 전후 rect/camera/DOM identity, half overlay/body wheel/header/close/focus.
2. 390×600 dark monitoring: icon44/HH:mm/full accessible timestamp, 상세 내부 끝/가림. stale/error/invalid/future는 owner127 직접 unit의 정확한 계약을 확인해 중복 browser 재구현 생략 여부와 한계를 기록.
3. 320×600 light manual: 유한 shell/document scroll0, 두44행/nav 연속hit, actual map box/exposed area, raw31/invalid 첫Apply0POST, More 내부 끝/closefocus.
4. 390×600 dark hasTouch manual: native marker-origin swipe→selection 불변/다음tap, 긴60선택 count/44전체보기/같은 inline 패널 내부 끝/header 고정/nav.
5. 717×1227 light→390×844 같은 case: 남은 지도 우선성/확장·닫힘 전후 camera/renderer identity, actual focus+resize/raw draft/nav/document overflow. OSkeyboard 증거가 아님.
6. 1194×1227 dark manual: empty full row/긴 내부 목록/중요 collapsed 표시·live·More 접근. 복잡 command recovery는 owner 직접 unit 근거가 있으면 browser storage 조작 없이 생략·한계 명시.

최종 실제 검수는 PNG와 geometry를 직접 읽고 같은 SDD의 page-session-ux-report.md에 source cohort/실측/문제·한계/merge 가능 여부를 기록한다. 이번 준비 기록은 그 실제 검수 보고서를 대체하지 않는다.

