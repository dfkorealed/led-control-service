# 데이터베이스 테이블 구조

작성일: 2026-08-26

이 문서는 현재 구현된 PostgreSQL/Prisma 데이터베이스 구조를 정리한다. 기준 파일은 `apps/api/prisma/schema.prisma`이며, 실제 DB 반영은 `apps/api/prisma/migrations`의 migration으로 관리한다.

## 1. 전체 구조

현재 DB는 다음 업무 영역으로 나뉜다.

- 조직/사용자/인증: `Organization`(`OrganizationType`), `User`, `SiteMembership`, `Invitation`, `Session`
- 현장/공간/도면: `Site`, `Floor`(`mapRevision`), `FloorPlan`, `FloorMapObject`, `FloorMapRevision`
- 조명/그룹/게이트웨이/메시 노드: `Fixture`, `FixtureGroup`, `GroupFixture`, `Gateway`, `GatewayInventory`, `MeshNode`, `MeshControlGroup`, `MeshControlGroupMember`, `MeshControlGroupExpectedOperation`, `MeshControlGroupAppliedMember`
- 게이트웨이 PKI: `GatewayEnrollment`, `GatewayCertificate`
- 제어/모니터링: `Command`, `CommandDispatch`, `CommandFixtureResult`, `MqttOutbox`, `ProcessedGatewayEvent`, `EnergyUsage`
- 감사: `GatewayClaimAudit`, `AuditLog`
- 조명 검색/등록: `ProvisioningSession`, `ProvisioningScanOutbox`, `DiscoveredMeshNode`

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
      │   ├─ GatewayCertificate
      │   └─ MeshControlGroup ─ MeshControlGroupMember
      │                      ├─ MeshControlGroupExpectedOperation
      │                      └─ MeshControlGroupAppliedMember
      │   └─ CommandDispatch ─ CommandFixtureResult
      ├─ Command ─ CommandDispatch ─ MqttOutbox
      └─ ProvisioningSession ─ ProvisioningScanOutbox
                             └─ DiscoveredMeshNode
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

### MeshControlTargetType / MeshControlGroupStatus

`MeshControlTargetType`은 gateway별 제어 group이 가리키는 대상을 `floor`, `fixture_group`으로 구분한다. `MeshControlGroupStatus`는 subscription 적용 상태를 `configuring`, `ready`, `failed`로 관리하고, 삭제 전 정리 단계와 완료 상태를 `retiring`, `retired`로 구분한다.

### FixtureGroupLifecycleStatus

조명 그룹의 업무 수명주기다. 새 그룹은 `active`로 생성하며, migration은 기존 그룹이 같은 site/floor/gateway에 속하고 fixture별 활성/정리중 그룹 수가 15개 이하일 때만 `active`로 backfill한다. 그 외 기존 그룹은 `invalid`로 격리한다. `retiring`은 gateway subscription 정리 중, `retired`는 더 이상 제어하지 않는 완료 상태다.

### ProvisioningScanStatus

검색 시도의 상태다. `pending`은 아직 시작하지 않음, `scanning`은 gateway가 수행 중, `completed`는 정상 종료(발견 0건 포함), `failed`는 gateway 또는 전송 실패를 뜻한다. scan event는 gateway-scoped v2 envelope(`eventId`, `sequence`, `occurredAt`)로만 수신한다.

### UserRole

사용자 권한.

| 값 | 의미 |
| --- | --- |
| `operator` | 서비스 운영사 운영자 |
| `admin` | 고객사 관리자 |
| `viewer` | 조회 사용자 |

### OrganizationType

조직 유형을 서비스 운영사와 고객사로 구분한다.

| 값 | 의미 |
| --- | --- |
| `service_provider` | 고객 현장을 설치·운영하는 서비스 운영사 |
| `customer` | 실제 현장과 관리자를 가진 고객사 |

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
| `reconcile_required` | 물리 provisioning 적용 여부를 먼저 확인해야 하는 상태 |

### FloorPlanSourceType

층별 도면 에디터에서 도면 배경 원본의 종류를 구분하기 위한 enum이다.

| 값 | 의미 |
| --- | --- |
| `none` | 배경 없이 격자 캔버스만 사용 |
| `image` | JPG 또는 PNG 이미지 원본 사용 |
| `pdf` | PDF 첫 페이지를 렌더링한 이미지 사용 |

### CertificatePurpose

게이트웨이 인증서 사용 목적을 DB enum으로 제한한다.

| 값 | 의미 |
| --- | --- |
| `device` | 제조 enrollment와 API bootstrap용 장치 인증서 |
| `mqtt` | claim 완료 후 broker 접속용 MQTT client 인증서 |

### GatewayCertificateStatus

인증서 수명주기 상태를 DB enum으로 제한한다.

| 값 | 의미 |
| --- | --- |
| `active` | 현재 사용할 수 있는 인증서 |
| `pending` | 새 device 인증서. 발급 뒤 10분 안에 새 인증서 mTLS로 activation해야 하며, 그 전까지 active pointer를 변경하지 않음 |
| `replaced` | 새 인증서로 교체된 인증서 |
| `revoked` | CA에서 폐기된 인증서 |
| `expired` | 유효기간이 종료된 인증서 |

## 3. 테이블 상세

### Organization

고객사 또는 운영 조직 단위다. 대부분의 데이터는 `Organization -> Site` 또는 `Organization -> User`를 통해 조직 범위로 분리된다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 조직 ID |
| `name` | `String` | 예 |  | 조직명 |
| `type` | `OrganizationType` | 예 | `customer`; `service_provider`는 PostgreSQL partial Unique로 1개만 허용 | 서비스 운영사 또는 고객사 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

관계:

- `users`: `User[]`
- `sites`: `Site[]`
- `invitations`: `Invitation[]`

테넌트 및 bootstrap 보안 계약:

- legacy migration은 기존 `Organization`의 현장 유무를 서비스 운영사 식별자로 사용하지 않는다. 기존 행은 모두 기본값 `customer`로 유지하고 legacy `owner`/`operator` 사용자와 invitation은 모두 `admin`으로 변환한다.
- `service_provider` Organization과 첫 `operator`는 배포 권한이 있는 `auth:bootstrap-operator` CLI만 생성한다. bootstrap은 PostgreSQL transaction-scoped advisory lock을 잡고 기존 service provider Organization 또는 operator가 있으면 거부한다.
- `Organization.type = service_provider`에는 PostgreSQL partial Unique index가 적용된다. 이 index는 Prisma schema에 표현되지 않으므로 `20260721120000_simplify_roles_and_floor_revisions` migration과 domain schema 계약 테스트가 기준이다.
- 이 migration 파일을 수정 전 이미 로컬 개발 DB에 적용했다면 Prisma migration checksum 충돌이 난다. 데이터 보존이 불필요한 로컬 DB만 reset을 선택할 수 있으며, 보존이 필요하면 기존 잘못 분류된 service provider/operator 행을 먼저 감사한 뒤 수동 보정 migration을 적용한다. 이 저장소는 reset이나 파괴적 DB 명령을 자동 실행하지 않는다.

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
- `siteMemberships`: `SiteMembership[]`
- `floorMapRevisions`: `FloorMapRevision[]`

### Site

실제 설치 현장이다. 주차장 한 곳 또는 건물 단지를 표현한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 현장 ID |
| `organizationId` | `String` | 예 | FK -> `Organization.id` | 소속 조직 |
| `name` | `String` | 예 |  | 현장명 |
| `address` | `String` | 예 |  | 주소 |
| `tariffKwhRate` | `Decimal(10,2)` | 예 |  | kWh 단가 |
| `timeZone` | `String` | 예 | `Asia/Seoul` | IANA timezone. 상태 기반 에너지 일·월 경계를 계산하는 기준 |
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
- `memberships`: `SiteMembership[]`

### Floor

