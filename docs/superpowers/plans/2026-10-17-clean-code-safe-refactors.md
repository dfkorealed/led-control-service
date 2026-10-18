# 확정된 소규모 클린 코드 정리 실행 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 근거가 확인된 함수·타입·순수 변환 경계를 작게 정리하면서 실제 입출력과 실패·수명 계약을 보존한다.

**Architecture:** 패키지 내부 helper부터 추출하고 공유 계약은 기존 export를 재노출한다. effect·transaction·wire와 I/O orchestration은 이 단계에서 이동하지 않는다.

**Tech Stack:** 기존 TS/React/NestJS/Prisma/Vitest/Jest, F1–F3 품질 도구.

**Spec:** [설계](../specs/2026-10-17-service-clean-code-design.md), [총괄 계획](2026-10-17-service-clean-code.md).

## Global Constraints

총괄 Global Constraints·공통 종료 절차를 모두 적용한다. F1–F3가 선행이다. 모든 leaf 명령 전 해당 checkout에서 `pnpm workspace:prepare`를 순차 실행한다. 기존 단언·timeout·공개 경로와 raw 값은 유지하며 formatter-only 변경은 별도 커밋이다.

## Review Focus

- timeout 뒤 늦은 성공/실패와 timer → R1.
- P2002 모양만 같은 객체·null과 null/빈값·숫자 문자열·URI → R2/R4.
- strict 등록 입력·동일 schema 객체·CJS/ESM → R3.
- UUID 원 spelling·UTC 정밀도·미수신 network 상태 → R5/R6.
- 오래된 identify revision·알 수 없는 제어 오류·touch cancel → R7/R8.

## Task R1: Gateway publish timeout 중복 제거

**Files:** Create `apps/gateway/src/runtime/publish-timeout.ts`, `publish-timeout.test.ts`. Modify `src/automation/automation-telemetry-outbox.ts`, `automation-config-ack-outbox.ts`, `src/state/state-event-outbox.ts` (모두 Gateway 기준).

**Interfaces:** `withPublishTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T>`. 원 Promise를 취소하지 않고 값/오류 identity를 유지한다.

- [ ] **RED:** 새 test에 `expect(await withPublishTimeout(Promise.resolve(value), 10, "deadline")).toBe(value)`와 reject identity, fake timer10ms의 정확 메시지, settle 후 timer0, timeout 후 늦은 resolve/reject의 취소/미처리 오류0을 단언한다.
- [ ] **RED 실행:** `pnpm --filter @led-control/gateway exec vitest run src/runtime/publish-timeout.test.ts --maxWorkers=1 --minWorkers=1` → 모듈/함수 부재 실패.
- [ ] **구현:** 기존 body만 옮기고 세 caller가 각각 `automation telemetry publish timed out after ${timeoutMs}ms`, `automation config ACK publish timed out after ${timeoutMs}ms`, `state event publish timed out after ${timeoutMs}ms`를 전달한다. AbortSignal·validation·unref·retry를 추가하지 않는다.
- [ ] **GREEN:** 위 파일과 `src/automation/automation-telemetry-outbox.test.ts`, `automation-config-ack-outbox.test.ts`, `src/state/state-event-outbox.test.ts`를 같은 one-worker Vitest 명령으로 실행하고 Gateway typecheck를 확인한다. 공통 종료 절차, 커밋 `refactor(gateway): share publish timeout without cancellation`.

## Task R2: 정확히 같은 Prisma 오류 predicate만 통합

**Files:** Create `apps/api/src/prisma/prisma-errors.ts`, `prisma-errors.spec.ts`. Modify `src/energy/fixture-state-ingestion.service.ts`, `src/fixtures/fixture-presence-ingestion.service.ts`, `src/automation/automation-mqtt-consumer.service.ts` (API 기준).

**Interfaces:** `isUniqueConstraintError(error: unknown): error is Prisma.PrismaClientKnownRequestError`는 실제 instance이며 code가 `P2002`일 때만 true다.

