# BIO 센서 이벤트 실제 서비스 연동 실행 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 머지된 공통 센서 기능을 현재 테스트 현장의 정식 서비스 UI에서 사용하고, 감지·유지 연장·원래 밝기 복귀를 확인한다.

**Architecture:** 기존 프로파일·준비 작업·권한·펄스 실행 경로를 그대로 사용한다. 기존 증거 확인→배포 준비→승인된 현장 적용→정식 UI 확인 순서로 진행하며, 대상 환경·프로파일·장비 변경 승인 전에는 OFF를 유지한다. 추가 기능과 양산 전체 전환은 별도 설계·승인 범위다.

**Tech Stack:** React, NestJS/Prisma/PostgreSQL, MQTT, Raspberry Pi BIO Gateway.

**Spec:** `../specs/2026-10-08-common-bio-sensor-configuration-design.md`의 승인된 공통 프로파일·준비·실행 설계와 `2026-10-08-bio-sensor-local-merge.md`의 남은 제품 과제를 구현·적용한다. 실제 운영 변경은 아직 승인되지 않았다.

**상태:** 계획 초안 작성·사용자 검토 대기. 아래 작업은 미실행이다. 기준 main `208d6833`; 실제 실행 시 최신 HEAD/현장 상태를 다시 확인한다.

## Global Constraints

- 등록 ID·기본 밝기·전원·그룹·이력과 기존 수동/스케줄 동작을 보존한다. A/B는 역할 예시이며 코드에 특정 ID를 고정하지 않는다.
- 승인된 동일 식별 조합은 UI로 재사용한다. 센서가 없거나 미검증인 조명을 강제로 지원 처리하지 않는다.
- BIO source 1개·같은 site/gateway·source/target 분리, 유지시간 10~1,800초·기본60초·UI 수정 가능을 유지한다.
- 현재 동작은 펄스와 마지막 신호 기준 유지시간이다. 신호 없음=부재, GET 성공=센서 회로 정상, ACK=현재 준비 완료라고 표현하지 않는다.
- 승인 프로파일·현장 정책·현재 장비 자격이 모두 충족되기 전 규칙을 활성화하지 않는다. 기존 proof/receipt/START 및 어제의 중단 승인을 재사용하지 않는다.
- 이번 요청은 계획 작성뿐이다. 실제 DB migration, profile POST, 정책 ON, Gateway 배포/재시작, MQTT ACL/PKI 변경, sensor SET와 실장비 시험은 별도 범위 승인 후 수행한다.
- BlueZ 제거·새 펌웨어 flash·새 decoder·PKI 재설계·일반 양산 DNS 전환·다중 센서 합성은 포함하지 않는다. BIO 동작을 BlueZ에 의존시키지 않는다.
- 전체 기능 suite/장시간 현장 시험은 반복하지 않는다. 다만 실제 배포에 필요한 migration·release/security 관문은 생략하거나 실패를 완화하지 않는다.
- 기능 수정이 필요하면 영향 메뉴 문서를 함께 갱신한다. 새 DB 변경이 생기면 `docs/database-schema.md`도 갱신한다. 기존 사용자 미커밋 문서는 별도로 보존한다.

## Review Focus

- 기존 성공 pilot을 일반 장비군 지원으로 확대하거나 링크 정책 수치를 synthetic fixture에서 가져오지 않는다. Task1이 실제 승인 근거와 재사용 한계를 기록한다.
- 최신 main migration과 BIO 준비/개인 알람 구조의 병존을 실제 DB에서 확인한다. Task2의 disposable PostgreSQL 표적 검증을 사용한다.
- 구 버전 Gateway·다른 배정·catalog 미ACK 상태에서 정책만 켜지 않는다. Task3이 현재 계약/귀속/정확 ACK를 확인한다.
- 저장 성공과 장비 적용 성공을 구분한다. Task4가 snapshot 적용 상태와 실제 점등·복귀를 함께 확인한다.
- 장애 때 단순히 OFF 후 밝기를 강제 덮거나 원장을 삭제하지 않는다. Task3/4가 명시적 해제·복원 상태와 복구 절차를 확인한다.