현장 내 층 단위다. 지하주차장 기준으로 `B2`, `B1` 같은 층을 표현한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 층 ID |
| `siteId` | `String` | 예 | FK -> `Site.id` | 소속 현장 |
| `name` | `String` | 예 |  | 층 이름 |
| `level` | `Int` | 예 |  | 정렬/층 숫자 |
| `nextFixtureSequence` | `Int` | 예 | `0` | 마지막으로 예약한 자동 조명 이름 순번 |
| `mapRevision` | `Int` | 예 | `0` | 층 전체 편집 상태의 optimistic concurrency revision |
| `editorLeaseFence` | `Int` | 예 | `0` | 편집 lease의 monotonic fencing counter |
| `editorLeaseTokenHash` | `String?` | 아니오 |  | 현재 활성 lease token의 SHA-256 hash |
| `editorLeaseHolderId` | `String?` | 아니오 | FK 없음 | lease 무효화·사용자 삭제와 독립적으로 보존하는 현재 보유 사용자 ID snapshot |
| `editorLeaseHolderName` | `String?` | 아니오 |  | 현재 lease 보유 사용자 이름 snapshot |
| `editorLeaseAcquiredAt` | `DateTime?` | 아니오 |  | 현재 lease 획득 시각 |
| `editorLeaseExpiresAt` | `DateTime?` | 아니오 |  | 현재 lease 만료 시각 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

관계:

- `site`: `Site`
- `floorPlan`: `FloorPlan?`
- `mapObjects`: `FloorMapObject[]`
- `fixtures`: `Fixture[]`
- `assets`: `FloorAsset[]`
- `provisioningSessions`: `ProvisioningSession[]`
- `mapRevisions`: `FloorMapRevision[]`

운영 메모:

- floor editor save/restore transaction은 `editorLeaseFence`, `editorLeaseTokenHash`, `editorLeaseExpiresAt`, `mapRevision`을 같은 PostgreSQL transaction 안에서 함께 검증한다.
- Redis key `floor-editor:lease:{floorId}`는 빠른 경합 감지와 best-effort heartbeat cache일 뿐 정본이 아니다. 만료, 강제 해제, successor 획득은 항상 `Floor` row의 lease authority를 먼저 갱신한다.
- 자동 조명 이름 순번은 등록 transaction에서 `Floor` 행을 `FOR UPDATE`로 잠근 뒤 범위 단위로 예약한다. 삭제된 조명의 순번이나 건너뛴 순번을 재사용하지 않는다.

### SiteMembership

`operator`와 `viewer`의 현장 접근 범위를 명시적으로 보관한다. `(userId, siteId)`는 unique이며 두 부모가 삭제되면 함께 삭제한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | membership ID |
| `userId` | `String` | 예 | FK -> `User.id`, cascade delete | 사용자 ID |
| `siteId` | `String` | 예 | FK -> `Site.id`, cascade delete, indexed | 현장 ID |
| `createdAt` | `DateTime` | 예 | `now()` | 배정 시각 |

운영 메모:

- signup은 invitation 소비와 `SiteMembership` 생성을 같은 transaction으로 처리한다. scoped `operator`/`viewer` invitation은 유효한 `siteId`가 필요하고, `admin` invitation은 조직 전체 접근 의미를 유지하므로 membership을 만들지 않는다.
- `viewer` membership은 반드시 사용자의 customer Organization에 속한 site만 가리켜야 한다. SiteAccess는 권한 판정과 접근 가능한 현장 목록 계산 양쪽에서 이 invariant를 강제한다.

### FloorMapRevision

층 도면의 전체 편집 스냅숏과 복구 이력을 보관한다. `Floor` 삭제 시 함께 삭제되며, 기록한 사용자는 삭제할 수 없다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | revision ID |
| `floorId` | `String` | 예 | FK -> `Floor.id`, cascade delete | 대상 층 |
| `revision` | `Int` | 예 | `(floorId, revision)` unique | 층별 revision 번호 |
| `snapshot` | `Json` | 예 |  | canonical editor state |
| `snapshotSha256` | `String` | 예 |  | 스냅숏 SHA-256 |
| `changeSummary` | `Json` | 예 |  | 변경 요약 |
| `changedBy` | `String` | 예 | FK -> `User.id`, restrict delete | 수정 사용자 |
| `restoredFromRevision` | `Int?` | 아니오 |  | 복구 원본 revision |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |

### AuditLog

조직·현장·작업자와 다형 대상의 감사 결과를 공통으로 보관한다. 다형 대상 ID는 FK로 강제하지 않으며 현장/작업자 시간순 조회 인덱스를 둔다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 감사 ID |
| `organizationId` | `String?` | 아니오 |  | 관련 조직 |
| `siteId` | `String?` | 아니오 | indexed with `createdAt` | 관련 현장 |
| `actorId` | `String?` | 아니오 | indexed with `createdAt` | 작업자 |
| `action` | `String` | 예 |  | 수행한 동작 |
| `targetType` | `String` | 예 |  | 대상 모델 종류 |
| `targetId` | `String?` | 아니오 |  | 대상 ID |
| `outcome` | `String` | 예 |  | 결과 |
| `metadata` | `Json?` | 아니오 |  | 비밀값을 제외한 변경 요약 |
| `ipAddress` | `String?` | 아니오 |  | 요청 IP |
| `userAgent` | `String?` | 아니오 |  | 요청 User-Agent |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |

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
- PDF 업로드는 원본 ready asset URL을 `originalFileUrl`, 첫 페이지 PNG ready asset URL을 `renderedImageUrl`에 저장한다.
- `imageUrl`, `originalFileUrl`, `renderedImageUrl`은 같은 층의 ready `FloorAsset.publicUrl`만 허용하며 data URL과 임의 외부 URL을 거부한다.

### FloorAsset

S3 호환 object storage에 직접 업로드되는 도면 원본과 PDF 렌더 이미지를 추적한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | asset ID |
| `floorId` | `String` | 예 | FK -> `Floor.id`, cascade delete | 소속 층 |
| `kind` | `FloorAssetKind` | 예 | `original`, `rendered` | 원본 또는 렌더 결과 |
| `status` | `FloorAssetStatus` | 예 | `pending` | 업로드 검증 전/후 상태 |
| `objectKey` | `String` | 예 | Unique | bucket 내부 object key |
| `publicUrl` | `String` | 예 |  | 모니터링/에디터 조회 URL |
| `mimeType` | `String` | 예 |  | 서명된 Content-Type |
| `sizeBytes` | `BigInt` | 예 |  | 서명된 byte 크기 |
| `sha256` | `String` | 예 |  | 64자리 hex SHA-256 |
| `readyAt` | `DateTime?` | 아니오 |  | S3 HEAD 검증 완료 시각 |

운영 메모:

- upload intent는 JPEG/PNG/PDF, 1 byte~50 MB, SHA-256 형식을 검증하고 5분짜리 PUT URL을 발급한다.
- complete 요청은 S3 HEAD의 MIME, 크기, checksum이 모두 intent와 같을 때만 `ready`로 전환한다.

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
| `statusReason` | `String?` | 아니오 |  | reported, provisioning_waiting_state, fixture_stale, gateway_offline 등 상태 근거 |
| `healthFaultCodes` | `Json?` | 아니오 | JSON number 배열 | 마지막 BLE Mesh Health Current의 정규화된 8비트 fault code 목록 |
| `healthLastSeenAt` | `DateTime?` | 아니오 |  | 마지막 BLE Mesh Health Current 관측 시각 |
| `energyTrackingStartedAt` | `DateTime` | 예 | `now()` | 상태 기반 에너지 추적을 시작한 시각. 기존 조명은 foundation migration 적용 시각 |
| `firstStateOccurredAt` | `DateTime?` | 아니오 |  | 첫 수락된 fixture-state 발생 시각 |
| `powerOn` | `Boolean?` | 아니오 |  | 마지막 수락된 전원 상태 snapshot |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

관계:

- `floor`: `Floor`
- `meshNode`: `MeshNode?`
- `groupFixtures`: `GroupFixture[]`
- `energyUsages`: `EnergyUsage[]`
- `energyDailyAggregates`: `FixtureEnergyDailyAggregate[]`

운영 메모:

- `rssi`, `hopCount`, `commandSuccessRate`, `lastSeenAt`은 장기 이력 테이블이 아니라 최신 모니터링 snapshot이다.
- `healthFaultCodes`, `healthLastSeenAt`도 이력 테이블이 아닌 최신 Health Current snapshot이다. fault code `0x00`은 제거하고 나머지는 중복 제거·오름차순 정렬해 저장한다. 유효한 Health Current를 아직 받지 못했거나 JSON이 유효하지 않으면 API는 `확인 대기`로 응답한다.
- `20260819092000_add_fixture_health_snapshot` migration은 기존 조명에 두 컬럼을 nullable로 추가한다. 따라서 migration 직후 기존 조명은 첫 Health Current 수신 전까지 `확인 대기` 상태다.
- provisioning 완료는 `status = offline`, `statusReason = provisioning_waiting_state`, `brightness = 0`, `lastSeenAt = null`로 Fixture를 만든다. 이 값은 실제 장비 offline 판정이 아니라 첫 실제 상태를 아직 받지 못한 미확정 상태다.
- 첫 MQTT `fixture-state` event가 도착할 때만 online/fault/offline 상태, 밝기, RSSI, hop, lastSeenAt과 `statusReason`을 실제 관측값으로 확정한다.
- freshness worker는 `provisioning_waiting_state`를 gateway offline과 fixture stale 재집계에서 제외한다. 첫 실제 `fixture-state`가 status reason을 보고값으로 바꾼 뒤에는, 보고된 `offline`을 포함해 일반 freshness 규칙을 적용한다.
- `(floorId, id)` 복합 인덱스는 층별 fixture snapshot의 ID cursor 페이지 조회에 사용한다.

### FixtureGroup

조명 그룹 또는 구역이다. legacy 그룹을 격리하고, 신규 제어 구역은 하나의 층과 Gateway 경계에 고정한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 그룹 ID |
| `siteId` | `String` | 예 | FK -> `Site.id` | 소속 현장 |
| `floorId` | `String?` | 아니오 | FK -> `Floor.id`, active면 필수 | 제어 대상 층 |
| `gatewayId` | `String?` | 아니오 | FK -> `Gateway.id`, active면 필수 | 제어 대상 Gateway |
| `name` | `String` | 예 |  | 그룹명 |
| `lifecycleStatus` | `FixtureGroupLifecycleStatus` | 예 | `active` | `active`, `retiring`, `retired`, `invalid`. legacy backfill 불가 그룹은 `invalid` |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

관계:

- `site`: `Site`
- `floor`: `Floor?`
- `gateway`: `Gateway?`
- `groupFixtures`: `GroupFixture[]`

제약과 migration:

- `20260826_menu_completion_foundation`은 legacy group의 모든 member가 같은 site의 한 floor와 한 Gateway MeshNode에 속할 때만 `floorId`, `gatewayId`를 backfill하고 `active`로 전환한다. 빈 그룹, 경계가 섞인 그룹, MeshNode가 없는 조명을 포함한 그룹은 `invalid`로 남긴다.
- PostgreSQL check는 `active` group에 non-null `floorId`, `gatewayId`를 요구한다. deferred constraint trigger는 active group의 site 경계, member floor/Gateway 일치, 빈 group 금지와 조명 하나당 active 또는 retiring group 최대 15개를 commit 시점에 강제한다.
- `retiring`, `retired`, `invalid` group은 제어 대상으로 조회하거나 명령을 보내면 안 된다.

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
| `nextCommandSequence` | `BigInt` | 예 | `0` | 다음 명령 dispatch sequence 예약용 카운터 |
| `nextMeshUnicastAddress` | `Int` | 예 | `256` (`0x0100`) | 다음에 예약할 BLE Mesh unicast 주소 |
| `nextMeshGroupAddress` | `Int` | 예 | `49152` (`0xC000`) | 다음에 예약할 BLE Mesh group address |
| `claimedAt` | `DateTime?` | 아니오 |  | 현장 claim 완료 시각 |
| `lastHeartbeatEventId` | `String?` | 아니오 | Unique | 마지막 heartbeat 이벤트 ID |
| `lastHeartbeatSequence` | `BigInt?` | 아니오 |  | 마지막 heartbeat sequence |
| `lastHeartbeatOccurredAt` | `DateTime?` | 아니오 |  | heartbeat 발생 시각 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

관계:

- `site`: `Site`
- `inventory`: `GatewayInventory?`
- `meshNodes`: `MeshNode[]`
- `meshControlGroups`: `MeshControlGroup[]`
- `provisioningSessions`: `ProvisioningSession[]`
- `certificates`: `GatewayCertificate[]`

운영 메모:

- `connectionStatus`는 DB 컬럼이 아니라 `lastHeartbeatAt` 기준으로 API에서 계산한다.
- Mesh 주소는 등록 transaction에서 `Gateway` 행을 `FOR UPDATE`로 잠근 뒤 연속 범위로 예약한다. 실제 할당 범위는 `0x0001~0x7fff`이며 카운터가 `0x8000`이면 주소가 소진된 상태다.
- `20260819090000_add_registration_allocators` migration은 기존 `MeshNode.meshAddress`의 최댓값 다음으로 카운터를 보정하되, 신규 주소 기본 시작점 `0x0100`보다 낮추지 않아 기존 노드와의 충돌을 방지한다.
- `nextMeshGroupAddress`는 floor/저장 구역용 영속 Mesh group address allocator다. 제어 group 생성 transaction은 `Gateway` 행을 `FOR UPDATE`로 잠그고, 증가 전 값을 실제 할당 주소로 사용한다. 유효 범위는 `0xC000~0xFEFF`이고 `0xFF00` 이상이면 명시적으로 소진 오류를 반환한다.
- `20260819093000_add_mesh_control_groups` migration은 기존 gateway에 `nextMeshGroupAddress = 0xC000` 기본값을 추가하고, group 메타데이터를 별도 테이블로 분리한다.

### GatewayInventory / GatewayClaimAudit

`GatewayInventory`는 제조 또는 출고 시 등록된 장비 identity 원장이다. `serialNumber`, 일회성 `claimCodeHash`, 선택적인 장치 인증서 `certificateFingerprint`, claim 결과인 `claimedGatewayId/claimedAt`, 폐기 상태 `disabledAt`을 저장한다. claim code 원문과 인증서 private key는 DB와 Git에 저장하지 않는다.

`certificateFingerprint`는 device enrollment 전에는 `NULL`이다. 제조 흐름은 token/Claim Code hash를 먼저 저장하고, CSR 서명이 성공하면 device `GatewayCertificate` 생성과 `GatewayInventory.certificateFingerprint` 확정을 하나의 transaction으로 처리한다. placeholder fingerprint는 사용하지 않는다.

인증서 fingerprint의 canonical 원장은 `GatewayCertificate.fingerprint`다. `GatewayInventory.certificateFingerprint`와 `Gateway.certificateFingerprint`는 별도 원장이 아니라 현재 active device 인증서를 가리키는 호환용 pointer다. 기존 bootstrap/claim 경로가 이 pointer를 사용하므로 제거하지 않으며, device 인증서 발급·교체 transaction은 canonical 원장과 두 pointer를 함께 갱신한다. MQTT 인증서 fingerprint는 이 pointer에 기록하지 않는다.

`GatewayClaimAudit`는 성공·실패 claim 시도의 inventory/site/user, serial, outcome, reason, IP, 시각을 기록한다. Claim 성공 transaction은 `GatewayInventory.claimCodeHash`를 `null`로 폐기해 재사용을 차단한다.

`GatewayInventory`는 `certificates` 관계로 장비에 발급된 device/MQTT 인증서 metadata를 조회한다. 인증서가 한 건이라도 연결된 inventory의 hard delete는 FK `RESTRICT`로 차단한다. 운영 중 inventory는 삭제하지 않고 `disabledAt`을 설정해 비활성화하며, 폐기/재발급 감사 원장을 보존한다. claim된 `Gateway`를 삭제하는 경우에는 인증서 이력을 유지하고 `gatewayId`만 `NULL`이 된다.

### GatewayEnrollment

제조 스테이션이 게이트웨이 최초 장치 인증서를 발급할 때 사용하는 15분 수명의 일회성 enrollment 기록이다. token은 `<enrollment UUID>.<256-bit random secret>` 형식이며 원문은 응답 시 한 번만 전달한다. DB에는 UUID를 `id`로 명시하고 secret의 salted scrypt hash만 `tokenHash`에 저장한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | enrollment ID |
| `serialNumber` | `String` | 예 |  | 대상 게이트웨이 제조 시리얼 |
| `tokenHash` | `String` | 예 | Unique | token secret의 salted scrypt hash |
| `expiresAt` | `DateTime` | 예 |  | token 만료 시각 |
| `usedAt` | `DateTime?` | 아니오 |  | 최초 사용 완료 시각. 값이 있으면 재사용 금지 |
| `stationIdentity` | `String` | 예 |  | 제조 요청을 인증한 station 인증서 identity |
| `outcome` | `String?` | 아니오 |  | 발급 결과 상태 |
| `failureReason` | `String?` | 아니오 |  | 실패 시 보안 감사용 사유 코드 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |

제약:

- Unique: `tokenHash`
- PostgreSQL partial unique: `serialNumber WHERE usedAt IS NULL`
- Index: `serialNumber`, `createdAt`
- 원문 enrollment token, secret, 빠른 lookup digest는 DB, 로그, Git에 저장하지 않는다.

상태 전이:

- 제조 station이 새 enrollment를 만들면 UUID와 256-bit secret을 생성하고 secret의 salted scrypt hash 및 `expiresAt = createdAt + 15분`만 저장한다. transaction에서 같은 serial의 이전 미사용 row를 `usedAt`과 `outcome = superseded`로 닫은 뒤 새 row를 생성한다. partial unique index 충돌은 원문 없는 `Conflict`로 반환한다.
- gateway는 token을 UUID와 secret으로 파싱하고 UUID로 row를 찾은 뒤 저장된 salted scrypt hash를 constant-time 비교한다. malformed token, unknown UUID, wrong secret은 모두 `enrollment token is not active`로 일반화한다.
- serial이 일치하고 미사용·미만료이며 `outcome IS NULL`이면 CSR 검증 전에 conditional update로 `usedAt`과 `outcome = processing`을 즉시 설정한다. 동시에 들어온 요청 중 이 update가 1건을 변경한 요청만 계속 진행한다.
- serial 불일치와 만료 요청도 `usedAt IS NULL AND outcome IS NULL` 조건부 update로 즉시 소비하고 `outcome = failed`, `failureReason = serial_mismatch` 또는 `token_expired`를 기록한다. 이 terminal row는 올바른 serial이나 같은 token으로 재사용할 수 없다.
- consume 이후 CSR, CA 서명, CA bundle 또는 DB 단계가 실패하면 `outcome = failed`와 원문 없는 failure code만 남긴다. `usedAt`은 되돌리지 않으며 제조 station이 새 enrollment를 발급해야 한다.
- CA가 인증서를 발급한 뒤 DB transaction이 실패하면 API는 best-effort revoke를 요청하고 `failureReason = persistence_failed`를 기록한다. revoke 자체의 오류 body는 저장하거나 반환하지 않는다.
- 성공 transaction은 device `GatewayCertificate`, `GatewayInventory.certificateFingerprint`, scrypt `claimCodeHash`, enrollment `outcome = issued`를 함께 반영한다. claim 전이므로 `GatewayCertificate.gatewayId`와 `Gateway.certificateFingerprint`는 갱신하지 않는다.

### GatewayCertificate

게이트웨이에 발급한 장치 bootstrap 인증서와 MQTT client 인증서의 수명주기 원장이다. 실제 인증서 PEM과 private key 대신 식별·폐기·교체에 필요한 metadata만 저장한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 인증서 원장 ID |
| `inventoryId` | `String` | 예 | FK -> `GatewayInventory.id`, delete restrict | 제조 장비 원장 ID |
| `gatewayId` | `String?` | 아니오 | FK -> `Gateway.id`, delete 시 set null | claim 후 연결된 서비스 게이트웨이 ID |
| `purpose` | `CertificatePurpose` | 예 | DB enum | 인증서 용도 |
| `certificateSerial` | `String` | 예 | issuer와 복합 Unique | CA가 발급한 인증서 serial |
| `fingerprint` | `String` | 예 | Unique | 인증서 SHA-256 fingerprint의 canonical 원장 |
| `issuer` | `String` | 예 |  | 발급 CA 식별자 |
| `notBefore` | `DateTime` | 예 |  | 유효 시작 시각 |
| `notAfter` | `DateTime` | 예 |  | 만료 시각 |
| `status` | `GatewayCertificateStatus` | 예 | DB enum | `active`, `pending`, `replaced`, `revoked`, `expired` |
| `revokedAt` | `DateTime?` | 아니오 |  | 폐기 시각 |
| `replacedById` | `String?` | 아니오 | Unique self FK, delete restrict | 이 인증서를 교체한 새 인증서 ID |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

관계 및 삭제 정책:

- `inventory`: `GatewayInventory`. 인증서가 연결된 inventory의 hard delete를 `RESTRICT`로 차단한다.
- `gateway`: `Gateway?`. Gateway가 삭제되어도 인증서 감사 기록은 유지하고 FK만 `NULL`로 만든다.
- `replacedBy` / `replaces`: `GatewayCertificate?` self relation. 한 새 인증서는 최대 한 기존 인증서를 교체하며, 교체 대상으로 참조된 후속 인증서의 hard delete를 `RESTRICT`로 차단한다.

제약:

- Unique: `fingerprint`, `replacedById`, `issuer + certificateSerial`
- PostgreSQL partial Unique: `inventoryId` (`purpose = mqtt` 및 `status = active`인 행만 대상), `inventoryId` (`purpose = device` 및 `status = active`인 행만 대상), `inventoryId` (`purpose = device` 및 `status = pending`인 행만 대상)
- Check: `replacedById IS NULL OR replacedById <> id`로 자기 자신을 교체 대상으로 지정할 수 없다.
- Index: `inventoryId + purpose + status`, `gatewayId + purpose + status`

교체 transaction 계약:

- `GatewayCertificate.fingerprint`가 전체 인증서 이력의 canonical 값이다. `GatewayInventory`와 `Gateway`의 fingerprint는 active `device` 인증서 pointer이므로 lifecycle service가 같은 transaction에서 동기화한다.
- DB의 self-check와 unique 제약만으로는 cross-inventory, cross-purpose 또는 다중 노드 cycle을 완전히 차단할 수 없다.
- MQTT 인증서 발급은 inventory ID를 입력으로 한 PostgreSQL transaction-scoped advisory lock 안에서 실행한다. 같은 inventory의 동시 요청은 직렬화되며, 기존 active MQTT 인증서는 `replaced`로 전환한 뒤 새 active 행을 만들고 마지막에 기존 행의 `replacedById`를 새 ID로 연결한다. 세 단계는 하나의 transaction이므로 외부에는 원자적으로 보인다.
- partial Unique index는 위 서비스 잠금과 별도로 같은 inventory에 active MQTT 인증서가 둘 이상 남지 않도록 DB에서 강제한다. migration은 과거 중복 active 행이 있으면 가장 최근 행만 active로 남기고 나머지는 `replaced`로 정리한 뒤 index를 만든다.
- Device renewal은 active device 인증서가 만료 30일 안에 있을 때만 P-256 CSR을 server-fixed serial CN/URI SAN으로 서명하고 `pending` 원장을 만든다. Inventory advisory lock과 pending partial unique index가 같은 inventory의 동시 renewal을 하나로 제한하며, 서명 후 원장 기록 또는 CA metadata 검증에 실패한 인증서는 best-effort revoke 후 일반화된 503을 반환한다. 성공 응답은 기존 PEM/`caChainPem` 배열 계약과 claimed gateway ID를 함께 반환한다. pending 인증서로 10분 안에 mTLS activation하면 transaction에서 기존 active를 `replaced`로, pending을 `active`로 바꾸고 inventory/gateway pointer를 함께 바꾼다. grace를 넘긴 pending은 revoke 후 거부한다.
- Admin inventory disable은 소속 조직의 claimed inventory만 허용한다. `disabledAt`을 먼저 확정해 bootstrap과 MQTT 발급을 즉시 차단한 뒤, 아직 revoke되지 않은 device/MQTT 인증서를 Vault에서 순차 폐기하고 각 성공을 원장에 기록한다. Vault 일부 실패 뒤에도 inventory는 disabled이며 같은 endpoint 호출로 남은 인증서 폐기를 재시도한다.
- Task 27/29 lifecycle service는 같은 transaction 안에서 기존/후속 인증서가 동일한 `inventoryId`와 `purpose`인지 확인하고, 기존 교체 체인을 잠금 조회해 cycle이 생기지 않는지 검증한 뒤 `replacedById`와 상태를 함께 갱신해야 한다.
- revoke 대상은 `purpose + issuer + certificateSerial + fingerprint`로 식별해 CA 교체나 serial 충돌 상황에서도 모호하지 않게 한다.

보안 저장 정책:

- 인증서 PEM, device/MQTT private key, enrollment token 원문, Claim Code 원문은 이 테이블을 포함한 어떤 DB 테이블에도 저장하지 않는다.
- private key는 해당 Raspberry Pi 내부에서 생성하고 장비의 identity volume에만 권한 `0600`으로 보관한다.
- DB 원장은 인증서 조회, rotation, revoke와 감사에 필요한 metadata만 보관한다.

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
- `controlGroupMemberships`: `MeshControlGroupMember[]`

