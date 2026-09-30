# BIO 센서 펄스 기반 이벤트 제어 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A의 내부 센서 모드를 유지하며 검증된 A의 BIO 펄스로 B의 이벤트 밝기와 유지시간을 제어하는 소프트웨어를 만들고, A의 자체 밝기 반응은 별도 광학 HIL로 확인한다.

**Architecture:** 기존 BlueZ 상태형 입력은 V1 의미로 유지하고, BIO의 펄스 입력은 명시적인 V2 protocol 분기로 추가한다. Gateway는 검증된 프레임·신원·독립 링크 건강이 갖춰진 펄스만 받아 durable occurrence와 monotonic 만료를 관리하고, API는 버전 협상·source 보호·capability를 담당하며, Web은 준비 상태와 프로토콜별 유지시간을 보여준다. 실제 A/B 제어는 소프트웨어·shadow HIL·운영 정책·현장 승인을 모두 통과한 뒤에만 켠다.

**Tech Stack:** TypeScript, Zod, Vitest, NestJS/Jest, Prisma/PostgreSQL, React/Testing Library/Playwright, BIO USB, MQTT.

**Spec:** `docs/superpowers/specs/2026-09-30-bio-sensor-pulse-event-control-design.md`

## Global Constraints

- BIO `holdSeconds`는 정수 **10~1,800초**, 기본 **60초**; BlueZ는 기존 **5~1,800초**, 기본 **60초**를 유지한다.
- A의 BIO `sensor` 모드와 `0x09` 보고의 공존은 확인됐지만 A의 자체 밝기 반응은 **광학 미검증**이다. A로 일반 밝기·식별 명령을 보내지 않는다. B만 서비스 이벤트 대상이다. `CD 13` raw 밝기 변경이 `sensor` 동작을 보존하는지도 미검증이므로 A 밝기 설정 UI/명령은 별도 HIL·설계 전까지 넣지 않는다.
- `0x09`는 검증 전까지 펄스 **후보**다. `0x0c`는 움직임/해제가 아니며 `clear`를 합성하지 않는다. 2026-09-30 단일 시험은 `physicalTimingVerified=false`다.
- 기존 V1 strict snapshot/ACK를 조용히 확장하지 않는다. V2를 별도 schema로 추가하고, 미지원 Gateway에 BIO 규칙을 보내거나 적용 성공으로 기록하지 않는다.
- BIO capability는 기본 **OFF**다. 검증된 fingerprint·identity·독립 liveness·반복 shadow HIL·현장 운영 정책 없이는 `supported`로 발행하지 않는다.
- 센서 침묵은 `clear`가 아니다. USB/신원/링크가 불확실하면 새 트리거와 건강 만료를 멈추고 degraded 상태 및 운영자 해제 경로를 제공한다.
- 보통 로그/MQTT에는 raw body·native UUID·자격 증명을 담지 않는다. 실제 Pi 변경·B 점등·인증서/DB 운영 변경은 별도 현장 승인 관문이다.
- 새 checkout의 leaf 명령 전 `pnpm workspace:prepare`로 shared→automation build 산출물을 준비한다. 최종 검증은 root canonical gate를 사용한다.
- 공유 계약은 총괄 승인 아래 단일 담당 역할이 먼저 변경하고 커밋한다. Gateway→API/DB→Web 소비자는 그 커밋 이후 순서대로 진행한다. 각 구현 커밋에 영향 메뉴 문서를 함께 갱신한다.

## Review Focus

1. `0x09`가 잘린 프레임·오인된 UUID/주소·다른 firmware에서 오면 B가 켜지지 않고 capability가 OFF/재검증 필요로 남는가? → Task 2의 decoder/intake tests.
2. 8-bit sequence wrap, 재연결 뒤 지연 packet, 같은 packet 재전송에서 B의 유지시간이 잘못 연장되지 않는가? → Task 3의 receipt tests.
3. 활성 이벤트 중 사용자가 B의 밝기를 수동 변경하거나 다중 target 중 하나만 실패하면 낡은 사전값으로 덮지 않고 target별 결과를 남기는가? → Task 4의 lifecycle tests.
4. 규칙 생성 이후 그룹/층 구성 변경으로 A가 수동·스케줄·식별 대상에 뒤늦게 포함돼도 API와 Gateway 모두 차단하는가? → Task 6의 boundary tests.
5. V1 Gateway, MQTT 장애, 재시작 시각 불확실성, USB 장애에서 `applied`/정상 만료를 거짓 보고하지 않는가? → Tasks 1·4·5·8의 compatibility/recovery tests. A의 자체 밝기나 센서 안전 밝기 조절도 광학 HIL 전에는 완료로 표시하지 않는다(Task 7·9).

