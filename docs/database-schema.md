# 데이터베이스 테이블 구조

작성일: 2026-07-11

이 문서는 현재 구현된 PostgreSQL/Prisma 데이터베이스 구조를 정리한다. 기준 파일은 `apps/api/prisma/schema.prisma`이며, 실제 DB 반영은 `apps/api/prisma/migrations`의 migration으로 관리한다.

## 1. 전체 구조

현재 DB는 다음 업무 영역으로 나뉜다.

- 조직/사용자/인증: `Organization`, `User`, `Invitation`, `Session`
- 현장/공간/도면: `Site`, `Floor`, `FloorPlan`, `FloorMapObject`
- 조명/그룹/게이트웨이/메시 노드: `Fixture`, `FixtureGroup`, `GroupFixture`, `Gateway`, `GatewayInventory`, `MeshNode`
- 제어/모니터링: `Command`, `CommandDispatch`, `CommandFixtureResult`, `MqttOutbox`, `ProcessedGatewayEvent`, `EnergyUsage`
- 게이트웨이 claim 감사: `GatewayClaimAudit`
- 조명 검색/등록: `ProvisioningSession`, `DiscoveredMeshNode`

간단한 관계 흐름은 다음과 같다.

```text
Organization
  ├─ User ─ Session
  ├─ Invitation
  └─ Site
      ├─ Floor
      │   ├─ FloorPlan
      │   ├─ FloorMapObject
      │   └─ Fixture ─ MeshNode
      │       ├─ GroupFixture ─ FixtureGroup
      │       └─ EnergyUsage
      ├─ Gateway ─ MeshNode
      │   ├─ GatewayInventory
      │   └─ CommandDispatch ─ CommandFixtureResult
      ├─ Command ─ CommandDispatch ─ MqttOutbox
      └─ ProvisioningSession ─ DiscoveredMeshNode
```

## 2. Enum

### FixtureStatus

조명 상태.

| 값 | 의미 |
| --- | --- |
| `online` | 정상 수신/운영 중 |
| `offline` | 최근 상태 수신 없음 |
| `fault` | 장애 상태 |

### CommandStatus

조명 제어 명령 상태.

| 값 | 의미 |
| --- | --- |
| `pending` | 명령 생성 후 ACK 대기 |
| `acknowledged` | 게이트웨이/장비에서 명령 수신 확인 |
| `failed` | 명령 실패 |

### CommandDispatchStatus / CommandFixtureResultStatus

`CommandDispatchStatus`는 gateway별 전송 상태를 `pending`, `published`, `accepted`, `completed`, `failed`, `timed_out`으로 구분한다. `CommandFixtureResultStatus`는 실제 조명별 결과를 `pending`, `succeeded`, `failed`, `timed_out`으로 구분한다. Gateway acceptance와 실제 장비 status ACK를 같은 의미로 취급하지 않는다.

### UserRole

사용자 권한.

| 값 | 의미 |
| --- | --- |
| `owner` | 조직 소유자 |
| `admin` | 관리자 |
| `operator` | 운영자 |
| `viewer` | 조회 사용자 |

### UserStatus

사용자 계정 상태.

| 값 | 의미 |
| --- | --- |
| `active` | 활성 계정 |
| `disabled` | 비활성 계정 |

### ProvisioningSessionStatus

조명 검색/등록 세션 상태.

| 값 | 의미 |
| --- | --- |
| `active` | 진행 중 |
| `completed` | 완료 |
| `failed` | 실패 |
| `cancelled` | 취소 |

### DiscoveredNodeStatus

검색된 미등록 노드 상태.

| 값 | 의미 |
| --- | --- |
| `discovered` | 검색됨 |
| `identifying` | 점멸 확인 중 |
| `provisioning` | 등록 진행 중 |
| `provisioned` | 등록 완료 |
| `failed` | 등록 실패 |

### FloorPlanSourceType

층별 도면 에디터에서 도면 배경 원본의 종류를 구분하기 위한 enum이다.

| 값 | 의미 |
| --- | --- |
| `none` | 배경 없이 격자 캔버스만 사용 |
| `image` | JPG 또는 PNG 이미지 원본 사용 |
| `pdf` | PDF 첫 페이지를 렌더링한 이미지 사용 |

## 3. 테이블 상세

### Organization