등록 동시성 계약:

- `deviceUuid`의 전역 Unique 제약은 다른 현장에서 같은 BLE Mesh UUID를 등록하거나 두 provisioning transaction이 동시에 같은 UUID를 생성하는 것을 DB에서 차단한다.
- provisioning 완료 transaction은 기존 UUID가 다른 `gatewayId`에 속하면 Fixture를 만들지 않고 해당 `DiscoveredMeshNode`를 실패로 전환한다. 사전 조회 뒤 경쟁으로 `P2002`가 발생해도 Prisma `meta.target`이 `deviceUuid` unique를 가리킬 때만 아직 provisioning 중인 동일 session/node을 조건부 실패 처리한다. `gatewayId + meshAddress` 같은 다른 unique 또는 transaction 오류는 재전파하므로 잘못된 UUID conflict/409으로 바꾸지 않는다.

### MeshControlGroup

Gateway별 층/저장 구역 제어용 BLE Mesh group address를 영속 저장하는 테이블이다. `targetType`, `targetId`는 다형 대상 구조이므로 DB FK로 직접 강제하지 않고 서비스 계층에서 gateway와 같은 site 소속인지 검증한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 제어 group ID |
| `gatewayId` | `String` | 예 | FK -> `Gateway.id`, delete cascade | 소유 gateway |
| `targetType` | `MeshControlTargetType` | 예 | DB enum | `floor` 또는 `fixture_group` |
| `targetId` | `String` | 예 | Unique with `gatewayId`, `targetType` | 제어 대상 ID |
| `groupAddress` | `String` | 예 | Unique with `gatewayId` | BLE Mesh group address (`0xC000~0xFEFF`) |
| `status` | `MeshControlGroupStatus` | 예 | `configuring` | 구성 상태 |
| `configurationVersion` | `Int` | 예 | `1` | gateway ACK 기준 control group 구성 버전 |
| `operationPlanVersion` | `Int` | 예 | `0` | expected operation plan을 생성 완료한 구성 버전. 빈 계획도 현재 version으로 기록 |
| `fullReconciliationRequired` | `Boolean` | 예 | `false` | gateway state-loss 뒤 cloud snapshot 기반 full-state Add/Delete가 exact ACK로 수렴할 때까지 유지하는 복구 flag |
| `lastError` | `String?` | 아니오 |  | 마지막 구성 실패 사유 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

제약:

- 복합 Unique: `gatewayId`, `targetType`, `targetId`
- 복합 Unique: `gatewayId`, `groupAddress`

관계:

- `gateway`: `Gateway`
- `members`: `MeshControlGroupMember[]`
- `expectedOperations`: `MeshControlGroupExpectedOperation[]`
- `appliedMembers`: `MeshControlGroupAppliedMember[]`

운영 메모:

- 같은 `gatewayId + targetType + targetId` 재호출은 기존 row를 반환하며 새 주소를 소비하지 않는다.
- target 생성은 `INSERT ... ON CONFLICT (gatewayId, targetType, targetId) DO NOTHING RETURNING`을 사용한다. concurrent winner가 있어도 PostgreSQL interactive transaction을 abort시키지 않고 같은 transaction에서 winner를 다시 조회한다.
- lifecycle 값 `retiring`, `retired`는 desired subscription 삭제가 끝날 때까지 group 명령을 차단한다.
- `first_run`, `state_missing`, `state_corrupt` resync는 `fullReconciliationRequired = true`와 새 configuration version을 같은 transaction에서 기록한다. 현재 version의 exact ACK가 ready 또는 retired로 수렴할 때만 false로 되돌린다.
- configuring 상태에서 desired member가 실제 추가되는 경우에도 version을 증가시킨다. 이전 expected operation row는 과거 version 이력으로 남고 지연 ACK는 current-version row lock 조건에서 무시된다.

### MeshControlGroupMember

개별 Mesh node에 특정 control group subscription을 적용해야 하는 상태를 저장하는 테이블이다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `groupId` | `String` | 예 | PK 복합키, FK -> `MeshControlGroup.id`, delete cascade | 제어 group ID |
| `gatewayId` | `String` | 예 | group/node와 compound FK | group과 node가 속한 gateway ID |
| `meshNodeId` | `String` | 예 | PK 복합키, FK -> `MeshNode.id`, delete cascade | 대상 Mesh node ID |
| `subscriptionStatus` | `MeshControlGroupMemberSubscriptionStatus` | 예 | `pending` | member subscription ACK 적용 상태 |
| `desired` | `Boolean` | 예 | `true` | cloud 정본이 이 node의 subscription을 원하는지 여부 |
| `appliedVersion` | `Int` | 예 | `0` | node에 실제 반영된 group configuration version |
| `statusVersion` | `Int` | 예 | `0` | 마지막 subscription result가 반영된 group configuration version |
| `operationId` | `String?` | 아니오 | UUID | 현재 Add/Delete reconciliation operation 식별자 |
| `operation` | `MeshControlGroupMemberOperation?` | 아니오 | `add`, `delete` | 현재 reconciliation 동작 |
| `lastError` | `String?` | 아니오 |  | 마지막 subscription 실패 사유 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

제약:

- 복합 PK: `groupId`, `meshNodeId`
- 보조 Index: `groupId`, `gatewayId`
- 보조 Index: `meshNodeId`, `gatewayId`

관계:

- `group`: `MeshControlGroup`
- `meshNode`: `MeshNode`

운영 메모:

- `appliedVersion = 0`은 아직 gateway ACK로 subscription이 확인되지 않았음을 뜻한다.
- `statusVersion = 0`은 아직 어떤 subscription result version도 반영되지 않았음을 뜻한다.
- `MeshControlGroupMember`는 `(groupId, gatewayId)`와 `(meshNodeId, gatewayId)` compound FK를 사용해 서로 다른 gateway의 group/node 연결을 DB에서 차단한다.
- child 쪽 `groupId + gatewayId`, `meshNodeId + gatewayId`는 unique가 아니라 일반 index다. 따라서 한 control group에 여러 node membership을 둘 수 있고, 한 node도 같은 gateway 안에서 floor group과 fixture group membership을 함께 가질 수 있다.
- `operationId`와 `operation`은 이전 migration과 member aggregate 호환을 위해 남아 있으나 round 2 이후 ACK 권위 원본은 아니다. resync 또는 desired 전체 교체 시 null로 초기화하며, exact operation 상태는 아래 version별 테이블에서 관리한다.

### MeshControlGroupExpectedOperation

각 configuration version에서 cloud가 gateway에 요구한 operation exact set을 저장한다. `operationId`가 PK이며 `(groupId, configurationVersion, action, meshNodeId, meshAddress)`가 Unique라 동일 node의 delete-old/add-new 두 tuple을 함께 표현할 수 있다. `status`와 `lastError`는 operation별 ACK 결과를 보존하고, `(groupId, gatewayId)` compound FK는 group 삭제 시 cascade한다.

### MeshControlGroupAppliedMember

cloud가 ACK로 확인한 실제 group subscription pair snapshot이다. 복합 PK는 `(groupId, meshNodeId, meshAddress)`이며 한 node의 이전 address delete가 실패하고 새 address add가 성공한 partial replacement에서 두 address를 동시에 보존할 수 있다. incremental plan은 desired pair set과 이 applied pair set의 차집합으로 생성한다. full-state plan은 모든 desired pair를 Add로 재확인하고 desired에 없는 applied pair를 Delete하며, retiring의 빈 desired set에서는 모든 cloud applied pair가 Delete 대상이다. migration은 기존 `MeshControlGroupMember.appliedVersion > 0` 행을 현재 MeshNode address로 backfill한다.

### Command

