# 전수 코드 검토·고위험 구조 관문·최종 검증 실행 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사전 표본/소규모 정리에 그치지 않고 전체 포함 파일의 실제 검토와 필요한 구조 정리, 최종 회귀 판정을 완료한다.

**Architecture:** Q1은 inventory의 모든 파일을 단일 담당 묶음에 배정한다. Q2는 사전 근거가 부족한 큰 파일의 구체적인 분리 경계·검증을 먼저 확정한다. Q3는 최종 소스와 원장을 대조하며 검토 완료와 테스트/HIL 성공을 분리한다.

**Tech Stack:** F1–F3 원장/품질 gate, 기존 unit·HTTP/DB·Playwright·C host·shell 계약 테스트.

**Spec:** [설계](../specs/2026-10-17-service-clean-code-design.md), [총괄 계획](2026-10-17-service-clean-code.md).

## Global Constraints

총괄 Global Constraints·공통 종료 절차를 모두 적용한다. 전수 검토를 file count/regex 검색으로 대체하지 않는다. 운영 DB·실제 broker/서버·USB·PKI·펌웨어 flash/배포·클라우드 작업은 금지하고 자기 소유 software fixture만 사용한다. timeout/보안/제조 관문을 완화하지 않는다.

## Review Focus

- 큰 묶음/상위 폴더 밖 파일 누락 → Q1의 단일 귀속·누락0과 F1 회귀.
- 실제 instance/type·동적 경로·과거 버전 복구를 미사용으로 오인 → Q1/Q2의 삭제 근거와 기존 계약 회귀.
- 권한/clock·lock/commit/ACK·fsync/unknown 의미 변화 → Q2 경계 표와 covering.
- 새 소스와 다른 해시의 과거 PASS 재사용 → Q3의 최종 source/evidence 대조.
- 테스트 실패/skip·포트 경합·실기기 미확인을 성공으로 합침 → Q3의 별도 counts/자원 정리·한계 판정.

## Task Q1: 모든 파일의 실제 검토와 cohort 정리

**Files:** Modify `docs/quality/clean-code-review.json`, 각 cohort의 명시 파일과 해당 메뉴/README. 초기 실행에서 다음 분류를 inventory의 정확한 경로 목록으로 동결한다. 표의 폴더는 분할 기준이지 재귀 전체 수정 허용이 아니다.

| 담당 묶음 | 포함 책임 |
| --- | --- |
| Web W1 | api·App/entries·auth/setup/shells/mobile |
| Web W2 | components/ui·brand·styles/theme/tokens |
| Web W3 | registration/settings/operator |
| Web W4 | control·automation·target selection·명령 복구 |
| Web W5 | monitoring/statistics |
| Web W6 | floor-map/floor-editor |
| Web W7 | cad-scene/map-scene/rf |
| Web W8 | landing/public·scripts/config/container·e2e/support와 남은 Web 파일 |
| Mobile M | WebShell/native bridge·권한/인증·테스트·설정 |
| API A1 | access/auth/pki/gateway-onboarding/operator-site-admins/site-users/landing-inquiries/audit |
| API A2 | fixtures/registration/fixture-identify/fixture-groups/mesh-control-groups/commands/temporary-controls |
| API A3 | mqtt/automation/monitoring-activity/monitoring-incidents/monitoring-refresh |
| API A4 | floor-editor/floor-import/floor-map/assets/storage |
| API A5 | energy/retention/sites/site-settings/setup/test-data |
| API A6 | observability/prisma/redis/http·src 직하·test/prisma/scripts·설정/도구와 남은 API 파일 |
| Shared S | package exports·schemas/contract·빌드/lock·packed 소비 회귀 |
| Engine E | recurrence/overlap/calendar/holiday exclusions·DST/overnight·테스트 |
| Gateway G1 | index/gateway/bootstrap/preflight·config/identity/health/MQTT/runtime 조립 |
| Gateway G2 | commands/state/storage/automation·journal/outbox/recovery/종료 |
| Gateway G3 | adapters/BIO/Mesh·protocol/owner/readback/transport 수명 |
| Gateway G4 | scripts/Docker/Compose/release·fixture/support와 남은 Gateway 파일 |
| Firmware C | C/H·ESP-IDF 설정·host/fake/native 계약·README |
| Root T | root scripts/config·infra/tests/.github·연결 문서와 남은 추적 대상 |

**Interfaces:** F1의 `ReviewLedger`/`verifyReviewLedger`를 사용한다. 각 파일은 정확히 한 묶음에 속한다. 파일 묶음은 한 번에 검토 가능한 명시 목록으로 잘라 담당자가 실제 읽고, 정책 ID별 판단과 검증을 기록한다. 테스트/fixture도 제품 소비 경계와 함께 검토한다.