- [ ] **RED:** 실제 Prisma 오류 P2002는 true, 다른 code·`{code:"P2002"}`·null은 false라는 test를 작성한다. 예: `expect(isUniqueConstraintError({code:"P2002"})).toBe(false)`.
- [ ] **RED 실행:** `pnpm --filter @led-control/api exec jest src/prisma/prisma-errors.spec.ts --runInBand` → 부재 실패.
- [ ] **구현:** 세 동일 predicate만 새 모듈을 소비한다. 일반 객체도 받는 `mqtt.service.ts`·`auth.service.ts`의 동명 함수는 그대로 둔다.
- [ ] **GREEN:** 새 spec과 `src/energy/fixture-state-ingestion.service.spec.ts`, `src/fixtures/fixture-presence-ingestion.service.spec.ts`, `src/automation/automation-mqtt-consumer.service.spec.ts`를 Jest in-band로 실행하고 API typecheck. DB 중복 event 회귀는 Q3의 자기 소유 DB에서 확인한다. 공통 종료, 커밋 `refactor(api): share exact Prisma unique error predicate`.

## Task R3: shared 등록 세션 계약의 작은 이동

**Files:** Create `packages/shared/src/registration-session-contracts.ts`, `registration-session-contracts.test.ts`. Modify `src/schemas.ts`, `src/package-exports.test.ts`. Existing tests `src/schemas.test.ts` (Shared 기준).

**Interfaces:** `createRegistrationSessionSchema`, `CreateRegistrationSessionInput`, `identifyRegistrationNodeInputSchema`의 이름·schema 객체·parse 의미를 유지한다. 새 내부 파일은 zod만 의존하고 `schemas.ts`에서 schema/type을 재노출한다. root package export는 기존 경로를 유지하며 새 subpath는 추가하지 않는다.

- [ ] **RED:** 같은 CJS 또는 ESM 모듈 그래프 안에서 새 내부 경로와 기존 schemas/root의 객체 `toBe` identity, site/floor/gateway 필수·extra key 거부, identify `{}` 성공·duration/raw packet 거부·동일 Zod issue path를 검증한다. packed CJS `require`와 ESM `import`에서도 세 export에 접근하는 검사를 추가하되 서로 다른 모듈 그래프 사이의 객체 identity는 요구하지 않는다.
- [ ] **RED 실행:** `pnpm --filter @led-control/shared exec vitest run src/registration-session-contracts.test.ts` → 새 경로 부재 실패.
- [ ] **구현:** 해당 선언·주석만 이동하고 기존 공개 타입을 보존한다. `registerFixtureBatchSchema`와 공통 int4/energy 계약은 이동하지 않는다.
- [ ] **GREEN:** Shared build→새 test/`schemas.test.ts`/`package-exports.test.ts`, API/Web/Mobile/Gateway typecheck를 순차 실행한다. 공통 종료, 커밋 `refactor(shared): isolate registration session contracts` 뒤 소비자 작업을 재개한다.

## Task R4: Floor editor 순수 입력 값 분리

**Files:** Create `apps/api/src/floor-editor/floor-editor-input-values.ts`, `floor-editor-input-values.spec.ts`. Modify `floor-editor.service.ts`. Tests `floor-editor.service.spec.ts`, `editor-http.spec.ts` (동일 폴더).

**Interfaces:** export `floorAssetAccessPath(value: unknown, field: string): {floorId:string;assetId:string;path:string}`, `finiteNumber(value: unknown, field: string): number`, `decimalString(value: unknown, field: string): string`. 내부 trim helper는 private 함수로 이동한다. 기존 `BadRequestException`의 메시지를 보존한다.

- [ ] **covering/RED:** 기존 서비스 public 경로의 대응 입력/오류를 먼저 고정한다. 새 helper test는 숫자 문자열·NaN/Infinity·음수·빈문자·공백, URI `%` 오류/비정규 인코딩, `expect(decimalString("", "ratedWatt")).toBe("0.00")`와 `finiteNumber("1", "x")`의 거절을 단언한다. 단위/상식에 맞춘 새 제한을 넣지 않는다.
- [ ] **RED 실행:** `pnpm --filter @led-control/api exec jest src/floor-editor/floor-editor-input-values.spec.ts --runInBand` → 부재 실패.
- [ ] **구현/GREEN:** 세 메서드만 같은 helper 호출로 바꾸고 해당 새/기존3개 spec을 Jest in-band, API typecheck로 확인한다. save/lease/lock/revision/audit는 이동하지 않는다. Q3에서 `floor-editor.integration.spec.ts` 확인. 공통 종료, 커밋 `refactor(api): extract floor editor input values`.