---

## File map 및 적용 순서

| 경계 | 변경 파일과 책임 |
| --- | --- |
| 공유 wire | `packages/shared/src/automation-contracts.ts`, `packages/shared/src/automation-contracts.test.ts`: V1 불변, V2 snapshot/ACK·protocol/hold 제약. `packages/shared/src/mqtt.ts`는 기존 topic 재사용 가능 여부를 검증한 뒤 바꿀 때만 수정한다. |
| BIO decode/intake | `apps/gateway/src/bio/bio-command-codec.ts`, `bio-dongle-client.ts`, 새 `bio-sensor-pulse-intake.ts`와 각 테스트: 후보와 allowlisted pulse 구분, ACK/read-back 비간섭, mapping/fingerprint/receipt/health. `apps/gateway/src/adapters/bio-sensor-capability-unavailable-port.ts`는 OFF fallback으로 유지한다. |
| Gateway occurrence | `apps/gateway/src/automation/vehicle-event-runtime.ts`, `schedule-runtime.ts`, `automation-state-store.ts`, `automation-runtime.ts`, `automation-config-store.ts`와 테스트: V2 분기, monotonic hold, 저널, degraded/restart, target별 mode·brightness 검증. 필요 시 `apps/gateway/src/bio/bio-dongle-client.ts`의 명시적 mode read-back port를 노출한다. |
| API/DB | `apps/api/prisma/schema.prisma`, 새 migration, `docs/database-schema.md`, `apps/api/src/automation/{automation-snapshot.service,vehicle-event-rules.service,vehicle-sensor-capability.service,target-snapshot.service}.ts`, DTO/테스트: BlueZ 보존 migration, protocol/ACK/readiness/저장 guard와 A sensor-mode 설정 요청의 durable 명령·결과·read-back 경계. `apps/api/src/commands/commands.service.ts`, `apps/api/src/automation/schedules.service.ts`, `apps/api/src/fixture-identify/fixture-identify.service.ts`와 테스트: 확장 후 A 대상 차단. |
| Web | `apps/web/src/api/{automation,queries}.ts`, `apps/web/src/features/control/automation/{vehicle-event-form,VehicleEventDialog,VehicleEventControlPanel}.tsx`와 테스트: source readiness, A sensor-mode 설정·확인, A/B 역할, protocol별 hold 경계, 장애/운영자 조치. 기존 공통 버튼·카드 재사용. |
| 통합/문서 | 관련 `apps/gateway/src/automation/software-automation-simulator.ts` 및 테스트, API integration/Playwright, `docs/menus/{control,settings,monitoring}.md`, `docs/project-status.md`: software/shadow/HIL을 구분해 기록. MQTT 현장 복구는 제품 코드와 별도 Task 9 운영 단계. |

### Task 1: V1을 보존하는 V2 공유 계약

**Files:** Modify `packages/shared/src/automation-contracts.ts`; Test `packages/shared/src/automation-contracts.test.ts`.

**Interfaces:** Produce `VehicleSensorProtocol = "bluez-stateful" | "bio-usb-pulse"`; `VehicleEventRuleSnapshotV2`에 `sensorProtocol`; `AutomationSnapshotV2`에 `schemaVersion: 2`; `AutomationConfigAppliedV2`에 `schemaVersion: 2`; 각각 독립 strict Zod schema. `vehicleEventRuleSnapshotV2Schema`는 `sensorProtocol`에 따라 hold 하한 5/10을 분기한다. 기존 V1 exports 및 schema는 불변이다. V2 capability report에는 protocol, 검증된 fingerprint 식별자와 `readiness: "off" | "shadow" | "ready" | "degraded"`를 명시하되 V1 BlueZ 보고서를 위조하지 않는다.