- [ ] **단일 귀속:** 각 파일 목록의 합집합이 포함 inventory와 같고 교집합/미귀속은0인지 `pnpm quality:coverage`로 확인한다. 새 파일은 즉시 재귀속하고 protected/생성물은 사유를 남긴다.
- [ ] **실제 검토:** 각 cohort마다 책임·변경 이유·중복의 의미·타입/입력·오류·자원 수명·안전 주석·공개/동적 진입점을 읽어 `유지/수정/예외/설계 필요`를 결정한다. 길다는 이유만으로 나누거나 현재 미지원이라는 이유만으로 삭제하지 않는다.
- [ ] **작은 정리:** 확정 가능한 수정은 같은 소유 범위에서 정확한 파일/함수/covering을 task note에 먼저 정한다. R 계획과 같은 RED/covering→최소 변경→GREEN→독립 검토→공통 종료 절차를 적용한다. 고위험/경계 변경은 Q2로 넘긴다.
- [ ] **형식 전환:** 의미 수정 커밋과 분리해 명시한 파일만 포맷하고 token/문자열·directive·주석·schema 결과가 바뀌지 않았는지 diff와 관련 회귀를 확인한다. 완료 파일은 formatStatus=done, 기존 위반은 해결하거나 근거 있는 예외로 분리하고 해당 baseline만 축소한다.
- [ ] **묶음 종료:** 해당 package의 전체 unit·typecheck와 직접 영향 UI/DB/자원 회귀를 확인한다. 미변경 파일에 불필요한 테스트를 새로 만들지 않는다. 소스 해시가 변한 기록은 재검토하고 `quality:complete`의 잔여 건수를 감소 추적으로만 보고한다.

## Task Q2: 고위험 파일의 구체 경계와 covering 관문

**Files:** 대상 후보 `apps/gateway/src/index.ts`, `src/automation/automation-state-store.ts`, `src/bio/bio-dongle-client.ts`; `apps/api/src/mqtt/mqtt.service.ts`, `src/pki/gateway-certificate.service.ts`; Web CAD renderer/worker 및 복합 화면. 결과 설계/covering 목록은 이 계획의 해당 후보 아래에 append하고 원장 entry로 연결한다. 미리 정하지 않은 새 handler 파일을 임의 생성하지 않는다.

**Interfaces:** 후보별 `현재 호출자/입력/반환/throw·오류/외부 부작용/소유 세대/내구 기록/종료/검증` 표를 산출한다. 실제 이동 전에 새 파일 경로와 함수 signature·의존성·불변 조건·실행할 정확한 test를 채운 하위 task를 검토받는다. 이 관문 전에는 큰 구조 구현을 시작하지 않는다.

- [ ] **Gateway state/runtime/BIO:** removal fence 이전 recovery 순서, schemaVersion1~10, ENOSPC·불확정 commit, 전역 operation queue·취소 후 descriptor 세대·독립 readback·durable intent/native write를 기존 테스트와 대응한다. 부족한 실제 연결 covering을 먼저 추가한다. 순수 parser/조립 이동으로 불변을 지킬 수 있을 때만 구현한다.
- [ ] **API MQTT:** `mqtt.service.spec.ts`, `mqtt-v2-state.spec.ts`, `mqtt-shutdown-coordinator.spec.ts`, `provisioning-device-terminal.service.spec.ts`와 실제 terminal integration으로 transaction·queue permit·receivedAt·topic scope·PUBACK/commit/애플리케이션 ACK·shutdown 순서를 고정한다. mocking으로 순서를 합성해 실제 소비 경계 검증을 대체하지 않는다.
- [ ] **PKI 타입 pilot:** `gateway-certificate.service.ts`의 `db(): any`를 실제 PrismaService로, `assertCurrentIdentity(tx: any,...)`를 `Prisma.TransactionClient`로, transaction callback은 생성 타입 추론으로 바꿀 수 있는지 고정한다. 기존 `gateway-certificate.service.spec.ts`, controller spec, `certificate-revocation-reconciliation.service.spec.ts`, 자기 소유 DB의 `certificate-concurrency.integration.spec.ts`로 inventory→certificate lock·서명 전후 재인가·독립 revocation 원장·CA 지연/실패를 검증한다. 테스트 double의 넓은 cast로 오류를 감추지 않는다.
- [ ] **CAD/복합 UI:** GPU/worker/tile·listener/RAF 자원 정리, camera/lease/dirty·scope와 화면 동일성을 covering한다. `test:cad-webgl`, editor·monitoring 관련 회귀를 실행할 독립 포트/자원과 정확한 spec를 하위 task에 고정한다.
- [ ] **관문 판정:** 유지가 정당하면 구체 근거로 keep, 최소 분리가 안전하면 검토된 하위 task로 구현한다. 실제 동작/권한/저장·wire 계약 변경이 필요하면 `needs_design`으로 남겨 사용자 별도 승인을 받는다. 구조 개선을 못 했다는 이유로 안전장치를 지우지 않는다. 미해결 중대 위반은 전체 완료를 차단한다.

## Task Q3: 최종 결합 검증과 인계