### Task 1: 기존 실장비 증거 정리와 지원 프로파일 승인안

**Owner:** 총괄; 필요할 때 기존 Gateway/펌웨어 담당에게 제한된 읽기 검토 요청.
**Files:** 참조 `packages/shared/src/bio-sensor-profile-contracts.ts`, `apps/api/src/automation/bio-sensor-profiles.service.ts`, `apps/gateway/src/bio/bio-sensor-profile-catalog.ts`, `docs/project-status.md`, 보호된 기존 현장 시험 원장. 결과는 이 계획과 상태판에 기록하며 비밀·원시 packet은 Git에 넣지 않는다.
**Interfaces:** 검증된 `BioSensorProfileV1` 승인안 또는 항목별 부족 근거 목록을 Task2/3에 제공한다. 실제 profile 등록은 Task3 이전에 하지 않는다.

- [ ] 기존 10월8일 A→B 감지·유지 연장·복귀 원장과 식별 근거를 대조한다. accepted body `0101000000000000` 5건의 의미와 한계를 기록한다. 미검증 `05` body는 허용 목록에 넣지 않는다.
- [ ] 전체 fingerprint(deviceType/firmware major·minor·revision·build/sensorType/infraredType/ambientLightType/hardwareType), exact body, evidenceDigest, reuseScope와 독립 mode-get probeIntervalMs/maxAgeMs의 실제 근거를 항목별 확인한다. 테스트의 1초/5초 값을 운영 기본값으로 복사하지 않는다.
- [ ] 현재 대상이 기존 테스트 현장인지 새 운영 환경인지, 대상 site/gateway와 현재 배포 방식·복원 책임자를 확인한다. 이전 IP·주소·assignment·인증 상태를 현재값으로 단정하지 않는다.
- [ ] 부족한 근거만 좁혀 조사한다. 파일 검토로 해결되면 사용자 참여 없이 진행하고, 실제 packet/링크 확인이 필요하면 목적·소요시간·장비 변경 범위를 먼저 알린다. 이 계획으로 시험을 자동 시작하지 않는다.
- [ ] 승인안이 계약 검증을 통과하고 재사용 범위가 설명되면 완료한다. 미확정 값은 임의로 채우지 않고 해당 장비군 지원 승인만 보류한다.

### Task 2: 현장 적용 준비와 최소 배포 리허설

**Owner:** 총괄이 Backend/Gateway 담당을 순차 배정; 공통 파일 단일 소유자.
**Files:** 참조 `apps/api/prisma/migrations`, `apps/api/test/bio-sensor-catalog-preparation.integration.spec.ts`, `apps/api/test/support/disposable-postgres.ts`, `docs/runbooks/production-api-web-deployment.md`, `docs/runbooks/raspberry-pi-gateway-appliance.md`, 현재 사용 중인 배포 설정. 제품 수정은 발견된 원인을 별도 확정한 뒤에만 한다.
**Interfaces:** exact release/version·migration 목록·배포 순서·MQTT 필요 토픽·백업/복구/중단 범위를 포함한 적용 승인안을 Task3에 제공한다.

- [ ] 실행 시 최신 main과 현재 API/Web/Gateway 버전·기동 방식·pending 작업을 대조한다. 현재 현장에 맞는 기존 배포 경로를 선택하며 BIO에 BlueZ 전용 인자를 적용하지 않는다.
- [ ] 새 disposable PostgreSQL에서 merged migration 전체 적용과 최소 BIO admission/철회 회귀를 확인한다. 운영 DB는 연결하지 않는다.

  실행: `BIO_SENSOR_CATALOG_DISPOSABLE_POSTGRES=1 pnpm --filter @led-control/api exec jest test/bio-sensor-catalog-preparation.integration.spec.ts --runInBand --testNamePattern='starts empty and OFF|exact accepted preparation|valid current source enables|revoked profile disables'`

  성공 기준: 실제 migration exit0, 선택4개 PASS, 비선택 사례는 제외로 기록한다. disposable harness의 synthetic 증거를 RF/현장 검증으로 확대하지 않는다. leaf 실행 전 workspace 준비·Prisma generate와 로컬 PostgreSQL 도구 존재를 확인한다.