- [x] **Step 1: RED 테스트 작성.** V1 payload가 그대로 통과하고 V1에 V2 필드를 넣으면 실패, V2 BlueZ 5초와 BIO 10초·60초·1,800초 통과, BIO 9/1,801초 실패, 알 수 없는 protocol/추가 필드 실패, V1 ACK가 V2 ACK를 대신하지 못함을 단언한다.
- [x] **Step 2: RED 확인.** `pnpm --filter @led-control/shared exec vitest run src/automation-contracts.test.ts` → 새 V2 exports/분기 기대에서 실패.
- [x] **Step 3: 최소 구현.** V1 동작을 유지하고 위의 이름과 schema를 추가했다. V2 hash는 전체 V2 payload를 대상으로 하며 V1 hash 의미를 바꾸지 않는다.
- [x] **Step 4: GREEN·타입 확인.** 집중 34/34, Shared 전체 429/429, Shared typecheck 통과. Root 전체는 API CAD SVG RSS 1건 실패로 미통과이며 Task 8에서 재검증한다.
- [x] **Step 5: 공유 경계 검토·커밋.** 총괄이 Gateway/API/Web 필드명·적용 순서를 확인했고 공유 계약 `ededa5c9`와 ACK 중복 보완 `f3f0f4c5`를 독립 검토·재검토했다.

### Task 2: BIO 후보 packet의 안전한 decoder와 shadow intake

**Files:** Modify `apps/gateway/src/bio/bio-command-codec.ts`, `bio-dongle-client.ts`; Create `apps/gateway/src/bio/bio-sensor-pulse-intake.ts`; Test 동일 위치 `*.test.ts`; keep `apps/gateway/src/adapters/bio-sensor-capability-unavailable-port.ts` as OFF fallback.

**Interfaces:** Produce `BioSensorPulseCandidate` from the already CRC-checked outer `0x12`/inner `0x09`; `BioSensorPulseIntake.accept(candidate, mapping, profile, health): { accepted: boolean; reason: string; receivedMonotonicMs?: number }`. `profile`은 HIL에서 검증한 exact body length/fixed bytes/firmware·sensor fingerprint의 명시적 allowlist이며 현재는 **빈 목록**으로 시작한다. `0x0c`는 별도 health observation만 갱신한다. 일반 로그에는 reason code만 남긴다.

- [x] **Step 1: RED 테스트 작성.** 잘린/CRC 오류 프레임, inner `0x0c`, 다른 UUID·주소·network, allowlist 밖 fingerprint/body, 불건강 USB가 모두 `accepted=false`; 유효 fixture에서 profile을 시험 fixture로 명시 주입했을 때만 monotonic 수신시각을 가진 pulse를 방출; 비동기 `0x09`가 command ACK/GET read-back을 소비하지 않음을 확인한다.
- [x] **Step 2: RED 확인.** `pnpm --filter @led-control/gateway exec vitest run src/bio/bio-command-codec.test.ts src/bio/bio-dongle-client.test.ts src/bio/bio-sensor-pulse-intake.test.ts` → 새 intake 기대 실패.
- [x] **Step 3: 최소 구현.** 기존 USB client 한 개의 notification listener에서 후보를 전달하고, confirmed mapping의 native UUID/address/network 및 exact profile을 확인한다. 검증된 profile을 코드에 추측해 넣지 않는다. 현재 durable mapping에 network/fingerprint가 없어 intake 전용 검증 입력으로 한정한다.
- [x] **Step 4: GREEN·타입 확인.** 위 Vitest 195/195와 `pnpm --filter @led-control/gateway typecheck`, Gateway 전체 1,439/1,439 통과. 빈 allowlist의 제품 경로는 계속 OFF다. 후보 subscriber 예외가 같은 청크의 ACK/read-back을 막지 않는 회귀를 포함한다.
- [x] **Step 5: 커밋.** decoder/intake·테스트 `72d26ac4`, 후보 subscriber 예외 격리 `ae1d3de5`를 저장하고 독립 재검토했다.

### Task 3: 펄스 receipt·동일 occurrence 연장

**Files:** Modify `apps/gateway/src/automation/{vehicle-event-runtime,automation-state-store,schedule-runtime}.ts`; Test 대응 `*.test.ts`.

**Interfaces:** Extend `VehicleSensorInput` with `{ type: "pulse"; sourceFixtureId: string; receivedMonotonicMs: number; receipt: BioPulseReceipt }`; `BioPulseReceipt`는 native identity·8-bit sequence·connection epoch를 포함하며 exact duplicate만 짧게 억제한다. `VehicleEventRuntime.planRecordInput()`은 `sensorProtocol: "bio-usb-pulse"` 규칙에서 첫 pulse `vehicle_detected`+`event_started`, 후속 pulse `vehicle_detected`+`event_extended`와 `holdUntil=now+holdSeconds`를 만든다. BlueZ stateful path는 그대로다.

