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

**Interfaces:** Add `VehicleEventRule.sensorProtocol: VehicleSensorProtocol` (`bluez_stateful | bio_usb_pulse`, default `bluez_stateful`) and MeshNode `vehicleSensorProtocol` (same enum, default `bluez_stateful`), `bioPulseReadiness: BioPulseReadiness` (`off | shadow | ready | degraded`, default `off`), `bioPulseCapabilityRevision: BigInt` (default `0`), `bioPulseProfileId: String?`, `bioPulseVerifiedAt: DateTime?`; existing V1 capability columns stay unchanged. BIO node의 V1 status/revision/model flags는 unknown/0/false로 유지하고 BIO 별도 revision을 사용한다. API resolves protocol from server-side capability, not caller input. Persist authenticated Gateway V2 support separately from snapshot `applied` ACK; publisher uses V1 for a V1-only all-BlueZ Gateway and V2 only after explicit V2 support. Unknown V2 support leaves BIO rules disabled/pending. A V2 `applied` ACK acknowledges configuration only, not A sensor readiness. A의 sensor-mode 요청은 고유 명령 ID와 durable 결과를 가진 별도 operation이며 Gateway의 실제 mode GET이 `sensor`를 확인해야만 `modeVerified`가 된다. Presence의 configured high-brightness는 현재 출력/에너지로 승격하지 않는다.

기존 BlueZ coherence CHECK·source invariant trigger와 V1-only snapshot ACK가 공유 경계이므로 **5a→5b→5c 순차 구현·각각 독립 검토**한다. 앞 단계의 미검증 BIO 상태는 뒤 단계의 적용 성공이나 제품 ON을 의미하지 않는다.

- [x] **5a RED·GREEN: DB expand/migrate 및 문서.** `ae8bad3a`와 사전 검사 보완 `2af7b5a4`로 node/rule protocol, BIO 준비 상태·별도 revision·profile·verifiedAt, BlueZ/BIO coherence·source admission/하향·동시성 제약을 순방향 migration에 추가했다. 기존 BlueZ 5초·BIO OFF default를 유지하고, 기존 활성 부적격 source는 조치 안내 `23514`와 전체 롤백으로 거부한다. `docs/database-schema.md` 동시 갱신. 일회용 PostgreSQL 기존 BlueZ+BIO 통합 47/47, API 전체 2,963 실행, Prisma validate/generate/typecheck 및 독립 재검토 통과. 운영 DB에는 적용하지 않았다.
- [x] **5b RED·GREEN: API source/rule 판정.** `366b3e8b`; 서버 소유 protocol, BIO A 1개·distinct B, ready/10~1,800초, BlueZ 5초를 검증한다. V2 지원/ACK 전 BIO는 비활성 초안만 허용하고 V1 snapshot·appliedRevision·목록 집계·늦은 V1 ACK에서 제외한다. 내부 인증 scope BIO report는 별도 revision과 원자적 하향을 사용하되 공개 ingress는 없다. 집중 86/86, 일회용 DB 53/53, API 전체 직렬 3,008 passed/858 skipped, typecheck/build와 독립 검토 통과. 병렬 API 전체는 기존 CAD RSS 1건 실패(단독 17/17 통과)로 별도 기록했다. `docs/menus/control.md`를 한계와 함께 갱신했다. Task 6의 모든 target 경로 보호는 아직 별도다.
- [x] **5c1 RED·GREEN: V2 지원·배포/ACK.** `e378f4c9`·`767d9cb2` 및 선언 재시도 결함 보완 `aa99b951`로 독립 V2 지원 선언/DB migration, 현재 할당·claim/active certificate 확인, V1/V2 설정/해시/ACK를 구현하고 독립 재검토 승인했다. V1-only BlueZ는 V1 유지, enabled BIO는 Gateway 저장/RF 전에 차단하고 applied ACK를 만들지 않는다. 오래된 동일 V2 설정이 새 선언 재시도를 조기 종료하던 결함을 RED 3건으로 재현·수정했다. 전용 선언 receipt가 없어 동일 ID를 제한된 간격으로 재전송하며 중복 DB row를 만들지 않는다. Shared 431/431, API 전체 직렬 3,013 passed/859 skipped, Gateway 보완 후 1,575/1,575, 일회용 DB 56/56, typecheck/build/Prisma validate 통과; Gateway/API 재검토 집중 33/33·24/24 통과. `docs/database-schema.md`·`docs/menus/control.md`를 갱신했으며 운영 DB migration·실장비 조작은 없었다. 지원/적용 확인은 mode GET·A 자체 밝기·BIO 제품 준비의 증거가 아니고 capability/allowlist는 OFF다.
- [x] **5c2 RED·GREEN: A sensor-mode 작업.** `772b174a`와 동시 복구·시계 오류 결함 보완 `44c9c3ef`로 고유 ID의 독립 ensure/query 작업, API durable row·outbox·결과 수신, Gateway journal·실제 mode GET 확인·재조회, 정확한 MQTT ACL을 구현해 독립 재검토 승인했다. `modeVerified`는 시간·물리 identity·할당이 일치하는 새 GET=`sensor`에만 허용한다. 중복 SET은 재실행하지 않고, 복구·실시간 재전달의 동시 실행은 결과 하나로 수렴한다. 시계 오류가 있는 비성공 결과는 비검증 감사 기록으로 ACK해 공유 outbox가 막히지 않게 하되 성공 시간 증거는 완화하지 않는다. Shared 437/437, Gateway 보완 후 1,590/1,590, API 전체 직렬 3,014 passed/887 skipped, 일회용 DB 85/85, MQTT ACK 53/53, 타입 검사·빌드 통과; 재검토 집중 Gateway 13/13·DB 29/29 통과. `docs/database-schema.md`와 제어·설정 메뉴 문서를 같은 작업에서 갱신했다. 운영 DB migration·실장비 SET/RF·제품 활성화는 하지 않았다.