## Task R5: Monitoring API validator의 타입 연결

**Files:** Modify `apps/web/src/api/monitoring-incidents.ts`, `monitoring-incidents.test.ts`. 새 validation 모듈은 만들지 않는다.

**Interfaces:** public `listMonitoringIncidents`, `dismissMonitoringIncident`, `dismissAllMonitoringIncidents`, `markMonitoringIncidentRead`의 입력/반환/URL/body/오류 문구를 유지한다. 내부 `isIncident(row:unknown,siteId:string): row is MonitoringIncident`, `isActor(value:unknown): value is IncidentActor|null` 등 predicate와 각 응답 parser로 이중 단언을 없앤다. parser는 기존 검증식을 그대로 사용하며 받은 객체·추가 필드를 삭제하거나 원 spelling을 바꾸지 않는다.

- [ ] **covering:** 기존 UUID spelling/version 제한 없음·strict dismissal body·canonical unread count·UTC precision 회귀를 실행한다. 추가 test는 read receipt의 허용 extra 필드와 dismissal의 금지 extra 필드, impossible date·readAt/isRead 불일치 거절, site A 응답을 B에 거절하는 계약을 단언한다.
- [ ] **검증 전 실행:** `pnpm --filter @led-control/web exec vitest run src/api/monitoring-incidents.test.ts`로 현재 covering을 확인한다. 없던 경계 회귀는 기존 body에 통과하는 characterization이며 실패하지 않은 것을 RED라 부르지 않는다.
- [ ] **구현/GREEN:** 검증 의미를 바꾸지 않고 타입 predicate/parser만 도입한다. 같은 test·Web typecheck·품질 검사 PASS, public export 차이0. 공통 종료, 커밋 `refactor(web): type monitoring incident validation boundaries`.

## Task R6: Mobile 초기 network 실패의 명시적 fallback

**Files:** Modify `apps/mobile/src/WebShell.tsx`, `src/WebShell.test.tsx`, `src/test/network-mock.ts`. Existing `src/WebShell.ios-focus.test.tsx` 유지.

**Interfaces:** public bridge/lifecycle와 `updateOnline(connected,reachable)` 조건은 그대로다. mock은 초기 조회 resolve/reject와 listener notification을 test에서 제어하고 test 간 reset한다. 별도 runtime hook은 만들지 않는다.

- [ ] **covering:** `initial network rejection preserves optimistic online until listener update` test를 추가한다. reject 뒤 online=true·오류/새 bridge generation0, 이후 false/false listener 뒤 offline, unmount 뒤 listener 영향0을 단언한다.
- [ ] **기준 실행:** `pnpm --filter @led-control/mobile exec jest src/WebShell.test.tsx src/WebShell.ios-focus.test.tsx --runInBand`로 기존 동작 확인. mock 확장 실패와 제품 실패를 구분한다.
- [ ] **최소 정리/GREEN:** catch에서 “초기 online 유지, 기존 listener 후속 갱신, disposed 차단” 이유를 설명한다. 새 오류 UI/재시도를 추가하지 않는다. 같은 tests·Mobile 자체 typecheck PASS 후 공통 종료, 커밋 `refactor(mobile): document network bootstrap fallback`.

## Task R7: 등록 progress와 제어 오류 정책의 순수 추출

이 작업은 **R7a 등록→검토/커밋→R7b 제어→검토/커밋**의 독립 두 단위로 실행한다. 같은 Web writer가 맡고 한꺼번에 effect를 분리하지 않는다.