- [x] **Step 1: RED 테스트 작성.** 첫 BIO pulse가 activeSource를 붙잡지 않고 hold deadline 생성; 두 번째 pulse는 같은 occurrence를 연장; 10초·60초·1,800초 만료; BlueZ `detected` 뒤 `cleared` 전에는 만료 없음; 중복 receipt·늦은 연결 epoch packet은 연장 없음; `255→0` wrap과 재부팅은 정상 새 pulse를 영구 차단하지 않음을 단언한다. 독립 건강 판정과 재시작 후 full-hold 관찰은 Task 4에 남긴다.
- [x] **Step 2: RED 확인.** 지정 Vitest의 새 pulse 경로 11건 실패와 추가 경계 실패를 확인했다.
- [x] **Step 3: 최소 구현.** V6 reader를 유지한 V7로 migration하고 BIO receipt와 hold를 durable transition에 함께 기록한다. persisted monotonic/UTC hold를 재시작 후 BIO 만료 근거로 사용하지 않는다. 생산 scheduler의 두 진입점은 pulse를 명시적으로 거부한다.
- [x] **Step 4: GREEN·회귀 확인.** 지정 Vitest 139/139, Gateway 전체 1,457/1,457, Gateway typecheck 통과; 독립 검토 승인. 실제 건강·target 복원은 Task 4다.
- [x] **Step 5: 커밋.** pulse runtime·V7 state migration·테스트 `0ff260a4`를 저장했다.

### Task 4: 장애·재시작·대상별 mode 복원

**Files:** Modify `apps/gateway/src/automation/{vehicle-event-runtime,schedule-runtime,automation-state-store}.ts`, `apps/gateway/src/adapters/bio-usb-dongle-adapter.ts`; when needed `apps/gateway/src/bio/bio-dongle-client.ts`; Test corresponding `*.test.ts`.

**Interfaces:** `BioSourceHealth = "healthy" | "degraded" | "unverified"`; `ScheduleRuntime.setBioSourceHealth(sourceFixtureId: string, health: BioSourceHealth, reason: string): Promise<void>`. Durable target base stores `{ brightnessPercent: number; bioMode: "sensor" | "force-on" | "force-off" }` and per-target transition result; new source identity/revision mismatch rejects control. Explicit operator release is a distinct reason from `hold_expired`.

이 Task는 기존 V1-only 스케줄러, 밝기 전용 상태 원장, BIO mode 복원 포트의 선행 작업이 있어 **4a→4b→4c 순차 구현·각각 독립 검토**한다. 4c 승인 전까지 scheduler의 펄스 RF 경로는 OFF다.

- [x] **4a RED·GREEN: 건강/재시작 기계.** `f6e09f58`; 독립 health callback 기본 unverified, 연결 epoch/generation 및 연속 건강 구간 검증, 장애 시 hold freeze/새 pulse 거부, 회복 뒤 전체 hold 재관찰, 정상 만료와 operator_release 분리를 구현했다. 집중 156/156, Gateway 전체 1,474/1,474, typecheck와 독립 검토 통과. 실제 scheduler alert handoff는 4c, `0x09`/미검증 `0x0c`는 건강 증거로 사용하지 않는다.
- [x] **4b RED·GREEN: B별 밝기 설정+BIO mode 원상태와 adapter.** `98db8a0e`, 결함 보완 `298a9c9c`; V8 durable per-B 원상태·물리 identity·적용/복원 결과, 독립 GET 및 설정+mode 복원 helper를 구현했다. `sensor` 값은 구성된 high-brightness이며 광학 출력이 아니다. 여러 B 중 부분 실패/재시작/저장 실패/A 제외 테스트와, 원상태 미확인 B가 해제 뒤 늦게 켜지지 않도록 하는 회귀를 포함한다. 집중 334/334, Gateway 전체 1,502/1,502, typecheck와 독립 재검토 통과. 해제 기록의 durable commit 실패는 4c에서 완료로 취급하면 안 된다. Scheduler RF gate는 OFF다.
- [x] **4c RED·GREEN: V2 scheduler 결합과 수동 우선순위.** `ee412d5a`와 3회 안전 보완 `8fd06f2d`·`6ce596c6`·`7bc65eec`를 독립 재검토했다. 시험 전용 주입의 검증된 V2 snapshot/연결 건강/소스 권한과 durable pulse transaction 뒤에만 B를 제어한다. 첫 펄스·연장·건강한 만료·명시 해제·degraded 보류·수동 activation 억제·새 activation·대상별 read-back을 테스트했다. 대기열/복원 저장 중 도착한 pulse도 동일 activation의 수동 제외를 유지하며, 최신 schedule/base 우선순위와 재시도 사유를 보존한다. 집중 395/395, Gateway 전체 1,563/1,563, typecheck 및 독립 재검토 통과. 실제 제품 allowlist/capability는 OFF이고, V2 MQTT/ACK 및 중첩 event target arbitration은 Tasks 5/8의 후속이다.