### Task 6: A source를 모든 제어 대상 경로에서 보호

**Files:** Modify `apps/api/src/automation/{vehicle-event-rules.service,schedules.service,target-snapshot.service}.ts`, `apps/api/src/commands/commands.service.ts`, `apps/api/src/fixture-identify/fixture-identify.service.ts`, Gateway `apps/gateway/src/automation/schedule-runtime.ts` 및 command/identify 경계; Test 각각의 service/runtime specs; Modify `docs/menus/control.md`, `docs/menus/settings.md`.

**Interfaces:** `assertNoActiveBioSourceTarget(tx, siteId, expandedFixtureIds, operation): Promise<void>`를 단일 API policy module에 둔다. `operation`은 `manual|schedule|event|identify|group`의 명시적 값이다. Gateway는 적용 시 최신 V2 snapshot의 BIO source set과 실제 확장된 fixture set의 교집합이 있으면 RF write 전에 거절한다.

- [x] **Step 1: RED 테스트 작성.** API의 A 자신/타 rule target, 다중 수동, schedule/event, group/floor 확장·저장 뒤 membership 변경, identify와 Gateway 직접/replayed 명령·cleanup·UUID 복구에서 A RF write 0건을 검증했다. B·BlueZ 정상 경로와 A 광학 미검증을 분리했다.
- [x] **Step 2: RED 확인.** API/Gateway guard 제거 전 누락과 identify cleanup의 실제 fake USB mode write를 재현했다.
- [x] **Step 3: 최소 구현.** API 공통 정책을 대상 확장 뒤 transaction·automation lock 안에서 적용하고 Gateway 최신 V2 snapshot/native write 직전에 재검사한다. 부팅 snapshot 초기화 전 identify 복구도 차단했다.
- [x] **Step 4: GREEN·문서 확인.** 최종 API 집중 149/149, Gateway 집중 429/429, root typecheck/lint/build 및 독립 검토 통과. 제어·설정 문서에 software guard와 제품 OFF/HIL 보류를 구분했다. Root canonical test는 API 시험 fixture 1건으로 exit 1이었고 수정 후 해당 집중 테스트는 통과했으나, 뒤의 API 전체 직렬 실행은 비정상 wall-clock/timeout으로 중단해 **전체 통과 증거가 아니다**. 안정된 환경의 Task 8 전체 gate에서 다시 확인한다.
- [x] **Step 5: 커밋.** `ba528582`에 guard·테스트·메뉴 문서를 함께 저장하고 독립 검토 승인했다.

### Task 7: UI의 source 준비 상태·유지시간·장애 표시

**Files:** Modify `apps/web/src/api/{automation,queries}.ts`, `apps/web/src/features/control/automation/{vehicle-event-form.ts,VehicleEventDialog.tsx,VehicleEventControlPanel.tsx}`; Test 해당 `*.test.ts(x)`; Modify `docs/menus/control.md`, `docs/menus/monitoring.md`.

**Interfaces:** `VehicleEventSourceView`는 server capability의 `sensorProtocol`과 `readiness`를 받는다. `validateVehicleEventForm(values, sourceProtocol)`은 BIO 10/BlueZ 5 하한을 적용한다. 기존 공통 `TextField`, 버튼, 카드, 지도 선택 컴포넌트를 재사용한다.