조명 제어 명령 이력이다. 개별 조명, 임의 다중 선택, 층 전체, 저장 구역 제어를 모두 표현한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 명령 ID |
| `siteId` | `String` | 예 | FK -> `Site.id` | 대상 현장 |
| `requestedBy` | `String` | 예 | FK -> `User.id` | 요청 사용자 |
| `clientRequestId` | `String` | 예 | Unique with `siteId`, `requestedBy` | 클라이언트가 재시도에도 보존하는 UUID |
| `requestFingerprint` | `String` | 예 | SHA-256 | 안정 정렬 target·brightness의 canonical fingerprint |
| `targetType` | `String` | 예 |  | `fixture`, `fixtures`, `floor`, `group` |
| `targetId` | `String?` | 아니오 |  | 단일 조명/층/구역 ID. 임의 다중 선택은 `NULL` |
| `targetFixtureIds` | `Json` | 예 | `[]` | 명령 생성 transaction에서 확정한 조명 ID snapshot |
| `brightness` | `Int` | 예 |  | 요청 밝기 0-100 |
| `status` | `CommandStatus` | 예 | `pending` | 명령 상태 |
| `errorMessage` | `String?` | 아니오 |  | 실패 사유 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

관계:

- `site`: `Site`
- `user`: `User`

운영 메모:

- `targetType`, `targetId`는 다형 대상 구조라 DB FK로 직접 강제하지 않는다. API는 사용자 입력을 그대로 신뢰하지 않고 같은 transaction 안에서 현장 소속 Fixture/Floor/FixtureGroup 관계를 다시 조회한다.
- `targetFixtureIds`는 명령 생성 시점의 권위 있는 대상 snapshot이다. 이후 층이나 구역 구성이 변경돼도 이미 생성된 명령의 fixture별 결과 집합은 바뀌지 않는다.
- MQTT command ACK 수신 시 `status`, `errorMessage`가 갱신된다.
- `(siteId, requestedBy, clientRequestId)` unique는 동일 사용자·현장 요청의 중복 Command, Outbox, Gateway sequence 생성을 차단한다. 동일 ID에 다른 fingerprint가 오면 API는 conflict로 처리한다.

### CommandDispatch / CommandFixtureResult / MqttOutbox

`CommandDispatch`는 하나의 사용자 `Command`를 gateway로 전달하는 전송 단위다. 현재 단일 gateway 검증 범위에서는 논리 target이 여러 gateway에 걸치면 명령 생성 전에 전체 거부한다. `idempotencyKey`는 전체 unique, `(gatewayId, sequence)`도 unique이며 acceptance/device status 진행 상태와 오류를 저장한다.

| `CommandDispatch` 추가 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `deliveryMode` | `String` | 예 | `unicast` | `unicast`, `parallel_unicast`, `mesh_group` |
| `destinationAddress` | `String?` | 아니오 |  | `mesh_group`일 때 사용할 BLE Mesh Group Address |
| `meshControlGroupId` | `String?` | 아니오 | `gatewayId`와 복합 FK -> `MeshControlGroup(id, gatewayId)`, `ON DELETE RESTRICT` | 명령 생성 시 선택한 Mesh control group snapshot |
| `meshControlGroupVersion` | `Int?` | 아니오 | 양수 | 명령 생성 시 선택한 group 구성 버전 snapshot |

`unicast`와 `parallel_unicast`는 조명 수만큼 실제 전송하고, `mesh_group`은 `destinationAddress`에 한 번 전송한다. floor/group target은 `MeshControlGroup.status = ready`인 주소만 사용하며 준비되지 않은 group을 unicast로 대체하지 않는다. Mesh group dispatch는 그룹 삭제로 명령 감사 snapshot이 사라지지 않도록 `ON DELETE RESTRICT` 관계를 사용하고, `(meshControlGroupId, status)` index로 발행 대기 명령 검증을 지원한다.

`Gateway.nextCommandSequence`는 gateway별 dispatch sequence를 트랜잭션 안에서 원자 증가시키는 카운터다. 동시 제어 요청에서도 `(gatewayId, sequence)`가 충돌하지 않도록 `max(sequence)+1` 계산을 사용하지 않는다.

`CommandFixtureResult`는 `(dispatchId, fixtureId)` 복합 PK로 실제 조명별 `succeeded`, `failed`, `timed_out`, 밝기, fault, RSSI, hop, 발생 시각을 저장한다. 일부 노드 실패를 그룹 전체 성공으로 숨기지 않는다.

`MqttOutbox`는 dispatch와 필수 1:1로 연결되며 topic, JSON payload, attempts, nextAttemptAt, publishedAt, lastError를 저장한다. Command와 outbox를 같은 DB transaction에서 생성해 MQTT publish 실패로 `pending` 명령이 유실되는 문제를 방지한다. `mesh_group` payload는 `meshControlGroupId`, `meshControlGroupVersion`, Group Address를 포함한다. Publisher는 payload 준비 transaction 안에서 Dispatch snapshot 및 현재 그룹의 gateway/address/version/status를 다시 확인하고, 동일 버전 `configuring`만 재시도한다. 그룹 삭제·실패·버전/주소/gateway 불일치는 MQTT 발행 없이 `MESH_GROUP_STALE` terminal failure로 종료한다.

`20260819094000_extend_command_targets` migration은 기존 Command의 `targetFixtureIds`를 관련 `CommandFixtureResult.fixtureId` 집합으로 backfill한다. 기존 Dispatch는 실제 result 수 1개 이하면 `unicast`, 2개 이상이면 `parallel_unicast`로 정규화한다. 기존 outbox payload도 같은 fixture 목록을 사용하며 과거 `group` 명령을 Mesh group으로 가장하지 않고 `fixtures`, `targetId = null`로 바꾼다. 단, 기존 `fixture` 명령이 정확히 한 조명을 가리킬 때만 `fixture`를 유지한다. Payload는 strict draft wire가 허용하는 키만 새 JSON으로 재구성하므로 이전 재시도에서 저장된 `expiresAt`과 임의 legacy 키를 제거한다. 권위 있는 result가 없거나 strict wire 한도인 1,000개를 초과하는 outbox가 하나라도 있으면 migration은 대상을 자르거나 잘못 발행하지 않고 명시적으로 중단한다.

모든 preflight는 DDL보다 먼저 실행되고 migration 전체는 명시적 PostgreSQL transaction으로 감싼다. Guard 또는 후반 index/FK 오류가 발생하면 신규 컬럼, update, constraint가 함께 rollback된다. `COMMAND_MIGRATION_TEST_DATABASE_URL`을 지정한 opt-in rehearsal은 무작위 임시 schema만 만들고 fresh/retry strict parse, guard rollback, 후반 DDL rollback을 검증한 뒤 schema를 삭제한다.

이 migration은 아직 어떤 배포 환경에도 적용하지 않은 Task 12 신규 migration이라는 전제에서 같은 파일을 보정했다. 이미 이전 버전을 적용한 환경이 생긴 뒤에는 파일을 다시 수정하지 말고 별도의 순방향 보정 migration을 추가해야 한다.

다중 API 인스턴스에서는 `lockedBy`, `lockedAt`, `leaseExpiresAt`으로 30초 발행 lease를 소유하고 PostgreSQL `FOR UPDATE SKIP LOCKED`로 같은 레코드의 중복 발행을 차단한다. 저장 payload는 strict draft 또는 strict full wire만 허용한다. 이전 성공 기록 또는 구버전 publish 시도가 full payload를 남겼다면 기존 `expiresAt`만 제거해 strict draft로 다시 검증한다. 임의 추가 키는 재시도 호환 대상으로 인정하지 않는다.

Publisher는 Mesh snapshot 검증이 끝난 직후의 fresh `preparedAt`으로 기존 lease가 아직 유효하고 현재 worker가 소유한 경우에만 30초 연장한다. 이 transaction은 payload를 수정하지 않고 실제 `leaseExpiresAt`과 정규화한 draft를 반환한다. Final ownership query는 같은 worker 소유권과 미발행·미-dead-letter 상태만 확인한다. Query 반환 후 fresh clock을 다시 읽어 준비 lease가 `freshNow + 20초 MQTT timeout`보다 엄격히 뒤인지 로컬에서 검사한다. DB 대기로 남은 시간이 부족하거나 만료됐다면 발행하지 않는다.

Publish-relative `expiresAt`은 final fence를 통과한 fresh clock 기준으로 만들고 즉시 MQTT에 전달한다. Full payload는 MQTT 성공 후 outbox update transaction에서 `publishedAt`과 함께 저장한다. MQTT 실패나 발행 전 프로세스 종료에는 기존 strict draft/full payload가 그대로 남아 lease 만료 후 재시도할 수 있다. Broker가 물리 publish를 수신한 직후 API가 종료되면 DB 성공 기록 없이 재시도될 수 있으므로 command idempotency key와 Gateway durable journal이 중복 물리 실행을 차단하는 필수 경계다. MQTT QoS 1 callback을 20초 안에 받지 못하면 해당 message ID를 `removeOutgoingMessage`로 취소하고 fresh failure 시각 기준 재시도 경로로 전환한다.

