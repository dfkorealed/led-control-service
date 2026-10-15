# BIO 자기 감지 제어 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존·신규 BIO 조명에 자기 감지 밝기 제어를 제공하고 유지시간을 1초부터 설정한다.

**Architecture:** 자기 조명은 sensor 모드를 유지하는 장비 설정으로 제어하고 다른 조명은 기존 펄스 실행 경로를 재사용한다. 장비 명령 근거를 먼저 확인하며, 자기 제어 여부를 별도 필드로 전달해 기존 source 보호와 일반 출력 명령을 혼동하지 않는다.

**Tech Stack:** TypeScript, Zod, NestJS, Prisma/PostgreSQL, React, Vitest/Jest/Playwright, BIO USB codec, JADX 정적 분석.

**Spec:** `docs/superpowers/specs/2026-10-15-bio-self-sensing-control-design.md`

## Global Constraints

- BIO 유지시간 1~1,800초 정수·기본60초. 기존 BlueZ 범위와 저장된 값은 보존한다.
- 기존/신규 조명에 공통 처리하며 fixture 이름/과거A/B ID로 하드코딩하지 않는다.
- 자기 조명을 force-on/off 일반 대상으로 넣지 않는다. sensor 모드와 일반 수동 보호를 유지한다.
- 미확인 opcode·시간단위·readback을 추측하지 않는다. 실제1초를 표현하지 못하는 장비는 이유를 알리고 활성화하지 않는다.
- 기존 규칙은 자기 제어 기본false로 보존한다. 새 규칙만 자기 제어 기본true다.
- 실제 장비 명령·배포·DB migration·서비스 재시작은 사전 안내/승인 전 실행하지 않는다.
- 사용자가 설계 확정 후 계획 작성·진행을 명시 요청했으므로 계획 작성 뒤 같은 세션에서 직접 실행한다. 이전 단독 진행 요청을 유지하고 에이전트/다른 채팅 협업은 하지 않는다.
- 직접 연관 최소 검사만 수행하고 기존 실패를 숨기거나 무관한 전체suite 수리로 확장하지 않는다.

## Review Focus

- 장비가1초를 표현하지 못하는 경우: 조용한 반올림/10초 보정 없이 거절한다(Task1/3).
- 기존 규칙과 이전 Gateway: 자기 제어가 자동 활성화되거나 새 필드가 무시되지 않는다(Task4).
- 장비 설정 도중 일부만 적용: 원 설정·확인 필요 원장을 보존하고 적용 완료를 표시하지 않는다(Task3/5).
- 기존·신규 조명의 이름/주소 변경: 현재 물리 신원과 공통 프로파일을 사용한다(Task3/4).
- source 자신과 다른 활성 source 혼합: 자기 제어만 별도 경로로 허용하고 일반 source-target 보호는 유지한다(Task4/5).

## 실행 현황

- [x] Task1 장비 명령·시간단위 정적 근거와 실제 확인 필요 범위 판정
- [x] Task2 기존 BIO 유지시간 1초 코드·DB 변경 파일·격리 UI 검증 (운영 미반영)
- [ ] Task3 자기 설정 codec/client — 저수준 적용/복구 코드·한정 검증 완료, 실제1초 쓰기·단계별 복귀는 미검증
- [ ] Task4 자기 제어 공통 계약·서버 저장/검증
- [ ] Task5 Gateway 내구 적용·복구 연결
- [ ] Task6 자기 제어 UI·한정 검증·문서·병합

Task1에서 근거가 확보되지 않거나 실제 표현 범위가 설계와 다르면 자기 제어 Task3–6을 추측해 구현하지 않는다. 확인된 근거와 필요한 다음 행동을 기록한다. 독립적인 Task2는 진행할 수 있지만 전체 자기 제어 완료로 표현하지 않는다.

### 현재 검증과 관문