- [x] **Step 1: RED 테스트 작성.** BIO 사용 불가 사유/A source·B target/비활성 초안, sensor-mode 조회의 역사적 증거, 10~1,800초·기본 60초·10초 경고, BlueZ 5초, 지속 운영 미확인/접근성, 모바일 지도와 실제 두 포인터 확대·축소를 검증했다. 마지막 펄스·장애 시작·복원 사유는 실데이터 projection 전까지 **미확인**으로 표시하며 A 자체 밝기는 HIL 미검증이다.
- [x] **Step 2: RED 확인.** API dashboard read model·Web BIO form/dialog·mode 상태 및 늦은 GET/새 dashboard 경합 실패를 RED로 재현했다.
- [x] **Step 3: 최소 구현.** 승인된 최소 API projection이 effective readiness와 typed 차단 사유를 판정하고 Web은 읽기만 한다. `139916c3` 및 오래된 로컬 mode 결과가 새 서버 상태를 가리던 결함 보완 `7631e40f`로 dashboard 최신 증거만 표시한다. 공통 UI/지도 컴포넌트를 재사용하고 A 밝기 설정은 추가하지 않았다.
- [x] **Step 4: GREEN·검증.** API 전체 직렬 3,046 passed/890 skipped, Web 보완 후 전체 2,653 passed/3 skipped, Web/API typecheck/build, UI policy 65/65·위반 0, 독립 재검토 focused Web 107/107 통과. BIO Playwright 4건·실제 pinch 3건은 통과. 전체 Playwright는 **32 passed/2 failed**로 기존 수동 모바일 밝기 입력 14px가 >=16px 계약에 미달하며 Task 8에서 수정·재검증한다. 실제 BIO runtime telemetry와 제품/HIL은 미연결이다.
- [x] **Step 5: 커밋.** `139916c3`·`7631e40f`에 API/Web 코드·테스트와 제어·모니터링 메뉴 문서를 저장하고 독립 재검토 승인했다.

### Task 8: 소프트웨어 end-to-end와 제품 OFF 검증

**Files:** Modify `apps/gateway/src/automation/software-automation-simulator.ts` 및 tests, API integration/`apps/web/e2e/automation-control-flow.spec.ts`; 기존 모바일 수동 밝기 입력 글꼴의 16px 계약을 만족하는 최소 CSS/Playwright 보완; Modify `docs/project-status.md`, `docs/menus/{control,settings,monitoring}.md`; 현장 실행 결과가 생기기 전에는 진단 보고서를 완료로 쓰지 않는다.

**Interfaces:** Fixture simulator injects valid `bio-usb-pulse` only with an explicit test profile/healthy link. End-to-end verifies API save→V2 publish→V2 ACK→Gateway occurrence/telemetry→B mode/brightness restore, while product allowlist and capability remain OFF.

Task 8은 **8a Gateway/API synthetic integration·additive V2 BIO telemetry handoff → 8b telemetry 영속 읽기/UI·모바일 잔여 → 8c 안정 호스트 전체 gate·최종 검토**로 순차 분할하고 단계마다 독립 검토한다. 8a RED에서 BIO `action_result`가 strict V1 outbox에 거부돼 뒤의 extend/degraded/restore 전체 FIFO를 막는 실제 결함이 확인되어, V1 불변 strict V2 BIO telemetry 계약·Gateway producer/outbox만 8a에 포함한다. API BIO telemetry 수신/영속/조회와 Web 표시는 8b 소유다. 제품의 enabled BIO가 API/Gateway에서 의도적으로 거부되므로 positive B 광학/모드 경로는 test-only profile의 in-process simulator에서만 검증한다. 제품 API에서는 disabled BIO draft의 저장→V2 배포/ACK까지만 검증하며, 두 증거를 하나의 production end-to-end 성공으로 합치거나 테스트 예외를 제품 bootstrap으로 옮기지 않는다. 실제 펄스/장애 telemetry가 API에 안전하게 영속·조회되기 전에는 Web의 미확인 표기를 유지한다.