- [ ] 카탈로그·준비·capability V2·snapshot/실행 ACK 경로가 현재 API/Gateway와 broker 권한에서 호환되는지 점검한다. ACL 변경이 필요하면 정확한 추가/변경 범위와 되돌림을 승인안에 포함한다.
- [ ] 배포 대상에 필요한 기존 release·보안 관문을 해당 artifact에서 한 번 확인한다. 새 실패는 원인별 최소 수정으로 처리하며 기존 전체 기능 suite를 무조건 재실행하지 않는다.
- [ ] 정책/규칙 OFF로 배포하는 순서와 migration 호환성·백업 복원 책임·중단 예상을 기록한다. 새 schema와 호환성 확인 없이 구 image로 되돌리거나 DB reset/down migration을 제안하지 않는다.
- [ ] 승인안을 사용자에게 제시한다. 아직 배포·DB 쓰기·서비스 중단은 하지 않는다.

### Task 3: 승인된 현장 적용과 공통 센서 준비

**Owner:** Backend→Gateway 담당 순차 실행; 총괄 승인/기록 관리.
**Files:** 기존 `apps/api/src/automation/{bio-sensor-profiles.service,bio-sensor-preparation.service}.ts`, `apps/gateway/src/bio/bio-sensor-runtime.ts`와 현재 배포 절차를 사용한다. 결과는 `docs/project-status.md`, 영향받는 `docs/menus/{control,settings,monitoring}.md`와 본 체크리스트에 실제 증거로 기록한다.
**Interfaces:** 현재 catalog exact ACK·준비 결과·독립 live 관측·sourceEligible·현재 snapshot 적용 근거를 Task4에 전달한다.

- [ ] 대상 환경·릴리스·migration·백업/복원·필요 ACL·중단 범위를 승인받고 실행 직전 상태를 확인한다. PKI 변경이 추가로 필요하면 별도 승인 없이 진행하지 않는다.
- [ ] 현장 정책과 이벤트 규칙은 OFF로 두고 승인된 migration/API/Web/Gateway를 호환 순서로 적용한다. 기존 서비스와 단일 USB 소유, 등록/밝기/이력 보존을 확인한다.
- [ ] 검증된 프로파일을 기존 서비스 공급자 권한의 `POST /bio-sensor-profiles`로 등록한다. 직접 DB 입력·환경 변수 ready 강제·A/B ID 제한을 사용하지 않는다. 현재 catalog revision/hash와 해당 Gateway의 정확 ACK를 확인한다.
- [ ] 현재 현장 관리자의 장애 담당자·최대 대응시간·조치 내용을 UI에서 설정하고 별도 활성 승인 범위에 따라 현장 정책을 켠다. 이 메타데이터를 자동 알림/에스컬레이션 구현 완료로 표시하지 않는다.
- [ ] 일반 UI의 ‘센서 사용 설정’으로 source를 준비한다. 이 단계는 실제 센서 모드 SET일 수 있으므로 승인된 조명만 대상으로 한다. 기존 `POST /bio-sensor-preparations`와 작업 재조회를 사용한다.
- [ ] 현재 서버 `sourceEligible === true`, 최신 준비/독립 링크·catalog 및 계약 상태를 확인한다. 모드만 성공/과거 ready/다른 assignment/미ACK면 활성화를 막고 사유를 조사한다.
- [ ] 실패 시 새 규칙 활성화를 중단한다. 기존 in-flight 대상은 원장을 보존한 명시 해제/복원 절차로 처리하고 실제 readback과 불확실 상태를 구분한다. 일괄 강제 밝기/원장 삭제로 성공을 만들지 않는다.

### Task 4: 정식 UI 한 번의 최소 현장 확인과 인계