- 10월16일 사용자 요청: 물리 시험에서 방습등1·2를 제외하고 기존 B1-L006을 우선 선정한다. 새 읽기 전용 확인에서6대offline/기존Gateway실행중이나MQTT·USB준비false, PC172.30.1.2≠서버별칭172.30.1.17, 실제USB001/005≠컨테이너001/004, 로컬4000 API 접속불가를 확인했다. 새 연결 복구·중단·단일조명 설정시험 범위 승인 전에는 운영 변경하지 않는다. 복구 후 현재 신원/원 설정을 다시 읽으며 어제 값이나 방습등 원 설정을 재사용하지 않는다.
- 후속 코드 실행: 원 설정6GET과필수 intent callback·단일큐·각SET 독립GET/전체6GET·부분실패/소유권변경/USB세대변경 거절을 저수준 SDK에 구현했다. standby/hold SET의 근거는 동일APK의 RemoteCommand/CommandMapper/TimeInterval이며 high/mode의 기존 convention을 보존한다. 높은 밝기0·phase1·표현불가128초 등은 새 적용에서 거절하고 원interval0/장시간은 복구 시 보존한다. 실제 규칙/호환 프로파일에는 연결하지 않았다.
- Task3 소프트웨어 검증: 최초 새codec5/설정변환7/client7 semantic RED, 추가 extra-field/GET permit/세대 guard3 RED→직접관련4파일287PASS·Gateway타입/build exit0·diff0이다. fake endpoint만 대체하고 실제 client/decoder/queue를 사용했다. 시험 fixture는 실제 읽기와 정적 SET 근거를 구분하며1초SET/광출력 verified=false다. 사용자 단독 지시에 따라 직접 검토하며 독립 에이전트 리뷰는 아니다.
- Ruling: 출력 단계 의미를 확정하기 전에는 제품 연결을 하지 않되, 이미 근거가 확보된 정확한 byte변환과 원 phase 보존·검증형 SDK는 오프라인으로 먼저 구현한다. 위험은 아직 물리 검증이 없는 SDK를 잘못 연결하는 것이므로 일반 준비/규칙 경로에 호출·capability 승격을 추가하지 않는다. 전체 UI/서버/Gateway 통합 검증 후 메인에 병합하며 부분1초 UI만 먼저 노출하지 않는다.

- 10월15일 읽기 전용 승인 결과: 방습등1·2와 B1-L006에서6GET씩 총18개의 UUID/주소/network 일치 응답을 확보했다. 세 대 모두 fingerprint `deviceType1/firmware5.5.8.12889/sensor2/infrared1/ambient0/hardware3`다. 방습등1·2는 high30%/standby10%/hold5초/standby interval5초/delayMode0/force-on, B1-L006은 high100%와 force-off이며 나머지 설정은 같다. 현재 저장값 조회이지1초 SET·광출력·단계별 복귀의 검증은 아니다.
- 운전 복귀: exact 기존 컨테이너/이미지 `eebe6533`·Config/HostConfig/정렬한Mounts 불변, 진단 전후3root 전체 metadata/hash 불변, USB owner1과 새 lifetime의health5true·6대online·등록/설정digest 보존·V3 revision39 APPLIED·명령/outbox/lease0을 확인했다. 영구배포/DB migration/API·브로커 재시작/조명설정 SET0이며 다른 채팅 공유0이다.
- 중간 실패도 보존한다. Mounts 순서만 달라 중단된 guard는 RED1→2PASS로 보완했다. 첫 진단은 기존 zero-trailer startup literal까지 차단해 설정조회 RF0으로 종료했다. exact 두 literal의 순서만 허용하는 RED1→3PASS 뒤 실제18응답을 확보했다. 첫 재개는 malformed frame으로 종료해 sole USB 해제/같은 runtime을 대조한 명시적 복구1회로 정상화했다. 다음 진단 후 start는 성공했지만 즉시USB postflight가 미확정으로 끝나, 추가 쓰기 없이 후속 fresh 읽기로 running/새health/owner1을 확정했다. 성공 projection을 위조하거나 원 실패를 삭제하지 않았다.
- 임시 진단은 기존 immutable image의 dependency와 검증한 고정 번들을 사용했다. network-none/read-only/cap-drop ALL/UID999·exact USB·RO mesh만 제공했으며 운영 코드·영구 Gateway 버전은 바꾸지 않았다. 이번 codec/client205PASS·진단 guard3PASS·identity2PASS는 새 기능 전체의 완료를 뜻하지 않는다. 상세 기록은 이 계획의 ignored 실행 폴더에0600으로 보존한다.

