# 설정 자산·운영 데이터 안전성 설계

기준일: 2026-09-12

## 목적

설정 메뉴의 도면 자산을 공개 버킷과 장기 URL에서 분리하고, 업로드 원장을 장애와 현장 삭제 경합에도 회수 가능한 상태로 만든다. 설치 후 관리자가 현장·층·조명·구역의 최소 운영 정보를 직접 관리할 수 있게 하며, 운영자 삭제 UI와 일반 사용자 소속 정책을 서버 의미와 일치시킨다.

## 확정 결정

### 도면 자산 접근

- `floor-assets` 버킷은 anonymous download를 허용하지 않는다.
- DB에는 공개 URL을 저장하지 않고 인증된 same-origin 접근 경로만 저장한다.
- `GET /floors/:floorId/assets/:assetId/content`는 `read` 권한과 floor/asset 소속을 확인한 뒤 300초 signed GET으로 redirect한다.
- 조회 응답은 pending 자산을 제외하며, 다른 현장 사용자와 삭제된 자산은 opaque `404`를 받는다.
- signed URL은 `Cache-Control: private, no-store` 응답으로 전달하고 URL 자체를 DB, 감사 로그, 문서에 보존하지 않는다.

### 업로드 원장과 회수

- API는 MIME, 크기, checksum을 검증하고 object key를 생성한 뒤 PostgreSQL `FloorAsset(pending)`을 먼저 commit한다.
- commit 뒤 PUT URL을 서명한다. 서명 실패 시 pending 원장은 남아 sweeper가 회수한다.
- `FloorAsset.uploadExpiresAt`은 signed PUT의 최장 유효 시각이며, sweeper는 여유 시간 5초 뒤 pending object 삭제와 row 삭제를 재시도한다.
- intent 생성 transaction은 Site/Floor를 잠가 현장 삭제가 새 intent를 놓치지 않게 한다. 현장 삭제는 같은 Site 잠금 뒤 pending·ready object key 전체를 cleanup 원장에 복사한다.
- complete는 floor/asset 소속과 pending 상태를 잠근 뒤 S3 HEAD의 MIME, 길이, SHA-256을 검증하고 ready로 전환한다.

### 업로드 UI

- 맵 편집기 속성 영역에 PDF/JPG/PNG 파일 선택, 업로드, 교체, 제거를 제공한다.
- 브라우저가 SHA-256을 계산하고 intent → signed PUT → complete 순서로 호출한다.
- 업로드 중 저장·복구·층 전환·다른 업로드를 잠근다.
- 실패하면 기존 floor plan과 기존 자산을 그대로 유지하고 재시도할 수 있다.
- 성공한 자산만 편집 draft에 적용하며 최종 `editor-state` 저장 전까지 현재 운영 도면은 바뀌지 않는다.
- PDF는 원본 접근 경로를 보존하고 렌더링 이미지는 별도 ready asset이 있을 때만 배경으로 선택한다. 서버 렌더 worker가 없는 현재 단계에서는 PDF 원본을 업로드할 수 있지만 PDF 자체를 canvas 이미지로 사용하지 않는다.

### 설치 후 운영 데이터 관리

- `/settings/site`를 관리자 전용 운영 설정 화면으로 추가한다.
- 현장: 현장명, 주소, 시간대, 통화(`KRW`), kWh 단가를 수정한다.
- 층: 이름, level, 표시 순서, active/archive 상태를 관리한다. 조명 또는 활성 구역이 남은 층은 archive하지 못한다.
- 조명: 서버 pagination을 유지하며 이름과 정격전력만 수정한다. serial, Mesh 주소, 펌웨어와 인증 정보는 읽기 전용이다. 위치와 크기는 맵 편집기에서만 수정한다.
- 구역: 기존 생성·수정·retiring API를 재사용하고 운영 설정 화면에서 목록과 archive 진입점을 제공한다.
- 모든 write는 외부 capability 확인뿐 아니라 transaction 안의 Site 잠금 재인가를 거친다.

### 계정 소속 정책

- 현재 제품은 일반 사용자를 현장 아래에서 새로 생성하고 기존 계정을 다른 현장에 추가하지 않는다.
- 이 정책을 `SiteMembership.userId` unique index로 강제해 viewer 한 명이 여러 현장에 동시에 소속되는 상태를 금지한다.
- 따라서 `User.status` 비활성화와 영구 삭제는 현장 단위 UI 의미와 일치한다. 기존 DB에 다중 소속 viewer가 있으면 migration은 자동 선택하지 않고 식별 가능한 오류로 중단한다.

