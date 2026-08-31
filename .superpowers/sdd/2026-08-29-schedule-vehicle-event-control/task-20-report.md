# Task 20 문서 현황, HIL 절차, 최종 검증 보고서

기준일: 2026-08-31

## 결론

- 상태: `DONE_WITH_CONCERNS`
- Task 19 production API/Gateway Chromium software E2E는 완료 상태를 유지한다. 실제 PostgreSQL, Redis, mTLS Mosquitto, production Gateway runtime과 private IPC test simulator를 사용한 검증이다.
- 실제 Raspberry Pi, BlueZ Mesh, ESP32-H2 RF, sensor electrical interface, LED converter interface HIL은 **미실행**이다. software E2E, native test, host fake, ESP-IDF target build는 HIL 완료 증거가 아니다.
- Task 20에서 HIL 수동 절차, 메뉴/프로젝트 상태, Gateway/firmware README와 계획 checkbox를 갱신했다.

## 대조한 정본

- 요구사항: `.superpowers/sdd/2026-08-29-schedule-vehicle-event-control/task-20-brief.md`
- 구현/검증 근거: Tasks 13~19의 Gateway automation·mesh, ESP32-H2 vehicle sensor driver/model, API/Web code와 `task-19-report.md`, `task-19-review.md`
- 문서 정본: `docs/menus/control.md`, `docs/project-status.md`, `apps/gateway/README.md`, `apps/esp32-h2-firmware/README.md`, `docs/superpowers/plans/2026-08-29-schedule-vehicle-event-control.md`

Task 19 review Fix Round 3의 최종 판정은 PASS이며, final HEAD fresh evidence는 mesh store `2/2`, RealBackendLab support `13/13`, Chromium `1 passed (47.5s, body 23.4s)`다. 이 증거는 BLE adapter와 sensor source를 software simulator로 교체한 software E2E 범위다. 실제 Pi/BlueZ/ESP32-H2 provisioning, RF packet loss, 재부팅/power-loss, GPIO electrical HIL은 계속 제외한다.

## 문서 갱신

- `docs/menus/control.md`: `구현 완료`, `미구현`, `부족하거나 개선이 필요한 기능`, `관련 파일`, `갱신 규칙` 구조를 유지했다. API CRUD 저장과 Gateway `APPLIED`를 UI에서 분리하고, software E2E 완료와 HIL 미실행을 별도 상태로 명시했다.
- `docs/project-status.md`: Task 20 문서/최종 검증 결과, production firmware policy fail-closed와 HIL 미실행 경계를 추가했다.
- `apps/gateway/README.md`: 실제 sensor 3.3V Active High/GND/safe GPIO 실측부터 Gateway deploy/ESP production flash, provisioning/AppKey/model binding, rule applied, High/Low/5초 hold/retrigger, cloud 단절, Gateway/ESP restart, telemetry replay까지 순서 고정 HIL runbook을 추가했다. 각 단계는 명령, 성공/실패 판정, 보존할 증거를 포함한다.
- `apps/esp32-h2-firmware/README.md`: test build와 production flash boundary, HIL 미실행 상태, DIM/보조전원 직접 연결 금지 및 승인된 절연/레벨시프팅 회로만 사용한다는 강한 경고를 추가했다.
- `docs/superpowers/plans/2026-08-29-schedule-vehicle-event-control.md`: Task 20 Step 1~4를 체크했다.

## 최종 검증

### 최초 실행과 원인 수정

처음 요구 명령을 clean HEAD에서 실행했다.

```bash
git status --short && pnpm typecheck && pnpm test && scripts/esp32-h2-build.sh
```

`pnpm typecheck`가 `packages/shared/dist/automation-contracts.d.ts`의 `unlink ENOENT`으로 중단됐다. root recursive typecheck에서 Web과 automation-engine이 각각 `@led-control/shared build`를 병렬 실행하며 동일 shared `dist`와 manifest의 cleanup/재생성을 동시에 수행한 것이 원인이다. Task 19 보고서에도 같은 경쟁이 code 변경 없이 재실행하면 통과한 것으로 기록돼 있었으나, Task 20 요구의 실제 실행에서 다시 재현됐다.

TDD 최소 수정:

1. `package-exports.test.ts`에 기존 manifest가 있는 동일 output directory의 concurrent build를 barrier로 동기화하는 테스트를 추가했다.
2. 수정 전 focused test는 `dist/esm/index.d.ts` unlink `ENOENT`로 RED를 확인했다.
3. `build.mjs`에서 TypeScript compile 뒤 `dist`/manifest를 변경하는 구간만 process lock으로 직렬화했다. lock 대기는 60초 뒤 fail-closed한다.
4. focused test GREEN, shared test `134 passed`, root `pnpm typecheck` 성공을 확인했다.

수정은 문서 변경과 별도 커밋 `369e056 fix(shared): serialize output builds`로 남겼다.

### 수정 후 요구 명령

동일 명령을 code HEAD에서 다시 실행했다.

```bash
git status --short && pnpm typecheck && pnpm test && scripts/esp32-h2-build.sh
```

| 명령 | 결과 |
| --- | --- |
| `git status --short` | 출력 없음, 실행 시작 시 clean 상태 |
| `pnpm typecheck` | 성공, exit code `0` |
| `pnpm test` | 성공, root `15`, mobile `1`, shared `134`, automation-engine `28`, Web `352`, API `738` passed; API opt-in integration `161` skipped; Gateway `559` passed |
| `scripts/esp32-h2-build.sh` | exit code `1`: `production build requires CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID with the owner's decimal Bluetooth SIG ID` |

마지막 firmware 결과는 구현 결함으로 처리하지 않았다. production script는 자사 Bluetooth SIG Company ID, fixed trust policy와 signed manufacturing approval을 요구하며 현재 policy는 `unprovisioned`다. 이를 우회해 test-build image를 HIL에 flash하지 않는다. signed production 자료가 준비된 별도 HIL 실행에서만 production build/flash를 수행한다.

## HIL 경계와 다음 증거

HIL runbook은 아직 실행하지 않았다. 다음 증거가 한 시험 디렉터리에 함께 있어야만 HIL 통과로 판정한다.

- sensor idle/active voltage, GND continuity, safe GPIO, approved isolation/level-shifter 회로 ID의 실측 기록
- Gateway health/deploy log, signed production firmware flash/serial log, board serial과 attestation hash
- provisioning/AppKey/model binding Config Status, source Sensor Get/Status와 target Lightness Status
- `APPLIED` revision/hash, High/Low/5초 hold/retrigger 시간표, vendor ACK와 execution telemetry
- cloud cut 전후 state/log, Gateway/ESP restart 복구 기록, execution event와 API ingested ACK의 exact identity/hash 대조

이 기록이 생기기 전까지 실제 HIL 상태는 `미실행`이며, 메뉴 문서와 프로젝트 상태판의 완료 범위는 software 구현/검증으로만 해석한다.