고객사 또는 운영 조직 단위다. 대부분의 데이터는 `Organization -> Site` 또는 `Organization -> User`를 통해 조직 범위로 분리된다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 조직 ID |
| `name` | `String` | 예 |  | 조직명 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

관계:

- `users`: `User[]`
- `sites`: `Site[]`
- `invitations`: `Invitation[]`

### User

서비스 사용자 계정이다. 로그인은 이메일/비밀번호 기반이며, 비밀번호는 hash로 저장한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 사용자 ID |
| `organizationId` | `String` | 예 | FK -> `Organization.id` | 소속 조직 |
| `email` | `String` | 예 | Unique | 로그인 이메일 |
| `name` | `String` | 예 |  | 사용자 이름 |
| `passwordHash` | `String` | 예 |  | 비밀번호 hash |
| `role` | `UserRole` | 예 |  | 권한 |
| `status` | `UserStatus` | 예 | `active` | 계정 상태 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

관계:

- `organization`: `Organization`
- `commands`: `Command[]`
- `sessions`: `Session[]`
- `provisioningSessions`: `ProvisioningSession[]`

### Site

실제 설치 현장이다. 주차장 한 곳 또는 건물 단지를 표현한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 현장 ID |
| `organizationId` | `String` | 예 | FK -> `Organization.id` | 소속 조직 |
| `name` | `String` | 예 |  | 현장명 |
| `address` | `String` | 예 |  | 주소 |
| `tariffKwhRate` | `Decimal(10,2)` | 예 |  | kWh 단가 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

관계:

- `organization`: `Organization`
- `floors`: `Floor[]`
- `gateways`: `Gateway[]`
- `groups`: `FixtureGroup[]`
- `commands`: `Command[]`
- `invitations`: `Invitation[]`
- `provisioningSessions`: `ProvisioningSession[]`

### Floor

현장 내 층 단위다. 지하주차장 기준으로 `B2`, `B1` 같은 층을 표현한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 층 ID |
| `siteId` | `String` | 예 | FK -> `Site.id` | 소속 현장 |
| `name` | `String` | 예 |  | 층 이름 |
| `level` | `Int` | 예 |  | 정렬/층 숫자 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

관계:

- `site`: `Site`
- `floorPlan`: `FloorPlan?`
- `mapObjects`: `FloorMapObject[]`
- `fixtures`: `Fixture[]`
- `provisioningSessions`: `ProvisioningSession[]`

### FloorPlan

층 도면 이미지와 좌표계 정보를 저장한다. `Floor`와 1:1 관계다. 층별 도면 에디터 작업에서 배경 없음, 이미지 원본, PDF 렌더링 결과를 표현한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 도면 ID |
| `floorId` | `String` | 예 | Unique, FK -> `Floor.id` | 층 ID |
| `imageUrl` | `String` | 예 |  | 도면 이미지 URL |
| `width` | `Int` | 예 |  | 도면 기준 너비 |
| `height` | `Int` | 예 |  | 도면 기준 높이 |
| `version` | `Int` | 예 | `1` | 도면 버전 |
| `sourceType` | `FloorPlanSourceType` | 예 | `image` | 배경 원본 종류. 기존 도면은 이미지로 간주 |
| `originalFileUrl` | `String?` | 아니오 |  | 업로드한 원본 JPG/PNG/PDF 파일 URL |
| `renderedImageUrl` | `String?` | 아니오 |  | PDF 첫 페이지 또는 후처리된 배경 이미지 URL |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

관계:

- `floor`: `Floor`

운영 메모:

- 현재 읽기 전용 모니터링 화면은 `imageUrl`, `width`, `height`를 사용한다.
- 구현 중인 에디터에서는 `sourceType = none`이거나 `FloorPlan`이 없을 때 배경 없는 격자 캔버스를 표시한다.
- PDF 업로드는 원본을 `originalFileUrl`에 보관하고, 첫 페이지 렌더링 결과를 `renderedImageUrl`로 표시하는 방향이다.

### FloorMapObject

