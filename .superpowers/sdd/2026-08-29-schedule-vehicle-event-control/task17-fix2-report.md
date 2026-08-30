# Task 17 Fix Round 2 보고서

기준일: 2026-08-31

## 수정 내용

- `automationExecutionActionResultPayloadV1Schema.safeParse` production 계약을 `packages/shared/src/automation-action-result-contracts.ts`의 단일 source-of-truth로 분리했다. 기존 `automation-contracts.ts`와 root barrel은 같은 타입과 schema를 재export하므로 API/Gateway 공개 계약은 유지된다.
- `@led-control/shared/automation-contracts` package subpath를 추가했다. browser/ESM import와 타입 해석은 workspace source entry를 사용해 shared build 전에도 동작하고, CommonJS `require`는 재현 가능한 `tsc` 산출물 `dist/automation-action-result-contracts.js`를 사용한다.
- Web의 runtime import를 shared root에서 narrow subpath로 변경하고 `ScheduleControlPanel`을 schedule mode에서만 `React.lazy`로 불러온다. 수동 제어 초기 main은 Zod와 schedule 구현을 다운로드하지 않으며 schedule loading 동안 접근 가능한 `tabpanel` 상태를 표시한다.
- `packages/shared/dist` 전체를 CommonJS 변환하던 Vite `commonjsOptions.include` 예외를 제거했다.
- production graph를 실제 Vite 5.4.21로 빌드하는 `test:bundle-audit`를 추가했다. shared root runtime 유입, narrow browser entry 누락, 무관한 Gateway 계약 문구, main raw/gzip 상한을 함께 검사한다.

## TDD RED

1. shared subpath runtime 테스트를 먼저 추가해 `@led-control/shared/automation-contracts` 미해결 실패를 확인했다.
2. 번들 감사 스크립트를 먼저 추가해 main `1,162.11 kB / gzip 345.72 kB`, shared CommonJS root 포함, narrow browser entry 부재, 무관한 Gateway 계약 문구 포함을 확인했다.
3. automation 전체 ESM 파일만 노출한 첫 시도는 top-level Zod schema 생성이 tree-shake되지 않아 `1,111.09 / 334.82 kB`로 상한을 넘었다. action-result 계약을 독립 모듈로 분리한 뒤에도 Zod runtime 때문에 `1,105.00 / 333.30 kB`였고, schedule mode lazy boundary가 필요함을 확인했다.
4. lazy boundary 적용 후 기존 `ControlView` 동기 assertion 1건이 loading 상태에서 실패해 실제 비동기 module resolve를 기다리도록 수정했다.

## GREEN 검증

- bundle audit: main `1,028.66 kB / gzip 313.70 kB`, 제한 `1,070 / 325 kB` 이내
- Fix Round 1 대비 main: raw `-133.45 kB`, gzip `-32.02 kB`
- reviewer detached 기준 `1,048.09 / 318.95 kB` 대비 main: raw `-19.43 kB`, gzip `-5.25 kB`
- schedule async chunk: `76.11 kB / gzip 20.12 kB`
- transformed modules: `2,418 -> 2,370`
- shared root runtime 및 무관한 Gateway 계약의 production graph/main 유입: 없음
- shared build 전 Web typecheck와 subpath runtime test 2/2: 통과
- shared full test 75/75, typecheck, build: 통과
- shared build 후 root/subpath CommonJS `require` smoke: 통과
- focused Web 5파일 80/80, Web 전체 32파일 334/334: 통과
- Web typecheck, lint, production build, bundle audit: 통과
- API typecheck/build, Gateway typecheck/build: 통과

## 남은 한계

- production API/Gateway를 연결한 Chromium software E2E는 이번 fix round에서 실행하지 않았다.
- 실제 Raspberry Pi/BlueZ/ESP32-H2 RF 및 전원 차단 HIL은 실행하지 않았다.
- main과 PDF chunk의 기존 500 kB Vite warning은 유지된다. 이번 회귀 상한은 별도 bundle audit가 강제한다.