### Task 5: API/DB versioning·capability OFF·snapshot ACK

**Files:** Modify `apps/api/prisma/schema.prisma`, `apps/api/src/automation/{automation-snapshot.service,vehicle-sensor-capability.service,vehicle-event-rules.service,target-snapshot.service}.ts`, DTO; Create `apps/api/prisma/migrations/<timestamp>_bio_pulse_event_contract/migration.sql`; Test corresponding Jest specs/integration; Modify `docs/database-schema.md` in same commit.

**Interfaces:** Add `VehicleEventRule.sensorProtocol: VehicleSensorProtocol` (`bluez_stateful | bio_usb_pulse`, default `bluez_stateful`) and MeshNode `bioPulseReadiness: BioPulseReadiness` (`off | shadow | ready | degraded`, default `off`), `bioPulseProfileId: String?`, `bioPulseVerifiedAt: DateTime?`; existing V1 capability columns stay unchanged. API resolves protocol from server-side capability, not caller input. Persist authenticated Gateway V2 support separately from snapshot `applied` ACK; publisher uses V1 for a V1-only all-BlueZ Gateway and V2 only after explicit V2 support. Unknown V2 support leaves BIO rules disabled/pending. A V2 `applied` ACK acknowledges configuration only, not A sensor readiness. A의 sensor-mode 요청은 고유 명령 ID와 durable 결과를 가진 별도 operation이며 Gateway의 실제 mode GET이 `sensor`를 확인해야만 `modeVerified`가 된다. Presence의 configured high-brightness는 현재 출력/에너지로 승격하지 않는다.

기존 BlueZ coherence CHECK·source invariant trigger와 V1-only snapshot ACK가 공유 경계이므로 **5a→5b→5c 순차 구현·각각 독립 검토**한다. 앞 단계의 미검증 BIO 상태는 뒤 단계의 적용 성공이나 제품 ON을 의미하지 않는다.

- [ ] **5a RED·GREEN: DB expand/migrate 및 문서.** `schema.prisma`와 forward migration에 위 protocol/readiness/profile/verifiedAt 기본값을 추가하고, 기존 BlueZ rows는 `bluez_stateful`·5초 의미를 유지하며 BIO는 기본 OFF다. BlueZ의 두 model-binding coherence CHECK를 BIO에 거짓 true로 채우지 않고 protocol별 조건으로 확장한다. source INSERT/재활성화/capability downgrade/fixture-node 변경 trigger를 새 protocol readiness 조건으로 forward migration한다. 구 데이터·새 BIO default·9초/10초 하한 및 DB invariant를 RED→GREEN, Prisma validate/generate/typecheck와 가능한 disposable PostgreSQL migration integration으로 검증한다. `docs/database-schema.md`에 열/기본값/backfill/rollback 제약을 같은 커밋에 기록한다. 운영 DB migration은 실행하지 않는다.
- [ ] **5b RED·GREEN: API source/rule 판정.** API는 클라이언트 protocol 주장 대신 서버의 node/capability에서 protocol을 결정한다. `off/shadow/degraded` 또는 stale/duplicate revision의 BIO는 enabled source가 될 수 없고, BIO는 정확히 A source 1개와 다른 B target만 허용하며 mixed BIO/BlueZ·다른 site/gateway를 거부한다. BlueZ의 기존 5초, BIO의 ready 10초·최대 1,800초를 서비스/DTO에서 동일 검증한다. 상태 하향 때 affected rule을 안전하게 비활성/보류하고 집중 Jest·API typecheck·DB invariant tests 후 별도 커밋/검토한다. Task 6의 모든 manual/schedule/identify target 보호는 아직 별도다.
- [ ] **5c RED·GREEN: V2 배포/ACK·mode operation.** 인증된 Gateway V2 지원을 snapshot `applied` ACK와 별도로 durable하게 확인한다. 미지원/미확인 Gateway에는 BIO 규칙을 V1로 보내거나 적용 성공으로 표시하지 않는다. V1-only all-BlueZ는 V1 유지, V2 hash/ACK는 버전별로 검증한다. A sensor-mode 요청은 고유 ID와 durable 결과/timeout 재조회를 가지며 실제 Gateway mode GET=`sensor`만 `modeVerified`로 기록한다. MQTT 접수 ACK, V2 snapshot applied, configured high-brightness를 각각 sensor 준비/현재 광학 출력으로 승격하지 않는다. 집중 Jest와 API typecheck·가능한 integration을 RED→GREEN, 별도 커밋/검토한다. 실제 모드 SET/RF는 HIL 승인 전 수행하지 않는다.