층별 도면 에디터에서 사용자가 추가하는 도형과 텍스트 객체를 저장한다. 조명 위치는 기존 `Fixture.x`, `Fixture.y`를 계속 사용하고, 사각형/텍스트 같은 비조명 편집 객체만 이 테이블로 분리한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 도면 객체 ID |
| `floorId` | `String` | 예 | FK -> `Floor.id` | 소속 층 |
| `type` | `String` | 예 |  | `rectangle`, `text` 등 에디터 오브젝트 타입 |
| `x` | `Float` | 예 |  | 도면 기준 X 좌표 |
| `y` | `Float` | 예 |  | 도면 기준 Y 좌표 |
| `width` | `Float?` | 아니오 |  | 사각형/삼각형 등 면 객체 너비 |
| `height` | `Float?` | 아니오 |  | 사각형/삼각형 등 면 객체 높이 |
| `rotation` | `Float` | 예 | `0` | 회전 각도 |
| `points` | `Json?` | 아니오 |  | 선 또는 다각형 좌표 배열 |
| `text` | `String?` | 아니오 |  | 텍스트 객체 내용 |
| `strokeColor` | `String` | 예 | `#0b63e5` | 선 색상 |
| `fillColor` | `String?` | 아니오 |  | 채움 색상 |
| `strokeWidth` | `Float` | 예 | `2` | 선 두께 |
| `fontSize` | `Float?` | 아니오 |  | 텍스트 크기 |
| `zIndex` | `Int` | 예 | `0` | 같은 층 안의 렌더링 순서 |
| `locked` | `Boolean` | 예 | `false` | 편집 잠금 여부 |
| `visible` | `Boolean` | 예 | `true` | 화면 표시 여부 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

제약:

- Index: `floorId`, `zIndex`

관계:

- `floor`: `Floor`

운영 메모:

- 이 모델은 층별 도면 에디터 MVP1의 비조명 편집 객체를 저장한다.
- 향후 구역/그룹 객체를 정식 도메인으로 승격할 경우 `type` 문자열 대신 전용 enum 또는 별도 테이블로 분리할 수 있다.

### Fixture

개별 LED 조명이다. 위치, 밝기, 상태, 통신 품질 최신 snapshot을 가진다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 조명 ID |
| `floorId` | `String` | 예 | FK -> `Floor.id` | 설치 층 |
| `meshNodeId` | `String?` | 아니오 | Unique, FK -> `MeshNode.id` | 연결된 BLE Mesh 노드 |
| `name` | `String` | 예 |  | 조명 이름 |
| `ratedWatt` | `Decimal(8,2)` | 예 |  | 정격 전력 W |
| `x` | `Float` | 예 |  | 도면 기준 X 좌표 |
| `y` | `Float` | 예 |  | 도면 기준 Y 좌표 |
| `size` | `Float` | 예 | `20` | 도면 에디터에서 표시되는 조명 노드 지름 |
| `status` | `FixtureStatus` | 예 | `offline` | 현재 상태 |
| `brightness` | `Int` | 예 | `0` | 현재 밝기 0-100 |
| `rssi` | `Int?` | 아니오 |  | 최근 RSSI |
| `hopCount` | `Int?` | 아니오 |  | 최근 BLE Mesh hop 수 |
| `commandSuccessRate` | `Float?` | 아니오 |  | 최근 명령 성공률 |
| `lastSeenAt` | `DateTime?` | 아니오 |  | 마지막 상태 수신 시각 |
| `lastStateEventId` | `String?` | 아니오 | Unique | 마지막 적용 MQTT v2 이벤트 ID |
| `lastStateSequence` | `BigInt?` | 아니오 |  | 마지막 적용 gateway sequence |
| `lastStateOccurredAt` | `DateTime?` | 아니오 |  | 장치 상태 발생 시각 |
| `statusReason` | `String?` | 아니오 |  | reported, fixture_stale, gateway_offline 등 상태 근거 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

관계:

- `floor`: `Floor`
- `meshNode`: `MeshNode?`
- `groupFixtures`: `GroupFixture[]`
- `energyUsages`: `EnergyUsage[]`

운영 메모:

- `rssi`, `hopCount`, `commandSuccessRate`, `lastSeenAt`은 장기 이력 테이블이 아니라 최신 모니터링 snapshot이다.
- 현재 MQTT `fixture-state` event 수신 시 이 값들이 갱신된다.

### FixtureGroup

조명 그룹 또는 구역이다. 그룹 제어의 대상이 된다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 그룹 ID |
| `siteId` | `String` | 예 | FK -> `Site.id` | 소속 현장 |
| `name` | `String` | 예 |  | 그룹명 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

관계:

- `site`: `Site`
- `groupFixtures`: `GroupFixture[]`

### GroupFixture

