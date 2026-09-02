# Task 6 구현 보고서

## 결과

- Scenes 17~21의 스케줄·차량 이벤트 목록을 공통 상태 badge와 feedback surface로 정리했다.
- 목록 table은 각각 `스케줄 목록`, `차량 이벤트 목록`의 접근 가능한 이름을 가지며, 작은 viewport에서도 같은 table DOM을 가로 스크롤로 유지한다.
- 스케줄 editor는 `운영 기간과 시간 → 반복 → 밝기 → 제어 대상`, 차량 이벤트 editor는 `감지 센서 → 제어 조명 → 행동` fieldset 순서를 사용한다. 기존 controlled input, validation, 첫 invalid focus, dialog focus trap/return은 유지했다.
- background polling 실패는 기존 행을 지우지 않고 retry 가능한 warning feedback으로 표시한다. 빈 목록에서는 PageHeader의 단일 추가 action을 유지해 중복된 접근 가능한 제어를 만들지 않는다.

## TDD 및 검증

- RED: 새 status badge, named table, editor section/validation-focus, polling-failure assertions을 먼저 추가했고 기존 표면에서 실패를 확인했다.
- GREEN: unit suite와 four-viewport route-fixture E2E를 통과했다.
- fixture E2E: `calm-operations-automation.spec.ts`는 1440×900, 1024×768, 390×844, 320×740에서 목록 열 reachability, document overflow 부재, empty/error/retry, dialog 경계와 touch target을 검증한다.
- real backend regression: `E2E_REAL_BACKEND_LAB=1` 및 `--workers=1` 조건의 `automation-control-flow.spec.ts`가 통과했다.

## 병렬 E2E 환경 관찰

brief의 두 spec 병렬 실행은 제품 assertion이 아니라 shared build 산출물 교체 race로 실패할 수 있다. 기본 Playwright webServer와 RealBackendLab가 모두 `build:shared`를 실행하고, shared build가 manifest 소유 dist 파일을 삭제한 뒤 재생성하는 짧은 구간에 다른 Vite server가 `/packages/shared/dist/esm/automation-action-result-contracts.js`를 resolve하면 module load가 실패한다. 단일 가설로 `pnpm --filter @led-control/shared build`를 선행한 뒤 RealBackendLab 전용 webServer 설정(`E2E_REAL_BACKEND_LAB=1`)과 workers 1로 분리해 재현·검증했으며, 이 조건에서는 실제 CRUD 흐름이 통과했다. 이는 제품 UI/API 계약 실패가 아닌 test-server orchestration race이며, 테스트 의미를 약화시키지 않고 보고한다.

## 범위와 한계

- query key, pagination, polling cadence, auth/cache mutation callback, scope generation, URL/ARIA tab/roving-focus 계약은 변경하지 않았다.
- route fixture와 real-backend software E2E는 Raspberry Pi/BlueZ/ESP32-H2/LED converter HIL을 대체하지 않는다.
