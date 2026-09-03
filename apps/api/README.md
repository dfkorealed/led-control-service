# API 코드 입문 안내

`apps/api`는 Web의 HTTP 요청과 Gateway의 MQTT 메시지를 받아 권한, 업무 규칙, DB 저장을 연결하는 NestJS API입니다. 애플리케이션은 [src/main.ts](src/main.ts)에서 시작하고, 사용할 기능 모듈은 [src/app.module.ts](src/app.module.ts)에 모여 있습니다.

## 프론트엔드의 익숙한 개념과 대응하기

| 프론트엔드에서 익숙한 개념 | API에서 찾을 위치 | 하는 일 |
| --- | --- | --- |
| route handler | `*.controller.ts`의 Controller | HTTP 경로, 인증 guard, 요청 body/param을 받고 Service를 호출합니다. |
| domain/use-case | `*.service.ts`의 Service | 권한 확인, 입력 검증, 업무 규칙과 오류 처리를 수행합니다. |
| query/mutation 저장소 | `PrismaService`와 `$transaction` | PostgreSQL 모델을 읽고 쓰며, 함께 성공하거나 실패해야 하는 변경을 transaction으로 묶습니다. |
| event listener | [src/mqtt/mqtt.service.ts](src/mqtt/mqtt.service.ts)의 MQTT consumer | Gateway topic을 구독하고 shared 계약을 검증한 뒤, 상태·ACK·등록 이벤트를 해당 Service에 전달합니다. |

데이터 모델의 전체 목록과 관계는 [prisma/schema.prisma](prisma/schema.prisma)에서 확인합니다. Web과 Gateway가 함께 쓰는 MQTT topic·payload 계약은 [../../packages/shared/src/gateway-contracts.ts](../../packages/shared/src/gateway-contracts.ts)가 정본입니다. 화면에서 임의의 payload 모양을 만들기보다 이 계약의 schema와 타입을 기준으로 API 응답 및 상태를 이해합니다.

## 기능별로 따라가기

### 1. 최초 운영사 계정 만들기

운영사 operator는 HTTP 화면 흐름이 아니라 빈 DB에서만 실행하는 bootstrap 명령으로 만듭니다. 구현은 [src/auth/bootstrap-operator.ts](src/auth/bootstrap-operator.ts)입니다.

`bootstrapFirstOperator → Prisma transaction → Organization(type: service_provider), User(role: operator)` 순서이며, advisory lock과 기존 operator 확인으로 중복 생성을 막습니다. 실행 방법과 비밀값 취급은 루트 [README](../../README.md#로컬-실장비-개발-환경)를 따릅니다.

### 2. 고객사, 현장, 현장 admin 만들기

운영자 화면의 요청은 [src/operator-site-admins/operator-site-admins.controller.ts](src/operator-site-admins/operator-site-admins.controller.ts)에서 받고, [src/operator-site-admins/operator-site-admins.service.ts](src/operator-site-admins/operator-site-admins.service.ts)가 처리합니다.

`Controller → createSiteAdmin Service → Organization(type: customer), User(role: admin), Site` 순서로 한 transaction에서 생성합니다. 그래서 프론트엔드는 성공 응답을 받은 뒤에만 고객사·현장·admin이 모두 준비됐다고 취급하면 됩니다.

### 3. Gateway claim과 bootstrap

현장 admin의 claim 요청은 [src/gateway-onboarding/gateway-onboarding.controller.ts](src/gateway-onboarding/gateway-onboarding.controller.ts)의 `POST /gateways/claim`으로 들어가고, [src/gateway-onboarding/gateway-onboarding.service.ts](src/gateway-onboarding/gateway-onboarding.service.ts)가 처리합니다.

`Controller → claimGateway Service → GatewayInventory 확인, Gateway 생성, GatewayClaimAudit 기록` 순서입니다. claim code는 한 번만 소비됩니다. Gateway 자체는 device certificate guard를 통과한 뒤 `POST /gateway-bootstrap`으로 assignment를 받고, `Gateway`의 siteId·assignmentVersion을 사용해 MQTT 연결을 준비합니다.

### 4. 조명 등록 session

등록 화면은 [src/registration/registration.controller.ts](src/registration/registration.controller.ts)와 [src/registration/registration.service.ts](src/registration/registration.service.ts)를 먼저 읽습니다.

`Controller → RegistrationService → ProvisioningSession, DiscoveredMeshNode` 순서로 session과 발견 장비 정보를 관리합니다. scan 재시도와 개별/묶음 등록·완료는 HTTP API로 제공되고, scan 및 provision 명령은 MQTT를 통해 Gateway로 전달됩니다. `identify` HTTP 경로는 현재 존재하지만 `501 NOT_IMPLEMENTED`와 `pre_provision_identify_unsupported`를 반환하므로, 화면에서 동작하는 identify 기능으로 제공하면 안 됩니다.

등록 요청은 Gateway에 provision 명령을 보낼 준비만 하며 Fixture를 즉시 만들지 않습니다. Gateway가 provisioning 완료 MQTT 이벤트를 보낸 뒤 [src/mqtt/mqtt.service.ts](src/mqtt/mqtt.service.ts)의 MQTT consumer가 transaction 안에서 `DiscoveredMeshNode → MeshNode → Fixture`를 처리합니다. 여기서 **MQTT consumer**는 broker에서 도착한 Gateway 메시지를 받아 API 저장 로직으로 넘기는 코드입니다. 등록 중 화면은 HTTP 응답만으로 설치 완료를 확정하지 말고, session 상태와 발견 node 목록을 다시 조회해 비동기 완료 결과를 반영해야 합니다.

### 5. Gateway가 보내는 조명 상태

Gateway는 fixture state topic으로 상태를 보냅니다. [src/mqtt/mqtt.service.ts](src/mqtt/mqtt.service.ts)가 topic 범위와 shared schema를 확인하고, [src/energy/fixture-state-ingestion.service.ts](src/energy/fixture-state-ingestion.service.ts)로 넘깁니다.

`MQTT consumer → FixtureStateIngestionService → ProcessedGatewayEvent, Fixture, FixtureEnergyStateCursor, FixtureEnergyDailyAggregate` 순서로 저장됩니다. 이 transaction은 eventId·sequence 중복을 구분하고, 장비가 속한 site와 Gateway 범위도 검사합니다. 따라서 화면은 MQTT 전송 성공만으로 상태 변경을 확정하지 말고, API가 반환하는 최신 Fixture 상태를 표시 기준으로 삼아야 합니다.

## 다음에 읽을 파일

1. [src/main.ts](src/main.ts)와 [src/app.module.ts](src/app.module.ts)로 API 시작과 모듈 구성을 확인합니다.
2. [src/auth/auth.controller.ts](src/auth/auth.controller.ts)와 [src/auth/auth.service.ts](src/auth/auth.service.ts)로 세션 인증 흐름을 확인합니다.
3. 화면에서 필요한 기능의 Controller를 찾고 같은 이름의 Service, `prisma/schema.prisma` 순서로 읽습니다.
4. Gateway와 연결되는 기능이라면 마지막으로 [../../packages/shared/src/gateway-contracts.ts](../../packages/shared/src/gateway-contracts.ts)와 [../gateway/src/index.ts](../gateway/src/index.ts)를 함께 봅니다.
