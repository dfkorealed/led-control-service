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

- [ ] Task1 장비 명령·시간단위 근거 확인
- [ ] Task2 기존 BIO 유지시간 1초 공통 검증·화면 반영
- [ ] Task3 sensor 모드를 유지하는 자기 설정 codec/client
- [ ] Task4 자기 제어 공통 계약·서버 저장/검증
- [ ] Task5 Gateway 내구 적용·복구 연결
- [ ] Task6 자기 제어 UI·한정 검증·문서·병합

Task1에서 근거가 확보되지 않거나 실제 표현 범위가 설계와 다르면 자기 제어 Task3–6을 추측해 구현하지 않는다. 확인된 근거와 필요한 다음 행동을 기록한다. 독립적인 Task2는 진행할 수 있지만 전체 자기 제어 완료로 표현하지 않는다.

---

### Task 1: 장비 설정 명령의 근거 확인

**Files:** Inspect 사용자 APK `/Users/kim-jh/Downloads/bio-group-control-v11-slim-aligned-signed.apk`; `apps/gateway/src/bio/{bio-command-codec,bio-dongle-client}.ts`; `apps/gateway/test/fixtures/bio-protocol-v1.json`.

**Interfaces:** Produces 현재 APK 해시/버전·serializer/응답 parser·유지시간 범위/단위·standby 밝기 범위/단위와 self 제어 진행 가능 판정. 정적 근거와 실제 장비 근거를 구분한다.

- [ ] 원 APK hash를 기존 기록과 대조하고 자체 실행 기록 폴더에 정적으로 추출한다. 앱 설치/USB 연결/장비 송신은 하지 않는다.
- [ ] 밝기·유지시간·무감지 밝기 설정과 조회의 호출 경로/바이트 폭/단위를 추적한다. 다른 APK 버전의 값으로 현재 장비를 지원 완료 처리하지 않는다.
- [ ] 근거를 기록하고 1초/0%/범위·응답 일치 검증의 구현 가능 여부를 판정한다. 불가능하면 명령을 만들어내지 않고 Task3–6을 보류한다.

### Task 2: BIO 유지시간 최소 1초

**Files:** Modify `packages/shared/src/automation-contracts.ts`, `apps/api/src/automation/dto/vehicle-event-rule.dto.ts`, `apps/web/src/features/control/automation/{vehicle-event-form,VehicleEventDialog}.tsx`(form은 `.ts`); Test 해당 기존 shared/API/form/dialog 회귀와 Gateway `vehicle-event-runtime.test.ts`.

**Interfaces:** 기존 `holdSeconds: number`를 유지한다. BIO만1~1800, BlueZ는기존5~1800, default60. snapshot/POST/PATCH/effective merge/form 검증의 범위를 일치시킨다.

- [ ] 기존 테스트에 BIO1/2/9허용·0/소수/1801거절·BlueZ1거절·기존10/60보존과 Gateway 마지막수신1초/재감지연장 회귀를 먼저 추가한다.
- [ ] 해당 이름으로 focused shared/Vitest·API/Jest·Web/form 검사를 실행해 기존10초 제한에 의한 실패를 확인한다.
- [ ] 기존 validator/문구/짧은유지경고를 최소 수정한다. 광범위한 숫자10 치환이나 기존 BlueZ 하한 변경은 하지 않는다.
- [ ] 관련 파일 검사와 타입을 확인하고 메뉴 문서·상태판을 갱신해 소유 변경만 커밋한다.

### Task 3: 자기 조명 설정 codec와 검증 client

**Files:** Create `apps/gateway/src/bio/bio-self-sensor-configuration.ts`, `bio-self-sensor-configuration.test.ts`; Modify codec/client 및 해당 기존 test; Create 정규화 fixture `apps/gateway/test/fixtures/bio-self-sensor-configuration.json`.

**Interfaces:** `BioSelfSensorConfiguration { highBrightnessPercent: number; standbyBrightnessPercent: number; holdSeconds: number }`. `readSelfSensorConfiguration(target, control)`와 `configureSelfSensor(target, desired, control)`는 현재 물리 신원과 독립 readback을 검증한다. Task1 근거 없는 operation은 생성하지 않는다.

- [ ] Task1의 확인된 바이트를 literal fixture로 두고1초·최대값·다른장비응답·손상응답·표현불가·부분쓰기/모드보존 실패 회귀를 먼저 추가해 RED를 확인한다.
- [ ] 확인된 직렬화와 parser, 전체 설정 GET 및 변경/독립 재조회만 구현한다. 불일치 때 observed 설정을 보존하며 자동 재시도하지 않는다.
- [ ] 해당 codec/client 회귀·Gateway타입과 diff를 확인하고 커밋한다. 실제 광출력 성공으로 확대하지 않는다.

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