### 운영자 삭제 UI

- 운영자 목록의 command 이름을 `관리자 삭제`가 아니라 `현장 전체 삭제`로 표시한다.
- 확인 dialog는 현장, 관리자, 일반 사용자, 장비·자동화·통계 메타데이터 삭제와 외부 자산의 비동기 cleanup을 명시한다.
- 확인 입력은 현장명을 그대로 유지한다.

## 오류와 경합

- signed GET 생성 실패는 `503`으로 반환하며 공개 fallback을 사용하지 않는다.
- 업로드 presign 실패는 `503`이지만 pending 원장은 남는다.
- complete 중 metadata 불일치는 `400`, 다른 tenant나 삭제 경합은 opaque `404` 또는 `409`로 처리한다.
- Site 삭제와 intent 생성은 Site row lock으로 직렬화한다. S3 network call은 DB transaction 밖에서 수행한다.
- 설정 수정의 optimistic 충돌은 `expectedUpdatedAt` 또는 현재 row lock 검증으로 `409`를 반환한다.

## 검증

- Object storage unit/integration: anonymous GET 403, signed GET 200/300초, 만료 후 실패, delete 후 실패.
- API unit/integration: DB-first presign, presign 실패 pending 보존, sweeper 재시도, Site 삭제 경합, tenant/role 차단.
- Web unit/Chromium: PDF/JPG/PNG 선택, 업로드 잠금, 실패 후 기존 자산 보존, 성공 후 draft 적용, 운영 CRUD 정상 경로.
- Migration: clean replay, 다중 membership 없는 upgrade 성공, 다중 membership seed에서 rollback.
- 사용자 로컬 DB에는 migration을 적용하지 않고 disposable PostgreSQL에서만 검증한다.

## 2026-10-15 추가 설계: 실제 조명 등록 삭제

상태: 2026-10-16 사용자가 서면 설계에 따른 계획 작성 후 즉시 구현과 별도 브랜치 후 병합을 지시했다. 구현 현황은 `docs/superpowers/plans/2026-10-16-fixture-registration-removal.md`를 따른다. 아래는 설계이며 전체 구현 완료를 뜻하지 않는다. 과거 도면 업로드 정책을 다시 활성화하지 않고 이번 추가 범위에만 적용한다.

### 목적과 사용자 흐름

- 해당 현장의 admin이 `/settings/site` 조명 관리의 `등록 삭제` 아이콘 버튼에서 한 개씩 처리한다. viewer와 operator는 고객 현장의 삭제 권한을 갖지 않는다. 공통 확인창·버튼·오류 표시를 재사용한다.
- 확인창에는 이름·시리얼, 운영 목록/맵에서 제거됨, 과거 통계/제어 이력 보존을 표시한다. **공장 초기화·소등·밝기/센서 모드 변경은 하지 않으며 장비 자체 센서 동작은 계속될 수 있다.**
- 현재 신규 지원 대상인 BIO부터 구현한다. 기존 표준 BLE Mesh/기타 장치에는 미지원 이유를 보여 주고 강제 DB 삭제로 우회하지 않는다. 일괄 삭제·강제 오프라인 삭제·삭제 취소/복구는 이번 범위 밖이다.
- 삭제 가능 여부 조회 → 차단 사유 또는 확인창 → 삭제 접수 → Gateway 연결 정보 정리 확인 → 서버 최종 반영 → 완료 표시 순서다. HTTP 접수/PUBACK만으로 완료를 표시하지 않는다.
- 창 닫기·새로고침 뒤에는 같은 작업을 조회해 복구한다. 중복 클릭은 같은 요청 ID를 사용하며 새로운 삭제 명령을 자동 생성하지 않는다. 완료 뒤 설정/모니터링/맵/제어/등록 후보 query를 갱신한다.
- 삭제한 장비는 다시 검색해 새 조명으로 등록할 수 있다. 새 fixture/node/등록 ID와 새 설정을 사용하고 과거 건강·센서 준비·제어 권한을 승계하지 않는다.

### 현재 구현과 안전상 이유