**R7a Files/Interfaces:** Create `apps/web/src/features/registration/registration-node-progress.ts`, `registration-progress-steps.ts`. Modify `RegistrationPanel.tsx`, test `RegistrationPanel.test.tsx`. 전자는 `markNodesProvisioning`, `replaceNode`, eligibility/registerable predicates, `shouldPollRegistrationSession`, `mergeRegistrationNodeLists`, `mergeRegistrationNodeProgress`, `currentScanNodes`를 기존 parameter/return 그대로 export한다. 후자는 `registrationSteps(session:RegistrationSession,nodes:DiscoveredRegistrationNode[]):ProgressStep[]`, `reachableRegistrationStepStates(...):ProgressStepState[]`, `registrationStepStates(states:readonly ProgressStepState[]):ProgressStep[]`와 initial steps를 소유한다. 기존 public helper는 Panel에서 재노출한다.

- [ ] 기존 test에 이전 operation terminal/revision은 retry를 끝내지 못함, 동일 operation 최신 terminal만 수용, scan attempt 불일치 거부, provisioning 비강등·polling 중지/재시작을 고정한다. `pnpm --filter @led-control/web exec vitest run src/features/registration/RegistrationPanel.test.tsx`로 covering을 확인한다.
- [ ] 순수 함수·타입·상수·안전 주석만 이동하고 query/mutation/effect/아이콘 JSX는 그대로 둔다. 같은 test·Web typecheck/UI policy PASS 및 기존 import identity/표현 동일 확인 후 공통 종료, 커밋 `refactor(web): isolate registration progress policy`.

**R7b Files/Interfaces:** Create `apps/web/src/features/control/command-error-policy.ts`, `command-error-policy.test.ts`. Modify `ControlView.tsx`. `isCommandExpiredError`, `isMissingCommandError`, `isDefinitiveCommandRejection`, `isSafetySensitiveCommandError`, `isPreAdmissionDimmingRejection`, `commandErrorCode`, `safetyRejectionCaseId`, `definitiveRejectionMessage`의 기존 signature/본문만 이동한다. `instanceof ApiError`로 구조적 입력 수용 범위를 바꾸지 않는다.

- [ ] 직접 test에서 알려진 pre-admission409만 definitive, unknown409/410·전송 실패는 기존 safety policy 유지, 오류 code/caseId/메시지 동일을 고정한다. 신규 모듈 import 부재 RED 확인 후 함수만 추출한다.
- [ ] `pnpm --filter @led-control/web exec vitest run src/features/control/command-error-policy.test.ts src/features/control/ControlView.test.tsx`와 타입/UI 정책을 확인한다. 기존 ControlView 실패는 동일 baseline과 구분하고 새 실패는 해결한다. 공통 종료, 커밋 `refactor(web): isolate command error policy`.

## Task R8: Floor editor 입력 타입만 최소화

**Files:** Modify `apps/web/src/features/floor-editor/FloorEditorCanvas.tsx`, `FloorEditorView.test.tsx`. 필요 시 같은 폴더 `floor-editor-gesture-input.test.tsx` 신규 covering만 추가한다.

**Interfaces:** `type EditorGestureInput = Pick<MouseEvent<HTMLDivElement>, "clientX"|"clientY"|"target"|"button"|"shiftKey"|"detail"|"preventDefault">`를 파일 내부에 둔다. `begin/move/finish` 입력을 실제 소비 필드로 좁히고 touch의 `as unknown as MouseEvent` 3개만 제거한다. gesture hook·camera 알고리즘은 분리하지 않는다.

- [ ] 기존 mouse/Space/middle-button·shift marquee·double click, touch tap/drag/pinch 전환·마지막 release·pointercancel 원복·capture/RAF 정리·readOnly를 mapping한다. 부족한 covering은 먼저 추가하고 `FloorEditorView.test.tsx`의 touch 배치 회귀를 유지한다.
- [ ] 변경 전 covering 실행→타입 변경→같은 tests와 Web typecheck. React pointer의 구조 호환이 성립하지 않으면 새로운 광범위 cast/adapter로 우회하지 않고 Q2의 설계 필요 항목으로 돌린다.
- [ ] 통과하면 공통 종료, 커밋 `refactor(web): narrow editor gesture event input`. gesture의 실행 결과가 바뀌면 이 pilot은 완료로 표시하지 않는다.