`FixtureGroup`과 `Fixture`의 N:M 연결 테이블이다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `groupId` | `String` | 예 | PK 복합키, FK -> `FixtureGroup.id` | 그룹 ID |
| `fixtureId` | `String` | 예 | PK 복합키, FK -> `Fixture.id` | 조명 ID |

제약:

- 복합 PK: `groupId`, `fixtureId`

관계:

- `group`: `FixtureGroup`
- `fixture`: `Fixture`

### Gateway

현장에 설치된 라즈베리파이 게이트웨이다. BLE Mesh와 클라우드 사이의 연결 지점이다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 게이트웨이 ID |
| `siteId` | `String` | 예 | FK -> `Site.id` | 소속 현장 |
| `name` | `String` | 예 |  | 게이트웨이 이름 |
| `serialNumber` | `String` | 예 | Unique | 게이트웨이 시리얼 |
| `firmwareVersion` | `String` | 예 |  | 펌웨어 버전 |
| `lastHeartbeatAt` | `DateTime?` | 아니오 |  | 마지막 heartbeat 수신 시각 |
| `certificateFingerprint` | `String?` | 아니오 | Unique | claim된 장치 인증서 SHA-256 fingerprint |
| `assignmentVersion` | `Int` | 예 | `0` | gateway bootstrap 설정 버전 |
| `claimedAt` | `DateTime?` | 아니오 |  | 현장 claim 완료 시각 |
| `lastHeartbeatEventId` | `String?` | 아니오 | Unique | 마지막 heartbeat 이벤트 ID |
| `lastHeartbeatSequence` | `BigInt?` | 아니오 |  | 마지막 heartbeat sequence |
| `lastHeartbeatOccurredAt` | `DateTime?` | 아니오 |  | heartbeat 발생 시각 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

관계:

- `site`: `Site`
- `meshNodes`: `MeshNode[]`
- `provisioningSessions`: `ProvisioningSession[]`

운영 메모:

- `connectionStatus`는 DB 컬럼이 아니라 `lastHeartbeatAt` 기준으로 API에서 계산한다.

### GatewayInventory / GatewayClaimAudit

`GatewayInventory`는 제조 또는 출고 시 등록된 장비 identity 원장이다. `serialNumber`, 일회성 `claimCodeHash`, 장치 인증서 `certificateFingerprint`, claim 결과인 `claimedGatewayId/claimedAt`, 폐기 상태 `disabledAt`을 저장한다. claim code 원문과 인증서 private key는 DB와 Git에 저장하지 않는다.

`GatewayClaimAudit`는 성공·실패 claim 시도의 inventory/site/user, serial, outcome, reason, IP, 시각을 기록한다. Claim 성공 transaction은 `GatewayInventory.claimCodeHash`를 `null`로 폐기해 재사용을 차단한다.

### MeshNode

ESP32-H2 BLE Mesh 노드다. 한 노드는 최대 하나의 `Fixture`와 매핑된다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 메시 노드 ID |
| `gatewayId` | `String` | 예 | FK -> `Gateway.id` | 연결 게이트웨이 |
| `deviceUuid` | `String?` | 아니오 | Unique | BLE Mesh device UUID |
| `serialNumber` | `String?` | 아니오 |  | 장비 시리얼 |
| `meshAddress` | `String` | 예 | Unique with `gatewayId` | BLE Mesh unicast address |
| `firmwareVersion` | `String` | 예 |  | 노드 펌웨어 버전 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

제약:

- Unique: `deviceUuid`
- 복합 Unique: `gatewayId`, `meshAddress`

관계:

- `gateway`: `Gateway`
- `fixture`: `Fixture?`

### Command

조명 제어 명령 이력이다. 개별 조명 또는 그룹 제어를 모두 표현한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 명령 ID |
| `siteId` | `String` | 예 | FK -> `Site.id` | 대상 현장 |
| `requestedBy` | `String` | 예 | FK -> `User.id` | 요청 사용자 |
| `targetType` | `String` | 예 |  | `fixture` 또는 `group` |
| `targetId` | `String` | 예 |  | 대상 조명/그룹 ID |
| `brightness` | `Int` | 예 |  | 요청 밝기 0-100 |
| `status` | `CommandStatus` | 예 | `pending` | 명령 상태 |
| `errorMessage` | `String?` | 아니오 |  | 실패 사유 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

관계:

- `site`: `Site`
- `user`: `User`

운영 메모:

- `targetType`, `targetId`는 다형 대상 구조라 DB FK로 직접 강제하지 않는다.
- MQTT command ACK 수신 시 `status`, `errorMessage`가 갱신된다.

### CommandDispatch / CommandFixtureResult / MqttOutbox

`CommandDispatch`는 하나의 사용자 `Command`를 소유 gateway별로 분할한 전송 단위다. `idempotencyKey`는 전체 unique, `(gatewayId, sequence)`도 unique이며 acceptance/device status 진행 상태와 오류를 저장한다.

`Gateway.nextCommandSequence`는 gateway별 dispatch sequence를 트랜잭션 안에서 원자 증가시키는 카운터다. 동시 제어 요청에서도 `(gatewayId, sequence)`가 충돌하지 않도록 `max(sequence)+1` 계산을 사용하지 않는다.

`CommandFixtureResult`는 `(dispatchId, fixtureId)` 복합 PK로 실제 조명별 `succeeded`, `failed`, `timed_out`, 밝기, fault, RSSI, hop, 발생 시각을 저장한다. 일부 노드 실패를 그룹 전체 성공으로 숨기지 않는다.

`MqttOutbox`는 dispatch와 1:1로 연결되며 topic, JSON payload, attempts, nextAttemptAt, publishedAt, lastError를 저장한다. Command와 outbox를 같은 DB transaction에서 생성해 MQTT publish 실패로 `pending` 명령이 유실되는 문제를 방지한다.

### ProcessedGatewayEvent

MQTT QoS 1 중복 및 순서 역전을 차단하는 이벤트 원장이다. `eventId`를 PK로 사용하고 `(gatewayId, sequence, eventType)`을 unique로 둔다. 이벤트를 Fixture/Gateway snapshot에 반영하기 전에 이 테이블과 마지막 sequence를 확인한다.

### Invitation

초대 기반 회원가입을 위한 토큰 정보다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 초대 ID |
| `organizationId` | `String` | 예 | FK -> `Organization.id` | 초대 조직 |
| `siteId` | `String?` | 아니오 | FK -> `Site.id` | 초대 대상 현장 |
| `email` | `String?` | 아니오 |  | 초대 이메일 |
| `role` | `UserRole` | 예 |  | 가입 후 권한 |
| `tokenHash` | `String` | 예 | Unique | 초대 토큰 hash |
| `expiresAt` | `DateTime` | 예 |  | 만료 시각 |
| `acceptedAt` | `DateTime?` | 아니오 |  | 수락 시각 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

관계:

- `organization`: `Organization`
- `site`: `Site?`

### Session

서버 저장 session이다. 브라우저에는 원본 token을 HttpOnly cookie로 저장하고, DB에는 token hash만 저장한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 세션 ID |
| `userId` | `String` | 예 | FK -> `User.id` | 사용자 ID |
| `tokenHash` | `String` | 예 | Unique | 세션 토큰 hash |
| `rememberMe` | `Boolean` | 예 | `false` | 자동 로그인 여부 |
| `userAgent` | `String?` | 아니오 |  | 접속 user agent |
| `ipAddress` | `String?` | 아니오 |  | 접속 IP |
| `expiresAt` | `DateTime` | 예 |  | 만료 시각 |
| `revokedAt` | `DateTime?` | 아니오 |  | 폐기 시각 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

관계:

- `user`: `User`

### ProvisioningSession

층/게이트웨이 단위 조명 검색 및 등록 작업 세션이다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 등록 세션 ID |
| `siteId` | `String` | 예 | FK -> `Site.id` | 현장 ID |
| `floorId` | `String` | 예 | FK -> `Floor.id` | 등록 대상 층 |
| `gatewayId` | `String` | 예 | FK -> `Gateway.id` | 스캔/등록 게이트웨이 |
| `requestedBy` | `String` | 예 | FK -> `User.id` | 요청 사용자 |
| `status` | `ProvisioningSessionStatus` | 예 | `active` | 세션 상태 |
| `startedAt` | `DateTime` | 예 | `now()` | 시작 시각 |
| `completedAt` | `DateTime?` | 아니오 |  | 완료 시각 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

관계:

- `site`: `Site`
- `floor`: `Floor`
- `gateway`: `Gateway`
- `user`: `User`
- `discoveredNodes`: `DiscoveredMeshNode[]`