- 현재 `FixturesController`는 GET/PATCH만 제공한다. 맵의 조명 삭제는 배치 해제이며 실제 장비 등록 삭제가 아니다.
- 현재 `Fixture`를 물리 삭제하면 `CommandFixtureResult`, `EnergyUsage`, 센서 준비/재확인 등의 CASCADE로 이력이 소실될 수 있다. 따라서 단순 `fixture.delete()`를 사용하지 않는다.
- `BioDeviceMappingStore`에는 reserve/confirm은 있지만 remove가 없다. `scan()`은 mapping 유무로 발견을 제외하지 않으므로 신규 삭제 경로를 연결하면 재등록은 가능하나, 서버 삭제만으로는 기존 Gateway 제어와 UUID 충돌이 남는다.
- `applyUnicast()`가 읽어 둔 mapping/실행 대상은 mapping 파일을 지워도 살아 있을 수 있다. 삭제 여부는 수신·큐 실행·실제 USB write 직전 같은 등록 세대로 다시 검사해야 한다. publishEpoch drain과 USB transport generation은 등록 세대의 대체물이 아니다.

### 삭제 허용 조건

- 서버 transaction에서 assigned admin·현장/층/조명 소속·설치 완료·활성 층을 다시 인가한다. 다른 현장은 기존 opaque 404 정책을 따르고, 미인증은 401이다.
- Gateway가 온라인이며 새 삭제 계약을 지원해야 접수한다. Gateway 오프라인/미지원 시 먼저 연결·업데이트하도록 안내한다. 조명 자체가 오프라인이어도 물리 초기화를 요구하지 않는 로컬 연결 정리는 가능하지만 Gateway terminal 확인은 필요하다.
- 활성/비활성을 막론하고 저장된 스케줄·이벤트의 감지 기준 또는 대상이면 409로 거절한다. 규칙에서 제외하거나 규칙을 삭제한 뒤 재시도한다. 최소 대상 수 제약 때문에 연결을 자동 CASCADE하지 않는다.
- 사용자 구역에 속하면 연결된 구역을 표시하고 먼저 제외하도록 409를 반환한다. 마지막 조명을 지워 구역을 임의 파괴하지 않는다. 층 전체 제어용 내부 멤버십만 삭제 작업이 재동기화한다.
- 진행 중/결과 불확정 제어·임시 제어·복귀 의무·식별·provisioning·센서 준비/모드 변경/재확인·관련 자동화 동기화가 있으면 거절한다. 서버뿐 아니라 Gateway의 실제 runtime 상태도 검사하며 시간 초과만으로 안전해졌다고 간주하지 않는다.
- 맵 편집권/준비 중인 저장·CAD 적용이 있으면 종료를 안내한다. 삭제와 저장은 같은 Floor 경계를 잠그고 이전 맵 복구로 삭제한 장비가 부활하지 않게 한다.

### 공유 계약과 내구성

- 제안 API는 `GET /sites/:siteId/floors/:floorId/fixtures/:fixtureId/registration-removal-preview`, 같은 조명 경로 아래 `POST registration-removals`, `GET registration-removals/:operationId`다. POST 입력은 `clientRequestId`, `expectedUpdatedAt`이며 최초 접수는 202다. 같은 요청 ID/동일 입력은 같은 작업, 다른 입력은 409로 처리한다.
- 새 삭제 작업 원장/outbox는 현장/층/조명·Gateway assignment·UUID·주소·기존 등록 ID·identity hash·요청자를 불변 스냅샷으로 보존한다. MQTT 명령/terminal/결과 확인은 정확한 작업 ID와 동일 귀속/hash를 검증한다.
- 상태는 `pending -> gateway_confirmed -> completed`다. 변경 전 명시 거절은 `rejected`, 실행 여부를 증명하지 못하면 `reconcile_required`다. 불확정은 제어/재등록을 계속 차단하며 동일 작업의 결과 확인·재조정만 허용한다.
- 기존 자동화 멤버십 잠금과 Site/Floor/Gateway/등록 잠금 순서를 대조해 하나의 순서로 직렬화한다. 삭제 시작과 새 제어/규칙/구역/등록을 API 및 DB 보호로 동시 통과시키지 않는다. 네트워크 호출은 DB transaction 밖에서 한다.
- Gateway는 삭제 명령을 먼저 영속 기록하고 진행 작업/복귀 의무를 재검사한다. active mapping·health/poll·센서 authority·내부 구역 멤버십을 정리하고 퇴역 세대를 영속화한다. 기존 provisioning/command 원장은 지우지 않으며 과거 명령·식별·등록 재생은 거절한다.
- `ProvisioningDeviceJournal`의 commandId별 중복/복구·정확 terminal ACK와 mapping `onChange`의 health/proof 무효화는 재사용하되 삭제 명령은 독립 원장/결과 재전송을 갖는다. 새 등록은 새 preparation·live GET·정확 capability 확인을 요구한다.
- Gateway 정리 뒤 서버 최종 반영이 실패하면 장비를 active로 되돌리지 않는다. 동일 작업을 재조정하고 ACK 유실/API·Gateway 재시작 후에도 완료를 회수한다. 삭제 완료 전 UUID/주소를 다른 등록에 넘기지 않는다.
- 센서 catalog와 층 전체 제어의 desired/applied 동기화도 삭제 대상을 제외한 새 버전의 정확한 ACK까지 확인한다. 오래된 catalog/멤버십의 재전달이 퇴역 장치를 다시 활성화하지 않도록 같은 등록 세대 검사를 적용한다. 퇴역 fence는 일반 성공 원장의 보존 기간만으로 조기 회수하지 않는다.