- APK SHA256 `1fb69b7f6241ab757908fb4a6e8d8359d1127be75c84f5cbbf26740e415ef83e`는 기존 사용자 제공1.1.314와 일치한다. 자체 폴더의 JADX 추출은 의존 라이브러리 등234오류/exit3를 보존했으며 전체 역컴파일 성공으로 기록하지 않는다. 직접 참조한 Scene/TimeInterval/RemoteCommand/CommandMapper는 읽을 수 있다. 기존 캡처 APK1.2.0 SHA256 `38b908d233019888da7b0cfb77c8f5f6cf8a6f36cd2afb2f1b0cf59357f95a1d`와 혼동하지 않는다.
- 정적 근거: `RemoteCommand`의 standby DPID20/hold23/standby interval24/delay mode22, `CommandMapper`와 `ILampCommand`의 GET0x4e/STS0x4f, `TimeInterval`의 bits1..7=count/bit0=초·분이다.1초=raw02,127초=fe,1800초=3d다.128초 이상 비정수 분 값은 정확 표현할 수 없고1단계/2단계 enum만으로 실제 기본 밝기 복귀 동작은 확정하지 않는다.
- Task2 RED: shared3/API DTO3/Web4/임시DB1 실패를 확인했다. GREEN shared57(V2/V3명시)·API3파일46·Web2파일33·Gateway3파일244(1초재감지연장 포함), PC1440/모바일390의1초 저장/활성화 모의2건, API/Gateway타입·Web타입 포함build 통과다. 자기조회 RED13→fullcodec/client/runtime244PASS이며 원설정누락 timeout에서SET0·외부network거절·대기중SET비개입을 확인했다. 전체suite/HIL 성공 주장은 하지 않는다.
- Ruling: DB CHECK에도10초 하한이 있어 Task2에 별도 forward migration/실제 disposable PG 검증을 포함했다. 운영 migration은 적용하지 않는다. 공유 계약/소비자 준비만으로 기존 Gateway 배포 전 UI 실사용 가능으로 기록하지 않는다.
- Ruling: 먼저 구현한 자기 설정 조회는 `BioDongleClient.readSelfSensorConfiguration`에 묶고 일반 쓰기 경로와 분리했다. 실제 조회 응답과 단계별 복귀 의미를 확보하기 전 SET/Task4–6을 추측해 완료하지 않는다. 장비 검증 전에 알리라는 사용자 지시에 따라 읽기 전용 장비 확인의 새 승인을 요청했다.

---

### Task 1: 장비 설정 명령의 근거 확인

**Files:** Inspect 사용자 APK `/Users/kim-jh/Downloads/bio-group-control-v11-slim-aligned-signed.apk`; `apps/gateway/src/bio/{bio-command-codec,bio-dongle-client}.ts`; `apps/gateway/test/fixtures/bio-protocol-v1.json`.

**Interfaces:** Produces 현재 APK 해시/버전·serializer/응답 parser·유지시간 범위/단위·standby 밝기 범위/단위와 self 제어 진행 가능 판정. 정적 근거와 실제 장비 근거를 구분한다.