**Owner:** 총괄·Gateway 담당; 사용자는 실제 움직임과 밝기 관찰에만 참여.
**Files:** 기존 `apps/web/src/features/control/automation/{VehicleEventDialog,BioSensorPreparationPanel,BioPulseTelemetryStatus}.tsx`와 `apps/gateway/src/automation/bio-pulse-scheduler.ts`를 사용한다. 새 테스트 브라우저/타이머 서버/별도 pilot launcher를 만들지 않는다.
**Interfaces:** 실제 정식 서비스 감지·유지·복귀 및 미검증 경계를 담은 완료 보고를 제공한다.

- [ ] 사용자에게 현장 참여 시간·게이트웨이 중단 가능 범위·시험할 source/targets·밝기·기존 상태를 제시하고 새 시작 신호를 받는다. 정상 감지 시험은 약5~10분을 목표로 하되 배포/복구 시간은 별도로 산정한다.
- [ ] 정식 지도 UI에서 감지 센서1개와 실행 조명을 고르고 밝기·유지시간60초로 저장한다. 규칙 enabled뿐 아니라 현재 desired/applied snapshot 일치를 확인한 뒤 움직임을 요청한다.
- [ ] 감지 시 대상 밝기 적용, 다시 감지 시 같은 발생의 유지시간 연장, 범위 밖·추가 감지 없음 조건에서 만료 후 시험 전 밝기 복귀를 실제 관찰과 telemetry/readback으로 대조한다. 대상은 source 자체와 분리한다.
- [ ] UI에서 유지시간을10초로 수정·적용할 수 있는지 확인한다. 이미 단위/브라우저 검증된 입력 범위를 전부 재시험하지 않는다. 실제10초 동작이 필요한 경우만 짧게 확인하며 센서 알림 공백에 따른 복귀/재점등 가능성을 설명한다.
- [ ] 승인 범위 안에서 연결 장애/회복과 명시적 해제를 필요한 최소1회 확인한다. 실패를 만들기 위한 무승인 USB 분리·프로세스 kill은 하지 않는다. 현장 장애 시험이 승인되지 않으면 해당 항목은 미검증으로 남긴다.
- [ ] 시험 규칙을 유지할지 비활성화할지 사용자 선택을 확인하고, 미확정 복원0·정상 서비스 상태·기존 밝기/ID/이력 보존을 대조한다. 소프트웨어/실제 RF/사용자 관찰을 분리해 문서를 갱신한다.

## 다음 확장 — 이번 실행 범위 아님

1. **센서 조명 자체 밝기 제어:** 기존 자율 점등과 센서 모드를 유지하는 쓰기 명령이 있는지 Gateway/펌웨어 담당과 확인한다. 지원이 확인되면 별도 설계한다. source 보호를 단순 해제하는 방식은 제외한다.
2. **BIO 장애 알림 연계:** 기존 모니터링 알림에 실제 degraded/복원 대기 등을 연결하고 중복 억제·복구·담당자 전달을 설계한다. 현재 정책 필드만으로 자동 에스컬레이션 완료를 주장하지 않는다.
3. **복수 센서와 겹치는 대상:** 한 규칙 복수 source, 재감지·우선순위·대상 공유 정책을 별도로 합의한다. 현재 중첩 제한만 제거하지 않는다.
4. **정확한 재실/부재 판단:** 사용자에게 필요한 경우에만 추진한다. 실제 상태형 패킷/펌웨어 근거 없이 펄스 무수신으로 추정하지 않는다.

## 인계와 범위 확인

- 추천 순서: Tasks1~4로 정식 현장 연동을 먼저 끝낸 뒤 센서 자체 밝기→장애 알림→복수 센서 순서로 별도 설계한다. 정확한 재실 판단은 요구가 있을 때 추가한다.
- 실행 방식: 작은 근거 정리·문서 수정은 총괄이 직접 수행하고, Backend/Gateway 통합·현장 적용처럼 긴 작업만 역할 담당에 순차 위임한다. 필요 시 기존 펌웨어 담당 세션에 범위를 정한 검토를 요청한다.
- 사용자 계획 검토 전 작업을 시작하지 않는다. 계획 승인과 실제 운영/실장비 변경 승인·현장 START는 각각 구분한다.