### Task 6: A source를 모든 제어 대상 경로에서 보호

**Files:** Modify `apps/api/src/automation/{vehicle-event-rules.service,schedules.service,target-snapshot.service}.ts`, `apps/api/src/commands/commands.service.ts`, `apps/api/src/fixture-identify/fixture-identify.service.ts`, Gateway `apps/gateway/src/automation/schedule-runtime.ts` 및 command/identify 경계; Test 각각의 service/runtime specs; Modify `docs/menus/control.md`, `docs/menus/settings.md`.

**Interfaces:** `assertNoActiveBioSourceTarget(tx, siteId, expandedFixtureIds, operation): Promise<void>`를 단일 API policy module에 둔다. `operation`은 `manual|schedule|event|identify|group`의 명시적 값이다. Gateway는 적용 시 최신 V2 snapshot의 BIO source set과 실제 확장된 fixture set의 교집합이 있으면 RF write 전에 거절한다.

- [ ] **Step 1: RED 테스트 작성.** A 자신과 타 rule target, 다중 수동, 스케줄, group/floor 확장, identify, 저장 뒤 group membership 변경의 A 포함 모두 API에서 거절; 직접 MQTT/replayed command도 Gateway RF write 0건; A가 아닌 B는 정상; A의 로컬 `sensor` 모드는 유지하고 A에 `CD 13` 또는 mode 변경 RF write가 발생하지 않음. 자체 밝기 변화는 소프트웨어 테스트로 단언하지 않는다.
- [ ] **Step 2: RED 확인.** `pnpm --filter @led-control/api exec jest src/automation/vehicle-event-rules.service.spec.ts src/automation/schedules.service.spec.ts src/commands/commands.service.spec.ts src/fixture-identify/fixture-identify.service.spec.ts --runInBand` 및 Gateway 관련 Vitest → 새 guard 기대 실패.
- [ ] **Step 3: 최소 구현.** API는 membership 확장 후 같은 transaction 안에서 검사; Gateway는 RF 직전에 다시 검사한다. 기존 공통 target resolver를 재사용해 UI 선택만 보호 장치로 삼지 않는다.
- [ ] **Step 4: GREEN·문서 확인.** 집중 tests와 API/Gateway typecheck 통과; `docs/menus/control.md`, `settings.md`에 software guard 완료와 live BIO OFF/HIL 보류를 분리 표기한다.
- [ ] **Step 5: 커밋.** guard와 메뉴 문서를 같은 커밋에 저장한다.

### Task 7: UI의 source 준비 상태·유지시간·장애 표시

**Files:** Modify `apps/web/src/api/{automation,queries}.ts`, `apps/web/src/features/control/automation/{vehicle-event-form.ts,VehicleEventDialog.tsx,VehicleEventControlPanel.tsx}`; Test 해당 `*.test.ts(x)`; Modify `docs/menus/control.md`, `docs/menus/monitoring.md`.

**Interfaces:** `VehicleEventSourceView`는 server capability의 `sensorProtocol`과 `readiness`를 받는다. `validateVehicleEventForm(values, sourceProtocol)`은 BIO 10/BlueZ 5 하한을 적용한다. 기존 공통 `TextField`, 버튼, 카드, 지도 선택 컴포넌트를 재사용한다.