Pending delivery timeout은 Dispatch보다 `MqttOutbox`를 먼저 조건부 dead-letter 선점한다. `lockedBy IS NULL` 또는 `leaseExpiresAt <= now`인 미발행 row를 정확히 1개 선점한 경우에만 Dispatch, 조명별 결과, Command를 종료한다. 필수 1:1 outbox가 없거나 active publisher lease가 있으면 fail-closed로 아무 terminal 전이도 하지 않는다. Outbox 선점 뒤 Dispatch 상태 경쟁을 잃으면 전용 오류로 transaction 전체를 rollback한다. 따라서 publisher claim과 timeout은 같은 outbox row update에서 직렬화된다. Published/accepted timeout은 outbox 선점 없이 기존 Dispatch 조건부 종료를 사용한다. 실패 시 지수 backoff와 jitter를 적용하며 최대 10회 또는 생성 후 15분을 넘으면 `deadLetteredAt`을 기록하고 dispatch와 조명별 결과를 실패로 종료한다. 프로세스가 중단돼도 lease 만료 후 다른 인스턴스가 레코드를 회수한다.

| `MqttOutbox` 운영 컬럼 | 타입 | 설명 |
| --- | --- | --- |
| `lockedBy` | `String?` | 현재 발행 lease를 가진 API worker UUID |
| `lockedAt` | `DateTime?` | lease 획득 시각 |
| `leaseExpiresAt` | `DateTime?` | 장애 발생 시 다른 worker가 회수할 수 있는 시각 |
| `deadLetteredAt` | `DateTime?` | 재시도 한도를 초과해 자동 발행을 중단한 시각 |

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

운영 메모:

- `siteId`는 scoped `operator`/`viewer` 초대의 대상 현장이다. signup transaction은 이 현장이 존재하고, viewer의 경우 초대 조직과 같은 customer Organization에 속하는지 검증한 뒤 membership을 만든다.
- `siteId`가 없거나 잘못된 customer Organization을 가리키는 viewer 초대는 signup 단계에서 거부한다.

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
| `scanStatus` | `ProvisioningScanStatus` | 예 | `pending` | `pending`, `scanning`, `completed`, `failed` |
| `scanCorrelationId` | `String?` | 아니오 | UUID | scan 시도별 correlation ID |
| `scanAttempt` | `Int` | 예 | `0` | scan 재시도 횟수. 실제 scan은 1부터 시작 |
| `scanStartedAt` | `DateTime?` | 아니오 |  | 현재 scan 시작 시각 |
| `scanCompletedAt` | `DateTime?` | 아니오 |  | 완료 또는 실패 수신 시각 |
| `scanFailureCode` | `String?` | 아니오 |  | Gateway가 분류한 비밀값 없는 실패 코드 |
| `scanFailureMessage` | `String?` | 아니오 |  | 사용자 노출 가능한 실패 설명 |
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
- `scanOutbox`: `ProvisioningScanOutbox[]`

등록 시작 계약:

- `POST /registration-sessions`는 `siteId`, `floorId`, `gatewayId`를 모두 명시적으로 받는다. Floor와 Gateway는 모두 해당 Site에 속해야 하고, Gateway의 `lastHeartbeatAt`은 API 현재 시각 기준 정확히 90초 전을 포함해 90초 이내여야 한다. dashboard/API/명령 판단은 공통 freshness helper를 사용한다.
- `POST /registration-sessions`와 retry는 `pending` session state, 새 correlation/attempt와 `ProvisioningScanOutbox` row를 하나의 transaction에서 만든다. partial unique index `ProvisioningSession_single_scanning_gateway_key`는 `status=active`인 Gateway 하나에만 `pending` 또는 `scanning` scan 하나를 허용한다.
- `20260826150000_add_provisioning_scan_outbox` migration은 foundation migration이 남긴 모든 historical `pending/scanning` session을 `failed` (`legacy_scan_closed`) terminal state로 먼저 수렴시킨 뒤 active-only partial unique index를 만든다. 당시에는 durable scan-start outbox가 없었으므로 과거 active session도 재발행하지 않고 종료하는 fail-closed migration 정책이다.
- publisher는 leased outbox를 처리할 때만 `pending -> scanning`으로 전이한 뒤 strict v2 scan-start payload를 발행한다. MQTT callback timeout은 기본 10초(`PROVISIONING_SCAN_OUTBOX_PUBLISH_TIMEOUT_MS`)로 30초 lease보다 짧아야 하며, timeout/reject는 attempt backoff로 기록한다. publish 전 process crash는 lease 만료 뒤 같은 correlation/attempt로 재시도하며, 최대 3회 또는 5분 실패는 outbox dead-letter와 `scan_start_publish_failed` terminal state를 같은 transaction에서 기록한다.
- found/completed/failed event는 session, correlation ID, attempt와 topic scope가 현재 행과 일치할 때만 반영한다. `ProcessedGatewayEvent`의 eventId 및 gateway/sequence/eventType 원장은 같은 transaction에서 중복·낮은 sequence를 차단한다. completed/failed는 원장 생성과 `ProvisioningSession` terminal 변경 transaction이 commit된 뒤에만 scan-terminal application ACK를 발행한다. 동일 terminal event가 재전달되면 exact 원장과 terminal snapshot을 다시 확인해 ACK를 재발행한다.

### ProvisioningScanOutbox

등록 search command의 durable transactional outbox다. CommandDispatch에 1:1로 결합된 `MqttOutbox`와 분리되어 있으며, `ProvisioningSession`의 scan attempt를 gateway MQTT publish와 원자적으로 연결한다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | outbox ID |
| `sessionId` | `String` | 예 | FK -> `ProvisioningSession.id`, delete cascade | 등록 세션 |
| `scanAttempt` | `Int` | 예 | Unique with `sessionId` | scan 재시도 번호 |
| `topic` | `String` | 예 |  | strict v2 scan-start MQTT topic |
| `payload` | `Json` | 예 |  | correlation, scope, attempt를 가진 strict scan-start payload |
| `attempts` | `Int` | 예 | `0` | publisher MQTT 실패 횟수 |
| `nextAttemptAt` | `DateTime` | 예 | `now()` | retry 가능 시각 |
| `lockedBy`, `lockedAt`, `leaseExpiresAt` | nullable | 아니오 | worker lease | crash 후 다른 worker의 reclaim 경계 |
| `publishedAt`, `deadLetteredAt` | nullable | 아니오 | terminal marker | 성공 publish 또는 재시도 포기 시각 |
| `lastError` | `String?` | 아니오 |  | 내부 publisher 오류. 사용자 API 응답에 그대로 노출하지 않음 |

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
| `scanCorrelationId` | `String?` | 아니오 |  | API가 검증한 발견 이벤트의 scan correlation ID. legacy row는 `null` |
| `scanAttempt` | `Int?` | 아니오 |  | API가 검증한 발견 이벤트의 scan 재시도 번호. legacy row는 `null` |
| `status` | `DiscoveredNodeStatus` | 예 | `discovered` | 발견 노드 상태 |
| `identifyState` | `String` | 예 | `idle` | 점멸 확인 상태 |
| `meshAddress` | `String?` | 아니오 |  | 할당 예정 또는 할당된 mesh address |
| `pendingFixtureName` | `String?` | 아니오 |  | provisioning 완료 후 생성할 fixture 이름 |
| `pendingFixtureX` | `Float?` | 아니오 |  | provisioning 완료 후 생성할 fixture X 좌표 |
| `pendingFixtureY` | `Float?` | 아니오 |  | provisioning 완료 후 생성할 fixture Y 좌표 |
| `pendingFixtureSize` | `Float?` | 아니오 |  | provisioning 완료 후 생성할 fixture marker 크기 |
| `pendingRatedWatt` | `Decimal(8,2)?` | 아니오 |  | provisioning 완료 후 생성할 fixture 정격 전력 |
| `errorMessage` | `String?` | 아니오 |  | 실패 사유 |
| `discoveredAt` | `DateTime` | 예 | `now()` | 발견 시각 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 수정 시각 |

제약:

- 복합 Unique: `sessionId`, `deviceUuid`
- `scanCorrelationId`, `scanAttempt`는 새 migration에서 nullable로 추가한다. 신뢰할 수 있는 attempt identity가 없는 기존 row는 backfill하지 않으며 Web 후보 판정에서 fail-closed로 제외한다.
- 같은 세션의 동일 `deviceUuid`가 다음 scan attempt에서 다시 발견되면 upsert update가 두 identity 필드를 현재 검증된 event 값으로 덮어쓴다. `discoveredAt`은 gateway 발생 시각이며 attempt 경계 판정에 사용하지 않는다.

등록 동시성 및 복구 계약:

- batch 요청은 session과 선택 node 행을 안정된 ID 순서로 잠그고, 유효한 node에 대해서만 층 이름 순번과 gateway Mesh 주소 범위를 같은 transaction에서 예약한다.
- 일괄 자동 좌표는 저장된 도면 크기 또는 기본 `1200x800` canvas 안에서 기존 fixture와 겹치지 않는 행 우선 grid cell을 사용한다.
- MQTT publish 오류나 provisioning failure event처럼 물리 적용 여부가 불명확한 결과는 `reconcile_required`로 기록한다. 이 상태는 device UUID와 gateway mapping을 확인하기 전 다시 provisioning하면 안 된다.
- provisioning 완료 event는 pending 이름, 좌표, 정격 전력과 marker 크기를 `Fixture` 생성에 사용한다.

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

### FixtureEnergyDailyAggregate

상태 기반 전력 추정의 정본이다. legacy `EnergyUsage`의 의미와 데이터는 변경하지 않는다.

| 컬럼 | 타입 | 필수 | 기본값/제약 | 설명 |
| --- | --- | --- | --- | --- |
| `id` | `String` | 예 | PK, `uuid()` | 집계 ID |
| `fixtureId` | `String` | 예 | FK -> `Fixture.id`, delete cascade | 대상 조명 |
| `localDate` | `Date` | 예 | Unique with `fixtureId` | Site timezone 기준 현지 날짜 |
| `estimatedKwh` | `Decimal(20,12)` | 예 |  | 상태 기반 추정 사용량 |
| `estimatedCost` | `Decimal(20,8)` | 예 |  | 적산 당시 단가 기준 예상 비용 |
| `knownSeconds` | `Int` | 예 | `0`, non-negative check | 유효 상태로 계산한 시간 |
| `unknownSeconds` | `Int` | 예 | `0`, non-negative check | 첫 상태 이전 또는 수집 공백 시간 |
| `createdAt` | `DateTime` | 예 | `now()` | 생성 시각 |
| `updatedAt` | `DateTime` | 예 | `@updatedAt` | 갱신 시각 |

제약:

- 복합 Unique: `fixtureId`, `localDate`
- Index: `localDate`
- `knownSeconds`, `unknownSeconds`는 음수가 될 수 없다.
- migration은 모든 기존 Fixture의 `energyTrackingStartedAt`에 적용 시각을 저장한다. 따라서 그 이전 구간을 추정하거나 `EnergyUsage`를 새 집계로 backfill하지 않는다.

## 4. 주요 제약 조건 요약

| 테이블 | 제약 | 설명 |
| --- | --- | --- |
| `User` | Unique `email` | 이메일 중복 가입 방지 |
| `FloorPlan` | Unique `floorId` | 한 층에 하나의 현재 도면 |
| `FloorMapObject` | Index `floorId`, `zIndex` | 한 층 안에서 편집 객체 렌더링 순서 조회 최적화 |
| `Fixture` | Unique `meshNodeId` | 하나의 메시 노드는 하나의 조명에만 연결 |
| `Gateway` | Unique `serialNumber` | 게이트웨이 시리얼 중복 방지 |
| `GatewayInventory` | Unique `serialNumber`, nullable `certificateFingerprint`, `claimedGatewayId` | 인증서 발급 전 제조 identity 생성과 발급 후 fingerprint 확정 지원 |
| `GatewayEnrollment` | Unique `tokenHash`, partial unique `serialNumber WHERE usedAt IS NULL`, Index `serialNumber + createdAt` | secret hash 중복, serial별 미사용 enrollment 단일성, token 재사용 방지와 제조 이력 조회 |
| `GatewayCertificate` | DB enum purpose/status; Unique `fingerprint`, `replacedById`, `issuer + certificateSerial`; partial unique `inventoryId WHERE purpose = mqtt AND status = active`; self-replacement Check; inventory/replacement delete Restrict | 인증서 수명주기와 inventory별 단일 active MQTT 인증서, 감사 가능한 1:1 교체 체인 추적 |
| `CommandDispatch` | Unique `idempotencyKey`, `gatewayId + sequence` | 중복 명령과 순서 충돌 방지 |
| `Command` | Unique `siteId + requestedBy + clientRequestId` | 사용자 재시도의 멱등성 보장 |
| `FixtureEnergyDailyAggregate` | Unique `fixtureId + localDate`, localDate index, non-negative seconds check | 일별 idempotent upsert와 기간 조회 |
| `CommandFixtureResult` | PK `dispatchId + fixtureId` | dispatch별 조명 결과 중복 방지 |
| `ProcessedGatewayEvent` | PK `eventId`, Unique `gatewayId + sequence + eventType` | QoS 중복·stale 이벤트 방지 |
| `MeshNode` | Unique `deviceUuid` | BLE Mesh device UUID 중복 방지 |
| `MeshNode` | Unique `gatewayId`, `meshAddress` | 같은 게이트웨이 내 mesh address 중복 방지 |
| `MeshControlGroup` | Unique `gatewayId + targetType + targetId`, Unique `gatewayId + groupAddress` | gateway별 영속 제어 group 중복과 주소 충돌 방지 |
| `MeshControlGroupMember` | PK `groupId + meshNodeId`, Index `groupId + gatewayId`, Index `meshNodeId + gatewayId` | 같은 group/node membership 중복 방지, cross-gateway group/node FK 검증, gateway 내부 membership 조회 가속 |
| `MeshControlGroupExpectedOperation` | PK `operationId`, Unique `groupId + configurationVersion + action + meshNodeId + meshAddress` | version별 exact ACK와 동일 node address replacement 2-operation 보존 |
| `MeshControlGroupAppliedMember` | PK `groupId + meshNodeId + meshAddress`, Index `groupId + gatewayId` | partial success를 포함한 cloud 확인 실제 subscription pair snapshot |
| `GroupFixture` | PK `groupId`, `fixtureId` | 같은 조명의 그룹 중복 매핑 방지 |
| `Invitation` | Unique `tokenHash` | 초대 토큰 hash 중복 방지 |
| `Session` | Unique `tokenHash` | 세션 토큰 hash 중복 방지 |
| `DiscoveredMeshNode` | Unique `sessionId`, `deviceUuid` | 같은 등록 세션 안에서 발견 노드 중복 방지 |
| `ProvisioningSession` | Partial unique `gatewayId WHERE scanStatus IN (pending, scanning)` | Gateway당 outbox 대기·실행 중 scan 1개 제한 |
| `ProvisioningScanOutbox` | Unique `sessionId + scanAttempt`, retry/lease index | 같은 scan attempt의 중복 outbox 생성 방지와 crash-safe reclaim |
| `FixtureGroup` | active boundary check, deferred group/member trigger, `siteId + floorId + gatewayId + lifecycleStatus` index | legacy 격리와 활성 구역 경계·member 수 제한 |

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
실제 Raspberry Pi gateway
→ Generic OnOff/Lightness/Health Current의 coherent MQTT v2 fixture-state event
→ Fixture brightness/status/RSSI/hop/lastSeenAt과 healthFaultCodes/healthLastSeenAt 갱신
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
ProvisioningSession pending + ProvisioningScanOutbox 생성 transaction
→ leased publisher가 pending -> scanning 전이
→ gateway scan command 발행
→ gateway-scoped v2 `provisioning/scan-found` event
→ 검증된 scanCorrelationId/scanAttempt와 함께 DiscoveredMeshNode upsert
→ identify 확인
→ register-batch 요청에서 node별 검증
→ 유효 node의 이름 순번·Mesh 주소 원자 예약과 pending fixture 정보 저장
→ gateway provision-device command를 장치별 직렬 처리
→ provisioning-completed event
→ MeshNode 생성 또는 기존 MeshNode 재사용
→ Fixture 생성 또는 기존 Fixture 유지
→ provisioning-failed 또는 불명확 publish 결과는 DiscoveredMeshNode reconcile_required/errorMessage 갱신
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