- [x] 원 APK hash를 기존 기록과 대조하고 자체 실행 기록 폴더에 정적으로 추출했다. 앱 설치/USB 연결/장비 송신은0이다.
- [x] 직접 관련 클래스의 명령/단위/바이트 폭과0%대기 밝기를 추적했다. 다른 APK 버전으로 실제 장비 호환을 승격하지 않는다.
- [x] 판정: 한정 GET/보고 파싱 구현은 가능하며, 자기 설정 쓰기와 실제1초·단계별 복귀는 현재 장비 응답/검증 전 보류한다.

### Task 2: BIO 유지시간 최소 1초

**Files:** Modify `packages/shared/src/automation-contracts.ts`, `apps/api/src/automation/dto/vehicle-event-rule.dto.ts`, `apps/web/src/features/control/automation/vehicle-event-form.ts`, `VehicleEventDialog.tsx`(같은디렉터리); Create migration `20261015160000_bio_event_hold_one_second/migration.sql`; Update `docs/database-schema.md`; Test 해당 shared/API/form/dialog 회귀, `apps/api/src/prisma/bio-event-hold-migration.integration.spec.ts`, Gateway `vehicle-event-runtime.test.ts`.

**Interfaces:** 기존 `holdSeconds: number`를 유지한다. BIO만1~1800, BlueZ는기존5~1800, default60. snapshot/POST/PATCH/effective merge/form 검증의 범위를 일치시킨다.

- [x] 기존 테스트에 BIO1/2/9허용·0/소수/1801거절·BlueZ1거절·기존10/60보존과 Gateway1초 만료/건강 복귀 회귀를 추가했다.
- [x] focused shared/API/Web와 실제 임시DB에서 기존 하한에 의한 RED를 확인했다.
- [x] validator/문구/짧은유지경고·DB CHECK를 수정했다. BlueZ 하한/기존 저장값·실제 장비는 변경하지 않았다.
- [x] 타입·관련GREEN과 문서·직접리뷰 결과를 반영해 검증된1초/읽기전용 slice만 커밋한다. 자기설정쓰기·운영 반영은 포함하지 않는다.

### Task 3: 자기 조명 설정 codec와 검증 client

**Files:** Create `apps/gateway/src/bio/bio-self-sensor-configuration.ts`, `bio-self-sensor-configuration.test.ts`; Modify codec/client 및 해당 기존 test; Create 정규화 fixture `apps/gateway/test/fixtures/bio-self-sensor-configuration.json`.

**Interfaces:** `BioSelfSensorConfiguration { highBrightnessPercent: number; standbyBrightnessPercent: number; holdSeconds: number }`. `readSelfSensorConfiguration(target, control)`와 `configureSelfSensor(target, desired, control)`는 현재 물리 신원과 독립 readback을 검증한다. Task1 근거 없는 operation은 생성하지 않는다.

- [x] 승인된 읽기 전용 확인: 방습등1·2/기존1대의 실제6항목 응답과 동일 fingerprint를 확보하고 원 운전 복귀를 확인한다.1초 쓰기·실제 자동복귀와 구분한다.
- [x] 확인된 byte·정규화 읽기 fixture와1초·최대값·다른network·표현불가·부분쓰기/모드보존·소유권·연결세대·내구intent 실패 회귀를 확인했다.
- [x] 저수준 직렬화와 parser, 전체 설정 GET 및 변경/독립 재조회를 구현했다. 불일치 시 observed 설정을 보존하며 자동 SET 재시도/자동 복구를 하지 않는다. 설정 복구는 전체 현재값/원raw를 검증한다.
- [x] 직접관련4파일287PASS·Gateway타입/build·diff와 직접 검토를 확인했다. 실제 광출력 성공으로 확대하지 않는다.
- [ ] 실장비1초 SET/readback·감지 후 기본 밝기 복귀와 원 설정 복구를 최소1대로 확인한다. 읽기 전용 승인을 설정 쓰기 승인으로 재사용하지 않는다. 이 확인 전 제품 Task4–6의 단계 의미/firmware 자격을 추측하지 않는다.