- [ ] **Step 1: RED 테스트 작성.** OFF/shadow/degraded BIO는 저장 불가이고 이유 표시, mode 미확인 A에는 sensor-mode 설정/상태 재조회만 제공하며 성공 GET 전에는 사용 가능으로 표시하지 않음; ready A는 source만 선택되고 target에서는 제외, B target은 선택 가능; A는 센서 모드를 유지하고 **자체 밝기 동작은 현장 검증 전**이라는 정직한 설명, A 밝기 설정 UI 없음; BIO 9초 오류/10초 통과/기본 60초/1,800초 통과/1,801초 오류와 10초 깜박임 경고; BlueZ 5초 통과; 편집 저장 후 hold 유지; degraded 지속 알림·마지막 pulse·운영자 해제 안내를 키보드/스크린리더에서도 읽을 수 있음.
- [ ] **Step 2: RED 확인.** `pnpm --filter @led-control/web exec vitest run src/features/control/automation/vehicle-event-form.test.ts src/features/control/automation/VehicleEventDialog.test.tsx src/features/control/automation/VehicleEventControlPanel.test.tsx` → 새 UI 기대 실패.
- [ ] **Step 3: 최소 구현.** server가 판정한 protocol/readiness만 표시하고 client가 이를 지정하지 않는다. 모바일에서 지도 선택·유지시간 입력이 기존 접근성/레이아웃 규칙을 지킨다. 공통 컴포넌트 중복을 만들지 않는다.
- [ ] **Step 4: GREEN·검증.** 위 Vitest, Web typecheck, `pnpm --filter @led-control/web test:ui-policy`, 관련 Playwright UI test → 통과. 메뉴 문서에는 software 화면과 live OFF를 구분한다.
- [ ] **Step 5: 커밋.** Web 코드·테스트·영향 메뉴 문서를 함께 저장한다.

### Task 8: 소프트웨어 end-to-end와 제품 OFF 검증

**Files:** Modify `apps/gateway/src/automation/software-automation-simulator.ts` 및 tests, API integration/`apps/web/e2e/automation-control-flow.spec.ts`; Modify `docs/project-status.md`, `docs/menus/{control,settings,monitoring}.md`; 현장 실행 결과가 생기기 전에는 진단 보고서를 완료로 쓰지 않는다.

**Interfaces:** Fixture simulator injects valid `bio-usb-pulse` only with an explicit test profile/healthy link. End-to-end verifies API save→V2 publish→V2 ACK→Gateway occurrence/telemetry→B mode/brightness restore, while product allowlist and capability remain OFF.

- [ ] **Step 1: RED 통합 테스트 작성.** V1 BlueZ regression, V2 미지원 Gateway fail-closed, V2 BIO software fixture의 10/60초 연장·B 복원·degraded/restart, source A RF write 0건, telemetry redaction, MQTT disconnected/reconnected outbox delivery를 검증한다.
- [ ] **Step 2: RED 확인.** Gateway simulator Vitest, API integration, 관련 Playwright가 새 경로에서 실패하는지 확인한다.
- [ ] **Step 3: 최소 연결 구현.** 기존 MQTT topic/ACK outbox를 version-aware로 연결하고 시험 fixture로만 positive profile을 주입한다. 현장 profile을 소프트웨어 시험 값으로 승격하지 않는다.
- [ ] **Step 4: 전체 software gate.** `pnpm lint`, `pnpm typecheck`, `npm_config_workspace_concurrency=1 pnpm test`, `pnpm build`, `git diff --check`를 실행하고 결과·기존 제외 항목을 상태 문서와 체크리스트에 동기화한다. 실패는 회귀 수정 후 재실행하며 HIL 성공으로 표현하지 않는다.
- [ ] **Step 5: 최종 검토·커밋.** 독립 QA가 contract/안전 경계/문서 일치와 실장비 미검증 표기를 확인한 뒤 software 변경을 저장한다. HIL·제품 ON은 별도 승인과 근거가 실제로 갖춰질 때만 상태를 갱신한다.

### Task 9: 별도 현장 운영 관문 — shadow, MQTT, B-only

**Files:** Update `docs/project-status.md` and relevant `docs/menus/{control,settings,monitoring}.md` only as each real gate completes; create diagnostic evidence under `docs/diagnostics/bio-sensor-motion-<date>/` only after authorized HIL. Do not modify production DNS, DB, credentials or certificate material as part of this task.