### DiscoveredMeshNode

등록 세션 중 발견된 미등록 ESP32-H2 노드 후보 목록이다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 발견 노드 ID |
| `sessionId` | `String` | 예 | FK -> `ProvisioningSession.id` | 등록 세션 |
| `deviceUuid` | `String` | 예 | Unique with `sessionId` | BLE Mesh device UUID |
| `serialNumber` | `String` | 예 |  | 장비 시리얼 |
| `rssi` | `Int` | 예 |  | 발견 시 RSSI |
| `oobCapability` | `String` | 예 |  | OOB capability |
| `firmwareVersion` | `String` | 예 |  | 펌웨어 버전 |
| `status` | `DiscoveredNodeStatus` | 예 | `discovered` | 발견 노드 상태 |
| `identifyState` | `String` | 예 | `idle` | 점멸 확인 상태 |
| `meshAddress` | `String?` | 아니오 |  | 할당 예정 또는 할당된 mesh address |
| `pendingFixtureName` | `String?` | 아니오 |  | provisioning 완료 후 생성할 fixture 이름 |
| `pendingFixtureX` | `Float?` | 아니오 |  | provisioning 완료 후 생성할 fixture X 좌표 |
| `pendingFixtureY` | `Float?` | 아니오 |  | provisioning 완료 후 생성할 fixture Y 좌표 |
| `pendingRatedWatt` | `Decimal(8,2)?` | 아니오 |  | provisioning 완료 후 생성할 fixture 정격 전력 |
| `errorMessage` | `String?` | 아니오 |  | 실패 사유 |
| `discoveredAt` | `DateTime` | 예 | `now()` | 발견 시각 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

제약:

- 복합 Unique: `sessionId`, `deviceUuid`

관계:

- `session`: `ProvisioningSession`

### EnergyUsage

조명별 전력 사용량과 예상 요금 집계 테이블이다. MVP에서는 추정값 중심으로 사용한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 사용량 ID |
| `fixtureId` | `String` | 예 | FK -> `Fixture.id` | 대상 조명 |
| `source` | `String` | 예 |  | `estimated`, `measured`, `adjusted` 등 |
| `period` | `String` | 예 |  | 일/월/년 또는 집계 기간 |
| `kwh` | `Decimal(12,4)` | 예 |  | 사용 전력량 |
| `cost` | `Decimal(12,2)` | 예 |  | 예상 요금 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |

관계:

- `fixture`: `Fixture`

## 4. 주요 제약 조건 요약

| 테이블 | 제약 | 설명 |
| --- | --- | --- |
| `User` | Unique `email` | 이메일 중복 가입 방지 |
| `FloorPlan` | Unique `floorId` | 한 층에 하나의 현재 도면 |
| `FloorMapObject` | Index `floorId`, `zIndex` | 한 층 안에서 편집 객체 렌더링 순서 조회 최적화 |
| `Fixture` | Unique `meshNodeId` | 하나의 메시 노드는 하나의 조명에만 연결 |
| `Gateway` | Unique `serialNumber` | 게이트웨이 시리얼 중복 방지 |
| `GatewayInventory` | Unique `serialNumber`, `certificateFingerprint`, `claimedGatewayId` | 제조 identity 및 일회성 claim 보장 |
| `CommandDispatch` | Unique `idempotencyKey`, `gatewayId + sequence` | 중복 명령과 순서 충돌 방지 |
| `CommandFixtureResult` | PK `dispatchId + fixtureId` | dispatch별 조명 결과 중복 방지 |
| `ProcessedGatewayEvent` | PK `eventId`, Unique `gatewayId + sequence + eventType` | QoS 중복·stale 이벤트 방지 |
| `MeshNode` | Unique `deviceUuid` | BLE Mesh device UUID 중복 방지 |
| `MeshNode` | Unique `gatewayId`, `meshAddress` | 같은 게이트웨이 내 mesh address 중복 방지 |
| `GroupFixture` | PK `groupId`, `fixtureId` | 같은 조명의 그룹 중복 매핑 방지 |
| `Invitation` | Unique `tokenHash` | 초대 토큰 hash 중복 방지 |
| `Session` | Unique `tokenHash` | 세션 토큰 hash 중복 방지 |
| `DiscoveredMeshNode` | Unique `sessionId`, `deviceUuid` | 같은 등록 세션 안에서 발견 노드 중복 방지 |