### Task 4: 자기 제어의 저장과 공통 계약

**Files:** Modify `packages/shared/src/automation-contracts.ts`, API `automation/dto/vehicle-event-rule.dto.ts`, `vehicle-event-rules.service.ts`, `automation-snapshot.service.ts`, Prisma schema/new migration, `docs/database-schema.md`; Test 각 기존 계약/DTO/service/snapshot 회귀.

**Interfaces:** `selfControlEnabled: boolean`의 기존 저장값 기본false, 새 UI 요청true. source한개·self=true때만 다른target0개 허용. 자기 제어 설정은 일반target으로 확장하지 않는다. 변경 계약의 capability/strict parsing/ACK로 이전 Gateway의 오실행을 차단한다.

- [ ] self-only 저장·기존 payload/행false·다른source거절·권한/현장/소유권/호환누락·stale Gateway 회귀를 먼저 추가하고 RED를 확인한다.
- [ ] 공유 계약을 먼저 구현한 뒤 서버 저장/현재 장비의 자동 호환 준비·snapshot 연결을 수정한다. 신규 forward migration은 disposable DB에서만 검증하며 운영 DB는 변경하지 않는다.
- [ ] 해당 회귀·타입·migration/schema 문서와 기존ID/설정 보존을 확인하고 커밋한다.

### Task 5: Gateway의 자기 제어 내구 적용과 원복

**Files:** Modify `apps/gateway/src/automation/{automation-state-store,schedule-runtime,bio-source-target-guard}.ts` 및 기존 snapshot wiring; Create `apps/gateway/src/automation/bio-self-sensor-runtime.ts`, `bio-self-sensor-runtime.test.ts`.

**Interfaces:** Task3 설정 port와 Task4 명시self 설정을 소비한다. 원 설정/물리 신원/규칙revision/소유권/진행단계를 RF전에 내구 저장하며 전체readback 일치 뒤에만 적용 완료를 인정한다.

- [ ] 자기제어와 일반대상 분리·원설정전읽기실패RF0·부분적용/재시작/다른소유자변경·비활성화복구·동시규칙충돌 회귀를 먼저 추가하고 RED를 확인한다.
- [ ] 현재 단일USB client/serial queue와 내구 state에 연결하고 자기 제어 apply/restore를 일반force 경로와 분리한다. 기존 source 보호는 유지한다.
- [ ] 관련 Gateway 회귀·타입과 상태 구버전 복원을 확인하고 커밋한다.

### Task 6: UI와 최소 통합 확인

**Files:** Modify `apps/web/src/features/control/automation/VehicleEventDialog.tsx`, `vehicle-event-form.ts`, `VehicleEventControlPanel.tsx` 및 같은 디렉터리의 해당 회귀; Update `docs/menus/control.md`, 상태판/본체크리스트.

**Interfaces:** 기존 공통 입력/Checkbox를 재사용해self=true의source-only 입력을 만들고 기존rule은false·새rule은true로 표시한다. 원시 패킷/주소 정보나 별도 등록 절차를 사용자에게 노출하지 않는다.

- [ ] 기존/새 조명self선택·기존rule편집·다른target0개·1초저장·자동준비실패/구체오류 회귀를 먼저 추가하고 RED를 확인한다.
- [ ] 기존 입력/선택 컴포넌트로 최소UI를 구현하고 PC1440/모바일390의 격리 브라우저에서 저장/활성화 실패·성공 경로만 검사한다.
- [ ] 직접관련 테스트/타입/Web build·diff와 직접 전체diff리뷰 후 문서와 결과를 일치시킨다. 기존 사용자/병행 변경을 포함하지 않고 메인에 병합한다.
- [ ] 실제 서버/장비 반영 전에 변경 범위와 남은 검증을 사용자에게 보고한다. 장비 쓰기 승인 전에는 배포/규칙 활성화/RF를 하지 않는다.