**Interfaces:** Shadow HIL report separately records timed human markers, A optical brightness, `sensor` mode read-back, `0x09` and `0x0c` arrivals, packet evidence hash, fingerprint, independent health evidence, Pi/phone clock error bound, and `physicalTimingVerified`. MQTT gate records original/restored hosts/assignment/bootstrap and three **new** heartbeats. B-only report adds B optical/read-back apply and restore to the same timeline.

- [ ] **Step 1: 현장 승인·사전 상태.** 사용자와 shadow 창·원복을 합의하기 전 Pi/B를 바꾸지 않는다. original container/identity/mapping/assignment, A/B brightness/mode, MQTT endpoint·SAN·신뢰 체인을 읽기 전용으로 기록한다.
- [ ] **Step 2: shadow HIL.** 최소 10회 독립 행동 주기, 장시간 정지/지속 움직임, USB 분리/재시작, sequence/loss, 독립 `0x0c` 건강 성질과 시계 오차를 검증하고 원시 hash를 보존한다. A의 실제 광학 출력·`sensor` 모드 read-back·`0x09` 수신 시각을 같은 동기화된 타임라인에 두고 자체 밝기 반응을 별도로 확인한다. `CD 13`을 이용한 A 밝기 설정 가능성은 별도 승인된 실험/원복 및 설계 관문으로 분리하고 현재 UI에는 노출하지 않는다. 실패하거나 펄스 가설·A 밝기 기대가 흔들리면 capability OFF로 유지한다.
- [ ] **Step 3: 로컬 MQTT 복구.** 실행 당일 현재 IP·hosts·assignment/bootstrap·SAN/체인을 다시 읽기 전용 확인하고 백업/원복을 확보한다. 승인된 랩 DNS hostname만 최소 수정하고 DNS→TCP→TLS/mTLS→MQTT CONNACK→신규 heartbeat 3회로 검증한다. hostname 검증 해제·임의 인증서 재발급·production DNS/DB 변경은 하지 않는다. 실패 시 즉시 원복하고 USB/mapping/조명 상태를 확인한다.
- [ ] **Step 4: B-only live 시험.** shadow, MQTT, 운영 담당자/최대 조치시간/연락 실패 정책과 사용자 현장 승인을 모두 받은 뒤 A sensor mode read-back, B 사전 brightness/mode read-back, 기본 60초, 이후 10초 순으로 한 B만 시험한다. 같은 타임라인에 A 광학 출력·펄스·B 출력 및 복원을 남긴다. 적용·복원 read-back과 장애/degraded를 기록한다. 그 전에는 제품 capability OFF다.
- [ ] **Step 5: 관문 판정.** 실제 증거에 한해서 상태판/메뉴 문서를 갱신하고, 실패 시 원복과 capability OFF를 명시한다. 별도 펌웨어 조합은 새 fingerprint/health 검증 없이 자동 지원하지 않는다.

## 실행 체크리스트 상태

- [x] Task 1 — 공유 V2 계약 (`ededa5c9`, `f3f0f4c5`; 집중/Shared 검증 통과, root CAD RSS 실패 별도)
- [x] Task 2 — BIO decode/intake, allowlist OFF (`72d26ac4`, `ae1d3de5`; 집중 195/195, Gateway 1,439/1,439, 독립 재검토 승인)
- [x] Task 3 — pulse occurrence/receipt (`0ff260a4`; 집중 139/139, Gateway 1,457/1,457, 독립 검토 승인; 제품 실행 OFF)
- [x] Task 4 — fail-safe/restart/target mode 복원 (4a `f6e09f58`, 4b `98db8a0e`+`298a9c9c`, 4c `ee412d5a`+`8fd06f2d`+`6ce596c6`+`7bc65eec`; synthetic software only, 제품 OFF)
- [ ] Task 5 — API/DB versioning 및 capability
- [ ] Task 6 — A source 보호
- [ ] Task 7 — Web UI
- [ ] Task 8 — software 통합과 제품 OFF 검증
- [ ] Task 9 — 승인 후 shadow/MQTT/B-only 현장 관문

현재 이 계획은 **작성 상태**이며 구현·현장 시험·제품 지원 완료를 뜻하지 않는다. 총괄은 각 상태 변경을 `docs/project-status.md`와 동기화한다.