## 5. 현재 구현 기준으로 중요한 데이터 흐름

### 로그인

```text
User.email/password
→ AuthService 비밀번호 검증
→ Session 생성
→ HttpOnly cookie 발급
→ 이후 API 요청에서 Session token hash 검증
```

### 모니터링

```text
Mock gateway 또는 실제 gateway
→ MQTT fixture-state event
→ Fixture brightness/status/RSSI/hop/commandSuccessRate/lastSeenAt 갱신
→ GET /sites/default/dashboard
→ 웹 모니터링 화면 표시
```

### 게이트웨이 상태

```text
Gateway heartbeat MQTT event
→ Gateway.lastHeartbeatAt 갱신
→ dashboard API에서 online/offline 계산
→ 웹 상단/상세 패널 표시
```

### 조명 제어

```text
웹 제어 요청
→ Command pending 생성
→ MQTT dimming command 발행
→ gateway command ACK event
→ Command status/errorMessage 갱신
```

### 조명 검색/등록

```text
ProvisioningSession 생성
→ gateway scan command 발행
→ unprovisioned-device-found event
→ DiscoveredMeshNode upsert
→ identify 확인
→ register 요청 시 DiscoveredMeshNode에 pending fixture 정보 저장
→ gateway provision-device command 발행
→ provisioning-completed event
→ MeshNode 생성 또는 기존 MeshNode 재사용
→ Fixture 생성 또는 기존 Fixture 유지
→ provisioning-failed event 수신 시 DiscoveredMeshNode failed/errorMessage 갱신
```

### 현장·층 초기 설정

```text
최초 로그인 또는 빈 조직 상태
→ Site 생성
→ Floor 일괄 생성
→ 선택적으로 FloorPlan 생성
→ 선택적으로 Gateway 수동 등록
→ 조명 검색/등록 가능 상태
```

현장·층 온보딩 MVP 1에서는 `Site`, `Floor`, `FloorPlan`, `Gateway` 기존 모델을 그대로 사용한다. 층별 게이트웨이 커버리지, 주차면 수, 층 설명은 실제 파일럿 요구가 확인된 뒤 별도 컬럼 또는 테이블로 분리한다.

### 층별 도면 에디터

```text
GET /floors/{floorId}/editor-state
→ Floor, FloorPlan, Fixture, FloorMapObject 조회
→ 웹 에디터에서 도면 배경, 도형, 텍스트, 조명 위치 draft 편집
→ PATCH /floors/{floorId}/floor-plan
→ POST/PATCH/DELETE /floor-map-objects
→ PATCH /fixtures/{fixtureId}
→ dashboard query 갱신
```

모든 조회와 수정은 `Floor -> Site -> Organization`, `Fixture -> Floor -> Site -> Organization`, `FloorMapObject -> Floor -> Site -> Organization` 경로로 로그인 사용자의 조직 범위를 검증한다.

## 6. 운영상 아직 분리가 필요한 후보

최신 상태 snapshot은 `Fixture`, `Gateway`에 저장하고, command fan-out·outbox·중복 이벤트 원장은 별도 테이블로 분리했다. 다음 시계열/정책 테이블은 후속 범위다.

- `FixtureMetric`: RSSI, hop count, latency, command success rate의 시계열 이력
- `GatewayMetric`: heartbeat, CPU/memory/disk, MQTT 연결 상태 이력
- `CommandLog`: 명령 전송, ACK, retry, failure reason 상세 로그
- `OtaPackage`, `OtaDeployment`: 게이트웨이/노드 OTA 패키지와 배포 이력
- `Tariff`: 현장별 전기요금제와 계약전력 설정
- `EventPolicy`, `Schedule`: 차량 감지 등 이벤트 제어와 스케줄 제어 정책
- `GatewayCoverage`: 게이트웨이가 담당하는 층/구역 커버리지
- `Floor.description`, `Floor.parkingCapacity`: 층 설명과 주차면 수

## 7. 문서 갱신 규칙

DB 구조가 변경될 때는 다음 순서로 함께 갱신한다.

1. `apps/api/prisma/schema.prisma`
2. `apps/api/prisma/migrations/*/migration.sql`
3. 이 문서 `docs/database-schema.md`
4. 필요한 경우 API 테스트, 웹 테스트, `docs/lesson_leared.md`
