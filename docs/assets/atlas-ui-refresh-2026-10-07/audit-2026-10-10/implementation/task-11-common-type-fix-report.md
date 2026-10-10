# Task 11 공통 지도 테스트 타입 경계 수리

상태: 승인한 한 줄 수리 및 관련1개 focused GREEN 완료. 새 전체 타입/UI/build 통과 주장 없이 총괄 통합을 위해 멈춘다.

- BASE: `5f3e3c20be92a4cddfcd3a920dfc0627d87d273b`, 시작 clean.
- commit: `1c4943a600422f52dba1d99d1627b2c2260b3e77`.
- exact 변경: `apps/web/src/features/monitoring/FloorMap.test.tsx:350`의 `legend.closest(...)`에 공개 DOM generic `<HTMLElement>`를 추가했다. 1file/1insert/1delete.
- 실제 footer ancestor는 공유 FloorMapViewport가 렌더하는 HTML div다. 반환 타입만 HTMLElement|null로 정확히 지정하여 기존 `toContainElement`의 타입 계약을 맞췄다. cast/any/비-null강제/기존 단언 삭제·완화 없음. 같은 selector·null검사·map containment·camera containment·범례1개·기존 icon/text/marker assertions 모두 불변이다.
- 원본 RED receipt: task-11-static-typecheck.log 및 task-11-static-build.log, exact BASE에서 TS2345 FloorMap.test.tsx:352:34(Element|null vs HTMLElement|SVGElement|null). 최초 정적 실패 보고서는 덮어쓰지 않았다.
- GREEN 명령: `PATH="/tmp/atlas-ui-fidelity-node22.xde1wS/bin:$PATH" pnpm --filter @led-control/web exec vitest run src/features/monitoring/FloorMap.test.tsx -t "shows an icon and text legend with semantic marker variants"`.
- 실제 GREEN: exit0,1file/1PASS/0FAIL/14filtered SKIP(15),2.32초. `task-11-common-type-fix-green.log`. 경고/오류0. 비선택14를 전체 suite PASS로 합산하지 않는다.
- TDD/writing-good-tests/verification skill을 읽고 원본 실패·실제 DOM 타입·출력과 변경 diff를 대조했다. 사용자 승인 한 줄 범위로 새 RED나 전체 검증을 반복하지 않았다.
- `git diff --check` exit0; commit 후 `git status --short` 출력 없음(clean). root 문서·제품 source·Settings·정책/default/baseline·runtime/dependency 변경 없음. 메뉴 기능 변경이 아닌 test-only 타입 수리라 메뉴 문서 변경 없음.
- 전체 type/UI/build·다른 unit/E2E/583/Lab/canonical/HIL·install/prepare 미실행. settings 정책3/fixture타입2 등 다른 소유자의 수리·최종 통합 검증은 총괄이 조율한다. 이 focused runtime 결과를 전체 타입검사 성공이나 브라우저/HIL 승인으로 확대하지 않는다.