### 이력 보존과 DB 방향

- Fixture/MeshNode에 운영 퇴역 시각을 추가해 과거 FK를 유지한다. 퇴역 행은 이력 전용이며 운영 목록/조명 수/맵/수동·자동 제어/등록 자격에서 제외한다. 오프라인 상태를 삭제 상태로 재사용하지 않는다. 사용자 UI에는 복구를 제공하지 않는다.
- 원래 UUID는 삭제 작업의 불변 snapshot에 남기고 퇴역 MeshNode의 운영용 nullable `deviceUuid`를 비워 기존 unique 제약 아래 새 등록을 허용한다. 과거 논리 주소는 기존 행에 남겨 즉시 재사용하지 않는다. 기존 원장과 과거 원본 UUID를 몰래 다시 쓰지 않는다.
- 제어 결과·전력 원본/일·시간 집계·EnergyFixtureIdentity·센서/등록/보안 원장은 삭제하거나 새 장비에 이관하지 않는다. 전력 추적은 삭제 경계에서 종료하며 마지막 밝기를 이후 기간에 무한 적산하지 않는다. 실제 관측 없는 구간을 임의 추정하지 않는 기존 정책을 유지한다.
- 맵 배치 해제·내부 제어 멤버십·퇴역은 최종 transaction에서 일관되게 반영한다. 다른 도형/장비/맵 이력은 보존하고 맵 버전 복구는 현재 운영 등록 목록을 기준으로 장비를 검증한다.
- 구현 시 schema/migration과 `docs/database-schema.md`를 함께 갱신한다. 현재 사용자 DB migration·Pi 배포·실제 삭제는 이 설계 작성 범위가 아니며 별도 운영 승인이 필요하다.

### 진행 및 검증 체크리스트

- [x] UI/API 부재·CASCADE 이력 위험 조사 및 Gateway 전용 읽기 조사 통합.
- [x] 서면 설계 검토 후 실행 계획 작성·즉시 실행 승인(2026-10-16).
- [ ] 공유 계약·원장·퇴역 schema/동시성 보호를 격리 PostgreSQL로 검증.
- [ ] Gateway 삭제·정확 결과·지연 메시지 차단·동일 제품 재등록 검증.
- [ ] API 인가·차단·publisher/terminal/finalize·이력/맵/전력 경계 연결.
- [ ] Web 가능 여부·공통 확인창·진행/불확정 복구·목록 반영 구현.
- [ ] 취소·중복·새로고침·역할/타현장·오프라인·유실/재시작·삭제와 새 제어/등록 경쟁·이전 맵 복구 회귀, 관련 타입/테스트/빌드와 Chromium 정상 여정 검증.
- [ ] 전체 변경 독립 검토·메뉴/DB/교훈 갱신과 메인 통합. 실제 BIO 삭제→재검색→재등록 HIL은 별도 승인 뒤 실행하며 소프트웨어 결과와 구분한다.