**Files:** 최종 원장·진단, `docs/clean-code.md`, 영향 `docs/menus/*.md`, 총괄 체크리스트·상태판. 제품 코드가 변하면 이 단계의 해당 검증 증거도 다시 확인한다.

**Interfaces:** 최종 보고는 소스 기준·원장 검토 수/미검토/예외·raw lint debt·새 위반·PASS/FAIL/SKIP·환경 미실행·자원 cleanup·독립 검토를 각각 구분한다.

- [ ] **정책/원장:** `pnpm quality:coverage`, `pnpm quality:complete`, `pnpm format:check`, `pnpm quality:check` → 누락/미검토/stale/미승인 예외/새 위반0. `quality:scan`의 잔여는 승인된 예외와 정확히 대응해야 한다. `needs_design` 중대 항목이 남으면 전체 완료로 표시하지 않는다.
- [ ] **canonical:** 동일 최종 소스에서 `pnpm lint`→`pnpm typecheck`→`pnpm test`→`pnpm build` 순차 실행한다. 실패하면 원 증거/후속 실행 여부를 남기고 새 회귀를 먼저 해결한다. test를 임의 시간으로 끊거나 전체 재시도로 최초 실패를 지우지 않는다.
- [ ] **UI:** 기존 mock Chromium의 등록/수동/스케줄·이벤트/맵/설정과 변경한 공개·모바일 표현을 확인한다. 기본 config는 `E2E_WEB_PORT=15274`, `reuseExistingServer:false`, one-worker로 자기 소유 Vite를 사용하고 점유 시 다른 서버를 종료하지 않는다. `test:cad-webgl`의15175/15176·public/landing 별도 config는 사전 포트 확인 후 직렬 실행한다. 320/390/1024/1440, 오류·빈 상태·지연·취소·권한 전환의 해당 covering을 확인한다.
- [ ] **UI 실행 목록:** `E2E_WEB_PORT=15274 pnpm --filter @led-control/web exec playwright test e2e/calm-operations-commissioning.spec.ts e2e/calm-operations-manual-control.spec.ts e2e/calm-operations-automation.spec.ts e2e/control-map-target-selection.spec.ts e2e/monitoring-control-flow.spec.ts e2e/settings-floor-editor.spec.ts e2e/floor-editor-layout.spec.ts --project=chromium --workers=1`을 사용한다. 변경한 공개 화면은 별도 `e2e:landing` config에서 확인하고 새 UI 경계 회귀가 필요하면 Q2 하위 task의 정확한 목록으로 더한다.
- [ ] **실제 software Lab:** 기본 PG15432/Redis16379/MQTT18883/API14000/Web15173 및 `E2E_LAB_*_PORT`의 실제 설정값이 모두 미사용인지 먼저 확인하고 `E2E_REAL_BACKEND_LAB=1 pnpm ci:real-backend` 및 `E2E_REAL_BACKEND_LAB=1 pnpm --filter @led-control/web exec playwright test e2e/automation-control-flow.spec.ts --project=chromium --workers=1`을 순차 실행한다. 기존 helper의 내부 prepare/build·ownership·cleanup을 유지하고 운영 URL은 주입하지 않는다. 설치·등록·제어의 fake RF software 증거이며 실제 LED/HIL은 아니다.
- [ ] **DB/계약:** F/R/Q에서 변경한 API 경계의 integration spec를 자기 소유 PG/Redis URL에서 in-band 실행한다. 먼저 대상 identity와 전체 migration 적용을 확인하고 중앙 DB는 사용하지 않는다. Gateway `test:contracts`, Shared packed CJS/ESM·build/export, root CI/lock/보안 계약을 확인하며 실제 통합이 skip되면 별도 미검증으로 남긴다.
- [ ] **펌웨어/도구:** 변경된 shell은 `bash -n`·기존 Node 계약 테스트, C 변경은 기존 warning-as-error host test와 `test/identify_fake/test_identify_host.sh`, `test/host_fake/test_vehicle_sensor_host_fake.sh`를 사용한다. 필요한 target build는 자기 소유 `ESP32_H2_BUILD_WORKDIR`·SDK staging에서 `scripts/esp32-h2-build.sh --test-build`만 사용하고 다른 작업의 SDK/산출물은 수정하지 않는다. ESP-IDF 부재는 미실행으로 보고하고 Company ID/제조/서명 관문을 우회하거나 flash하지 않는다.
- [ ] **마무리:** 최종 inventory와 원장, 공개 export·wire/JSON/hash·메뉴 경로·보호 소스/사용자 WIP를 대조한다. 자신의 테스트 자원만 정리하고 cleanup 실패를 남긴다. 독립 whole-branch 검토의 지적을 해결한 뒤 총괄이 전수 검토/자동검증/실기기 한계를 각각 보고한다. 사용자 승인 없이 merge/push·현재 서비스 재기동·Pi 배포는 하지 않는다.