- [x] **8a 독립 소프트웨어 경계.** `c2587e03`으로 API 비활성 BIO 초안→V2 설정/ACK, Gateway test-only 펄스→B 적용·복원·장애·재시작/A RF 0건을 별도 통합 시험했다. strict V2 BIO telemetry producer/outbox를 추가해 V1-only outbox가 결과 뒤 FIFO를 막던 결함을 해결했고 malformed producer는 journal append 전에 거부한다. V1 wire/consumer, 제품 empty allowlist·capability OFF, enabled BIO 거부를 유지한다. Shared 446/446, Gateway 1,624/1,624, API 전체 직렬 3,046 passed/900 skipped, 일회용 DB 10/10, 타입/빌드 통과; 독립 검토 191개 집중·경쟁/재시작/버전 adversarial 통과. 실제 MQTT·RF·운영 DB 및 V2 API telemetry ingest/ACK는 미실행·미구현이다.
- [x] **8b1 API BIO telemetry 영속·조회/ACK.** `8e3b4746`와 source 귀속·exact ACK 복구 보완 `f06b35d8`로 V2 event/ACK에 required `assignmentVersion`, 서버 snapshot의 assignment·원본 Fixture→MeshNode binding, durable event ledger·quarantine·projection·commit 후 ACK를 추가해 독립 재검토 승인했다. 지연된 첫 이벤트/새 occurrence도 A 교체 뒤에는 `stale_configuration` 감사+ACK만 남고, 이미 저장된 exact event는 재할당 후 현재 같은 site/Gateway 인증 범위 안에서 옛 ACK만 재발행한다. 출처 불명·hash 충돌은 수용하지 않는다. 시계 오류는 `untrusted_time` 감사+ACK, 실제 pulse/degraded/restorePending만 projection하며 configured read-back은 광학/전력 값으로 쓰지 않는다. V1 consumer·제품 enabled BIO 차단은 유지한다. Shared 447/447, Gateway 1,625/1,625, API 최종 전체 직렬 3,046 passed/932 skipped, 일회용 DB·snapshot 집중 46/46, API 타입/빌드·Prisma 검증과 독립 adversarial 재검토 통과. Migration·`docs/database-schema.md`·메뉴 문서 동시 갱신; 운영 DB/실장비 미적용.
- [ ] **8b2 Web 실제 telemetry 표시·모바일 잔여.** 8b1의 서버 projection에서만 마지막 펄스·장애·복원 대기를 읽고 증거가 없으면 미확인으로 유지한다. 320/390px 수동 밝기 입력 14px→최소 16px과 BIO/핀치 Playwright 전체를 재검증한다. 제어·모니터링 메뉴 문서를 갱신하고 별도 독립 검토한다. 제품 활성화는 하지 않는다.
- [ ] **8c 안정 호스트 전체 gate·최종 QA.** Task6의 비정상 wall-clock 테스트와 Task7 Playwright 2건을 포함해 lint/typecheck/root test/build/Playwright를 fresh 실행하고 독립 최종 검토한다. 실패 항목을 성공으로 덮지 않는다.

- [ ] **Step 1: RED 통합 테스트 작성.** V1 BlueZ regression, V2 미지원 Gateway fail-closed, V2 BIO software fixture의 10/60초 연장·B 복원·degraded/restart, source A RF write 0건, telemetry redaction, MQTT disconnected/reconnected outbox delivery와 API active-source group membership 경쟁을 검증한다. 기존 모바일 수동 밝기 입력 14px→16px 접근성 결함을 Playwright 390/320px RED로 포함한다.
- [ ] **Step 2: RED 확인.** Gateway simulator Vitest, API integration, 관련 Playwright가 새 경로에서 실패하는지 확인한다.
- [ ] **Step 3: 최소 연결 구현.** 기존 MQTT topic/ACK outbox를 version-aware로 연결하고 시험 fixture로만 positive profile을 주입한다. 현장 profile을 소프트웨어 시험 값으로 승격하지 않는다.
- [ ] **Step 4: 전체 software gate.** 안정된 호스트에서 `pnpm lint`, `pnpm typecheck`, `npm_config_workspace_concurrency=1 pnpm test`, `pnpm build`, 관련 Playwright 전체, `git diff --check`를 실행하고 결과·기존 제외 항목을 상태 문서와 체크리스트에 동기화한다. Task6의 canonical 비정상 wall-clock/timeout과 Task7 모바일 입력 2건을 재검증·수정 후 재실행하며 HIL 성공으로 표현하지 않는다.
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
- [x] Task 5 — API/DB versioning·V2 ACK·별도 sensor-mode operation (`5a`~`5c2` 소프트웨어·독립 검토 완료; 제품 OFF, 운영 DB 미적용)
- [x] Task 6 — A source 보호 (`ba528582`; 집중·타입·빌드/독립 검토 통과, 전체 canonical 재검증 Task 8 대기)
- [x] Task 7 — Web UI (`139916c3`, `7631e40f`; BIO/핀치와 unit/타입/빌드 독립 검토 통과, 기존 수동 모바일 Playwright 2건 Task8 잔여)
- [ ] Task 8 — software 통합과 제품 OFF 검증
- [ ] Task 9 — 승인 후 shadow/MQTT/B-only 현장 관문

현재 이 계획은 **작성 상태**이며 구현·현장 시험·제품 지원 완료를 뜻하지 않는다. 총괄은 각 상태 변경을 `docs/project-status.md`와 동기화한다.
