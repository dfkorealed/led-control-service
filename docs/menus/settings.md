# 설정 메뉴 기능 현황 및 구현 설계

> 모든 설계와 완료 판정은 양산 기준을 사용한다. 코드·자동 테스트 완료와 Raspberry Pi/ESP32-H2 실기 검증 완료를 구분하며, 실기 증거가 없으면 양산 E2E 완료로 표시하지 않는다.

기준일: 2026-08-19

## 현재 우선순위

- 설정 메뉴의 신규 기능은 모니터링과 수동 제어 집중 구현이 끝날 때까지 보류한다.
- 기존 도면 에디터는 계속 설정 메뉴가 소유하며, 저장한 배경, 도형, 텍스트, 색상과 조명 배치를 모니터링에서 읽기 전용으로 재사용한다.
- 사용자/보안, 현장/층 운영 CRUD, 조명/그룹 관리, 정책/알림, OTA, 외부 연동의 미구현 상태는 유지한다.
- BLE Mesh floor/zone Group Address와 subscription 동기화는 설정 화면 확장이 아니라 제어 기반 기능으로 구현한다. 기존 FixtureGroup 데이터만 사용하며 이번 범위에서 그룹 CRUD UI는 추가하지 않는다.

상세 계약은 `docs/superpowers/specs/2026-08-19-monitoring-control-focused-completion-design.md`를 따른다.

## 목표와 기능 경계

- 설정 메뉴를 현장 구성, 도면 관리, 장비 시운전, 운영 정책, 보안, 유지보수의 관리 허브로 만든다.
- 실시간 상태 확인은 모니터링, 조명 명령 실행은 제어, 에너지 분석은 통계에서 담당한다.
- 도면 에디터는 설정의 `도면 관리`에서만 열고, 모니터링은 읽기 전용 상태 확인에 한정한다.
- 최초 현장 설정, Gateway claim, 최초 provisioning은 서비스 운영사의 `operator`만 수행한다.
- 설치 완료 후 고객사의 `admin`은 도면 배경, 도형, 조명 배치, 일반 조명 정보와 운영 정책을 직접 관리한다.
- 설정값은 임의 JSON 한 필드에 모으지 않고 검증 가능한 명시적 모델과 컬럼으로 관리한다.

## 권한 기준

| 기능 | operator | admin | viewer |
| --- | --- | --- | --- |
| 설정 조회 | 배정 현장 | 고객사 전체 현장 | 배정 현장 |
| 최초 현장·층·Gateway 설치 | 허용 | 금지 | 금지 |
| BLE Mesh 검색·provisioning | 허용 | 금지 | 금지 |
| 현장 정보와 층 관리 | 허용 | 허용 | 금지 |
| 도면 배경·도형 편집 | 허용 | 허용 | 금지 |
| 조명 이름·정격전력·위치 편집 | 허용 | 허용 | 금지 |
| 그룹 관리와 운영 정책 | 허용 | 허용 | 금지 |
| 도면 버전 복구 | 허용 | 허용 | 금지 |
| Gateway 해제·장비 교체·초기화 | 허용 | 금지 | 금지 |
| 알림 규칙과 고객사 사용자 관리 | 허용 | 허용 | 금지 |
| operator 배정·인증서·OTA 변경 | 허용 | 금지 | 금지 |
| 편집 잠금 강제 해제 | 허용 | 허용 | 금지 |

- 프론트의 버튼 노출과 무관하게 모든 변경 API가 서버에서 조직, 현장 접근 범위와 역할을 검사한다.
- `operator`는 서비스 운영사 소속이며 `SiteMembership`으로 명시적으로 배정된 고객 현장만 접근한다. 역할만으로 모든 고객 현장에 접근하지 않는다.
- `admin`은 자기 고객사 조직의 모든 현장을 관리하고 다른 고객사에는 접근할 수 없다.
- `viewer`는 자기 고객사 조직 안에서도 `SiteMembership`으로 배정된 현장만 조회한다.
- 마지막 고객사 admin은 비활성화하거나 viewer로 낮출 수 없다.
- operator 배정, 현장 초기화, Gateway 해제, 인증서 폐기, 전체 OTA에는 재인증과 감사 로그를 적용한다.
- admin은 admin/viewer를 초대할 수 있지만 operator를 생성하거나 배정할 수 없다.

## 설정 정보 구조

| 하위 메뉴 | 책임 |
| --- | --- |
| 설정 개요 | 현장, 조명, Gateway, 사용자, 펌웨어 상태 요약과 필요한 조치 표시 |
| 현장 및 층 | 현장 기본 정보, 층 추가·수정·정렬·보관 |
| 도면 관리 | 층별 배경 도면, Konva 편집기, 버전 조회·복구 |
| 조명 및 그룹 | 조명 일반 정보, 그룹과 구성원 일괄 관리 |
| Gateway 및 네트워크 | Claim, 담당 층·구역, 연결·Mesh·인증서 진단 |
| 설치 및 시운전 | BLE Mesh 검색, provisioning, 배치, 통신 품질 검사, 시운전 보고서 |
| 운영 정책 | 오프라인·stale·명령 제한 시간, 디밍 범위, 정전 복구 정책 |
| 알림 | 장애 조건, 수신자, 채널, 지연·cooldown, 점검 시간 |
| 사용자 및 보안 | 초대, 역할, 현장 접근, MFA, 세션, 감사 로그 |
| 펌웨어 및 유지보수 | 버전, 서명된 OTA, 단계 배포, 중단·롤백, 인증서 수명주기 |
| 외부 연동 | API key, Webhook, BMS/BACnet 연동과 접근 범위 |

- PC 웹에서는 설정 전용 좌측 메뉴와 우측 상세 화면을 사용한다.
- 모바일 WebView에서는 좌측 메뉴를 상단 선택 메뉴로 바꾸고 동일한 웹 컴포넌트와 API를 사용한다.
- 설정과 에디터는 URL을 가지며 새로고침, 브라우저 뒤로 가기와 직접 진입을 지원한다.

## 구현 완료

- 현장이 없는 service-provider `operator`에게만 초기 설치 설정 마법사를 표시한다. customer `admin/viewer`는 `설치 담당자가 현장을 준비 중입니다` 상태를 본다.
- 초기 설치에서 고객사명, 현장명, 주소, kWh 단가, 층 이름과 level을 등록하며 Gateway 레코드는 만들지 않는다.
- `POST /setup/initial-site`는 service-provider operator만 호출할 수 있고, Serializable transaction으로 customer Organization, 첫 Site, Floors, operator의 SiteMembership을 함께 생성한다.
- 현장 생성 후 해당 현장에 배정된 operator만 제조 원장의 시리얼과 일회성 claim code로 Gateway를 연결한다.
- Gateway firmware version은 사용자 입력이 아니라 heartbeat로 자동 갱신한다.
- 설정 화면에 현장, 층/도면, 그룹, Gateway 요약 카드를 표시한다.
- Gateway 이름, 시리얼과 온라인·오프라인 상태를 실제 dashboard 응답으로 표시한다.
- 현장이 있으면 조명 등록 세션, BLE Mesh 후보 목록과 provisioning 요청 UI를 제공한다. 등록 패널은 층과 Gateway를 사용자가 명시적으로 선택하고 `siteId`, `floorId`, `gatewayId`를 함께 전송한다. 서버는 해당 Gateway heartbeat가 정확히 90초 전인 경우까지 fresh로 허용한다.
- provisioning 완료 이벤트로 `MeshNode`와 `Fixture`를 만들고 실패 이벤트의 사유를 저장한다. 새 Fixture는 `offline + provisioning_waiting_state`로 만들며, 첫 실제 fixture-state 전에는 online/fault, 밝기, lastSeenAt을 확정하지 않는다. 다른 현장 UUID 재사용 또는 `MeshNode.deviceUuid` unique 경쟁만 해당 node 실패로 기록하며, 다른 unique/transaction 오류는 재전파한다.
- 제조 장비 원장 기반 `POST /gateways/claim`과 장비 인증서 기반 `POST /gateway-bootstrap`을 구현했다. claim과 assigned inventory disable은 operator 역할과 현장 `commission` 권한이 필요하며 admin/viewer는 `403`, 미배정 operator는 `404`를 받는다.
- Claim 성공·실패 감사 로그와 연속 실패 rate limit을 적용했다.
- Raspberry Pi appliance가 실제 BlueZ scan/provisioning adapter와 영속 Mesh identity를 사용한다.
- 실제 Gateway MQTT scan 이벤트만 후보로 저장하며 런타임 mock 검색 경로는 제거했다.
- 실제 Gateway scan은 shared DFK product identity 계약을 통과한 ESP32-H2 UUID만 등록 후보로 반환한다. UUID 필터는 제품 식별용이며 제조 원장, claim과 Gateway mTLS 인증을 대체하지 않는다.
- Konva 도면 에디터에 도면 업로드, 사각형·삼각형·선·텍스트, 색상, 이동, 크기 변경, 조명 정보·위치 편집과 확대·축소를 구현했다.
- 설정 에디터와 모니터링 읽기 전용 지도는 `FloorMapObjectNode`의 사각형·삼각형·선·텍스트 geometry를 공유한다. Transformer, drag와 변경 callback은 설정 에디터에서만 활성화한다.
- PDF/JPG/PNG 원본과 렌더링 결과를 S3 호환 저장소에 저장하고 준비 완료된 asset URL만 도면에 연결한다.
- `owner`를 제거하고 `operator/admin/viewer` 3단계 역할과 서비스 운영사/고객사 Organization 유형을 Prisma schema에 적용했다. legacy migration은 현장 유무로 서비스 운영사를 추론하지 않으며 기존 Organization을 모두 customer로, legacy owner/operator와 invitation을 admin으로 유지한다.
- 기존 viewer가 고객사 현장 조회 권한을 유지하도록 `SiteMembership`을 비파괴 migration에서 backfill한다.
- invitation signup은 초대 소비와 새 `User` 생성, scoped `SiteMembership` 생성을 하나의 transaction으로 처리한다. operator/viewer 초대는 유효한 `Invitation.siteId`가 필요하며 viewer는 자기 고객사 Organization에 속한 현장으로만 가입할 수 있다. admin 초대는 조직 전체 접근 의미를 유지하므로 membership을 만들지 않는다.
- `PUT /floors/:floorId/editor-state`는 `Floor.mapRevision` optimistic update, normalized row 변경, canonical `FloorMapRevision` snapshot/SHA-256과 `floor_editor.saved` 감사를 하나의 Serializable Prisma transaction으로 저장한다. fixture/object의 층 소속, 중복 ID와 준비되지 않은 asset은 optimistic mutation 전에 거부한다.
- `GET /floors/:floorId/editor-revisions`는 현장 `read`, `POST /floors/:floorId/editor-revisions/:revision/restore`는 `manage` 권한을 요구한다. 복구는 `expectedRevision` 충돌을 `409`로 처리하고, 사라진 fixture를 생성하지 않고 `skippedFixtureIds`로 반환하며 새 revision과 `floor_editor.restored` 감사를 같은 transaction에 남긴다.
- atomic save의 `floorPlan: null`만 배경 삭제를 뜻한다. non-null image/pdf는 source type, ready asset을 가리키는 non-empty `imageUrl`/`originalFileUrl`/`renderedImageUrl`, 양수 INT4 width/height를 모두 포함해야 하며 부분 create/default 값 우회는 `400`으로 거부한다.
- legacy `PATCH /floors/:floorId/floor-plan`은 partial request를 기존 row와 merge해 검증한 complete `effective` 전체 상태를 기록한다. 동시 PATCH도 마지막 writer가 검증한 `none` 또는 complete ready image/pdf 상태로 끝나며 row lock이나 별도 transaction에 의존하지 않는다.
- atomic write schema와 persisted snapshot v1 parser를 분리했다. snapshot parser는 기존 `sourceType: none`, nullable floor-plan URL, nullable geometry와 bounded legacy object type을 canonical shape 그대로 읽고 복구하며, 상한 초과 문자열이나 좌표 배열이 아닌 points 같은 위험 데이터는 `400`으로 거부한다.
- shared editor schema는 fixture update 1,000개와 map object mutation 합계 2,000개를 상한으로 두고 ID/이름/URL/text/color/points 크기, INT4 revision/zIndex와 rectangle/triangle/line/text별 dimensions/points 형태를 제한한다. trim, decimal과 object type 의미 정규화는 optimistic update 전에 끝난다.
- object update는 현재 type/width/height/points를 같은 층에서 먼저 조회하고 patch를 merge한 완성 geometry를 type별 schema로 검증한 뒤에만 optimistic revision을 증가시킨다. restore는 floor `manage` SiteAccess의 opaque `404`를 먼저 적용하고, 권한 확인 뒤 service에서 path revision을 positive INT4로 검증해 authorized invalid path만 `400`으로 반환한다.
- revision 목록은 `cursor`와 `limit`(기본 20, 최대 100)을 사용한다. 응답 actor는 같은 고객사 이름 또는 교차 조직의 `서비스 운영자` display name만 포함하며 user/revision 내부 ID와 email을 노출하지 않는다.
- revision snapshot/hash는 ID canonical order를 유지하지만 GET/save/restore editor state의 object 배열은 canvas 계약에 맞게 `zIndex`, `createdAt`, ID 순으로 안정 정렬한다.
- bootstrap은 기존 customer 사용자가 있어도 `auth:bootstrap-operator`로 최초 service-provider operator를 만들 수 있다. PostgreSQL advisory lock, 기존 service provider/operator 검사, `service_provider` partial Unique index로 둘 이상의 서비스 운영사를 차단하며, 로그인/session 응답에 Organization 유형을 포함한다.
- 수정 전 legacy migration을 적용한 로컬 개발 DB는 checksum 충돌이 발생할 수 있다. 데이터가 불필요한 경우에만 reset을 선택하고, 보존이 필요하면 감사 후 수동 보정 migration을 사용한다. 설정 기능은 자동 reset이나 파괴적 DB 명령을 실행하지 않는다.
- `POST /setup/floors`와 registration session 생성·조회·identify·register·complete는 operator 역할과 대상 현장의 `commission` 권한을 모두 확인한다.
- `GET /floors/:floorId/assets`는 현장 `read` 권한, upload intent와 complete는 `manage` 권한을 확인해 customer admin의 설치 후 도면 교체를 허용하고 viewer 변경은 차단한다.
- 주 메뉴를 `/monitoring`, `/control`, `/statistics`, `/settings` URL route와 링크 navigation으로 전환했다. 선택 현장의 `siteId` query는 주 메뉴와 설정 하위 메뉴 이동에도 유지된다.
- `/settings/floor-plans`는 새로고침과 직접 진입이 가능한 층별 도면 목록을 제공한다. `operator/admin`은 각 층의 `/settings/floor-plans/:floorId/edit` 링크로 이동할 수 있고, 목록·편집·저장·취소 이동에서 현재 `siteId` query를 보존한다.
- `/settings/floor-plans/:floorId/edit`는 route param으로 `GET /floors/:floorId/editor-state`를 조회한다. `operator/admin`만 편집 route를 사용하며 `viewer`의 직접 edit URL은 목록으로 redirect된다. URL에 `siteId`가 없으면 응답 floor의 현장으로 canonicalize하고, 선택 현장과 floor 현장이 다르면 편집기를 표시하지 않고 선택 현장의 목록으로 이동한다.
- 웹 에디터는 shared `SaveEditorStateInput` 계약으로 baseline과 현재 상태를 O(n) 비교한다. 1,000개 fixture에서도 실제 변경된 fixture와 floor plan, object create/update/delete만 중복 없이 `PUT /floors/:floorId/editor-state` 한 번으로 전송한다. floor plan의 `null`/`none`, 기본 source type과 fallback asset URL은 API 의미 형태로 정규화해 unchanged 저장을 만들지 않으며 draft object ID는 UUID로 생성한다.
- atomic save와 revision 복구는 하나의 동기 ref lock으로 상호 배제한다. 요청 중 도구, 캔버스, 배경 입력과 속성 입력을 disabled/read-only로 유지하고, 이미 시작된 배경 asset upload가 끝날 때까지 save/restore도 막아 요청 이후 로컬 수정이 성공 응답에 덮이지 않게 한다. 성공 응답은 새 baseline과 `mapRevision`으로 채택하고 네트워크 오류는 현재 편집 상태를 유지하며, `409`는 강제 덮어쓰기 없이 최신 버전 다시 불러오기만 제공한다. dashboard/editor/revision query는 `siteId`와 `floorId`가 포함된 key로 invalidate한다.
- 버전 패널은 cursor pagination으로 수정자 display name, 시각과 숫자 변경 수 및 `floorPlanChanged`를 합산해 표시한다. loading/error/empty 상태를 구분하고 오류에는 announcement와 재시도를 제공한다. 복구 버튼은 `operator/admin`에게만 제공하고 현재 baseline의 `mapRevision`을 `expectedRevision`으로 전송하며, 현재 존재하지 않아 건너뛴 조명 안내는 같은 floor query refetch 뒤에도 유지한다.
- dirty 상태에서는 앱 내부 링크 이동, 현장 전환, 브라우저 뒤로 가기, 저장하지 않은 취소와 `beforeunload`를 확인한다. dirty 진입 시 현재 URL과 같은 history sentinel을 추가해 첫 back이 editor route를 벗어나기 전에 확인하며, 취소는 sentinel을 복원한다. 저장 또는 승인된 내부 이동·현장 전환·취소는 sentinel entry를 목적지로 replace하고, 같은 editor에서 clean 상태가 되거나 unmount되면 sentinel을 소비해 back stack에 editor가 중복으로 남지 않는다. listener는 unmount에서 정리하고 저장 후 back에는 폐기 확인을 표시하지 않는다.
- `POST /floors/:floorId/editor-lease`는 Redis key `floor-editor:lease:{floorId}`를 캐시·경합 완화에 사용하지만, 실제 편집 권한의 정본은 PostgreSQL `Floor.editorLease*` 컬럼이다. 획득은 같은 transaction에서 만료 여부를 확인하고 monotonic `editorLeaseFence`를 증가시키며, `editorLeaseTokenHash`, `editorLeaseHolderId`, `editorLeaseHolderName`, `editorLeaseAcquiredAt`, `editorLeaseExpiresAt`를 함께 기록한다. 같은 token의 POST는 이 정본을 연장한 뒤 Redis를 best-effort로 갱신하고, `DELETE`와 강제 해제는 fence를 다시 증가시켜 이전 토큰을 무효화한다.
- operator/admin 강제 해제는 먼저 durable `floor_editor.lease_force_release_requested`/`attempted` audit을 기록한 뒤, PostgreSQL 정본의 token hash와 fence를 기준으로 successor를 덮지 않도록 무효화한다. Redis 삭제는 후속 cache cleanup일 뿐 성공 조건이 아니며, stale predecessor를 되살릴 수 없다.
- `PUT /floors/:floorId/editor-state`와 `POST /floors/:floorId/editor-revisions/:revision/restore`는 `leaseToken`, `leaseFence`, `expectedRevision`을 모두 요구한다. 저장·복구 transaction 안에서 현재 `Floor` row의 token hash, fence, 만료 시각을 다시 검증해 lease가 만료되었거나 강제 해제된 stale client를 `409 floor editor lease is no longer active`로 거부하고, 그 뒤 `mapRevision`을 최종 optimistic guard로 검사한다.
- 도면 편집 route는 진입 시 lease를 얻고 editable token이면 30초마다 single-flight heartbeat로 갱신한다. 클라이언트는 `performance.now()` 기반 80초 local deadline watchdog으로 fail-closed 동작을 유지하고, 서버는 PostgreSQL 만료 시각과 fence를 authoritative source로 사용한다. 충돌, 갱신 실패, token 상실, deadline 만료, lease 획득 실패와 floor 전환 중에는 저장/복구/도구/캔버스/배경/속성 변경을 막는 읽기 전용으로 전환한다. 정상 route 이탈은 아직 보유한 token의 release를 요청하고, 브라우저 종료 같은 비정상 종료의 회수는 서버 만료 시각과 Redis TTL에 맡긴다.
- Task 11 완료 후 legacy `PATCH /floors/:floorId/floor-plan`, `PATCH /fixtures/:fixtureId`, `POST/PATCH/DELETE /floor-map-objects` 경로와 웹 export를 제거했다. 이제 도면 변경은 revision·audit·lease fence가 모두 걸린 atomic save/restore 경로로만 가능하며, stale legacy client가 `mapRevision`을 우회해 normalized row를 덮어쓸 경로는 없다.
- Playwright browser 회귀는 operator의 시운전 메뉴 노출, admin의 설정 도면 이동/atomic save/모니터링 좌표 반영, viewer edit URL의 사전 redirect와 mutation `403` fixture를 검증한다. 1,000 fixture editor는 navigation 시작부터 marker 색상 표시와 Konva hit selection까지 8초 이내여야 한다. fixture route는 `apps/web/e2e/support`에만 있으며 assigned `site-1` 밖의 `404`는 test-fixture isolation 검증일 뿐 production tenant E2E 증거는 아니다.
- 설정 shell은 `operator`에 전체 설정 section, `admin`에 설치·시운전과 펌웨어·유지보수를 제외한 운영 section, `viewer`에 설정 개요·도면 관리·장비 상태만 표시한다. 이는 UI 노출 기준이며 서버 권한 검사는 기존 API guard가 계속 담당한다.
- 현장 선택기는 `GET /sites` 응답의 `customerName`과 `name`을 함께 사용하고 URL의 `siteId`를 갱신하며 일반 설정 route의 pathname, 다른 query parameter와 hash fragment를 유지한다. 서비스 운영사 operator가 동일한 현장명을 여러 고객사에서 배정받은 경우 `고객사명 · 현장명`으로 구분해 오조작 가능성을 줄인다. floor 편집 route에서 승인된 현장 전환은 current draft를 baseline으로 되돌려 dirty를 해제하고 이전 floorId를 버린 뒤 새 현장의 `/settings/floor-plans`로 이동한다. 취소 시 draft와 URL을 유지하며, 승인 후 다음 현장 전환에는 폐기 확인을 반복하지 않는다. dashboard, floor fixture, statistics query key는 모두 `siteId`를 포함하며, 선택된 현장은 `/sites/:siteId/dashboard`, `/sites/:siteId/floors/:floorId/fixtures`, `/energy/sites/:siteId/estimate`를 호출해 다른 고객 현장의 캐시를 재사용하지 않는다.
- dirty editor에서 상단 `로그아웃` 버튼을 눌러도 동일한 폐기 확인을 거친다. 취소하면 session과 draft를 유지하고, 승인한 뒤에만 draft를 버리고 `/auth/logout` 후 auth query를 로그인 화면으로 전환한다.
- 역할별 설정 navigation의 모든 링크에 실제 route를 제공한다. 아직 구현하지 않은 현장 및 층, 조명 및 그룹, Gateway, 시운전, 정책, 알림, 보안, 펌웨어, 외부 연동, 장비 상태는 공통 placeholder view를 표시하며, 역할에 없는 section의 직접 URL은 설정 개요로 제한한다.
- 웹 Dockerfile은 production API 요청을 same-origin `/api`로 빌드한다. nginx official template entrypoint가 `API_UPSTREAM`(기본 `http://api:4000`)을 주입하고 `/api/*`를 reverse proxy하며, SPA fallback으로 `/settings/floor-plans` 같은 deep route 새로고침을 `index.html`로 응답한다. Vite 개발 서버는 `/api`를 기본 `http://localhost:4000` upstream으로 proxy해 로컬 API 개발 동작을 유지한다.

## 확정 구현 설계

### 화면과 라우팅

- 주 메뉴를 `/monitoring`, `/control`, `/statistics`, `/settings` URL로 표현한다.
- 설정 하위 경로는 `/settings/floors`, `/settings/floor-plans`, `/settings/fixtures`, `/settings/gateways`, `/settings/commissioning`, `/settings/security` 형식으로 구성한다.
- 도면 편집기는 `/settings/floor-plans/:floorId/edit` 전체 작업 화면으로 연다.
- `MonitoringView`는 에디터 조회 상태와 `도면 편집` 버튼 없이 읽기 전용 도면만 표시한다. 설정 에디터 route가 실제 state 조회와 저장·취소 navigation을 소유한다.
- 모니터링 empty state의 설정 단계 안내는 후속 작업이다.

### 도면 에디터 저장과 버전

- 기존 여러 개별 API의 `Promise.all` 저장을 변경 항목 기반 단일 저장 API로 교체한다.
- `PUT /floors/:floorId/editor-state`가 도면, 도형, 조명 배치를 하나의 Prisma transaction으로 저장한다.
- 요청은 `expectedRevision`, 도면 변경, 조명 변경, 객체 생성·수정·삭제 목록을 포함한다.
- 서버는 조직·현장·역할, 모든 대상의 층 소속, asset 준비 상태와 현재 revision을 검증한다.
- 하나라도 실패하면 전체 변경을 rollback하고 부분 저장을 허용하지 않는다.
- `Floor.mapRevision`은 배경뿐 아니라 층 전체 편집 상태의 optimistic concurrency token이다.
- `FloorMapRevision`은 수정자, 버전, 변경 요약, 복구 원본과 전체 복구 스냅숏을 보관한다.
- 과거 버전 복구는 기존 버전을 덮어쓰지 않고 새 버전을 생성한다.
- 복구는 배경, 도형, 기존 조명의 표시 정보만 대상으로 하며 Mesh 주소나 장비 등록 상태를 생성·삭제하지 않는다.
- 실존하지 않는 과거 조명은 건너뛰고 복구 결과에 경고를 포함한다.
- 호환용 개별 변경 API는 최종 fix wave에서 제거했다. 현재 제품 경로에서 도면 관련 변경은 atomic save/restore만 허용한다.

### 편집 충돌과 파일 보안

- Redis에 층별 90초 cache lease를 두고 편집 화면이 30초마다 갱신한다.
- 다른 사용자가 편집 중이면 읽기 전용으로 열고 수정자와 시작 시각을 표시한다.
- `REDIS_URL`은 API 실행에 필수이며 Redis provider는 최초 lease 요청까지 client 생성을 지연한다. API bootstrap은 Nest shutdown hook을 활성화해 SIGTERM/SIGINT에도 생성된 Redis client의 `quit()`을 호출한다. Redis에는 `{ userId, userName, token, acquiredAt, fence }`를 저장하지만 authoritative validation은 PostgreSQL `Floor.editorLease*` 정본이 담당한다.
- operator/admin의 강제 lease 해제는 requested/attempted 감사 기록을 성공적으로 남긴 뒤 PostgreSQL fence를 증가시켜 이전 holder를 무효화하고, Redis delete 결과를 success 또는 stale_token 감사로 별도 기록한다.
- lease와 별도로 revision 불일치 시 `409 Conflict`를 반환하고 강제 덮어쓰기를 허용하지 않는다. save/restore는 lease fence와 `mapRevision`을 모두 통과해야 한다.
- 변경사항이 있으면 화면 이탈을 확인하고 네트워크 오류 시 클라이언트 편집 상태를 유지한다.
- 도면 저장소는 비공개로 전환하고 만료 시간이 짧은 서명 URL로 업로드·조회한다.
- 확장자 대신 실제 MIME을 검사하고 이미지는 재인코딩하며 PDF는 격리된 worker에서 렌더링한다.
- 원본 PDF는 다운로드 전용으로 제공하며 실패하거나 검역되지 않은 파일은 현재 도면에 연결하지 않는다.

### 현장과 층

- 현장명, 주소, 시간대, 통화와 kWh 요금을 수정한다.
- 층 이름, level, 표시 순서와 활성 상태를 관리한다.
- 층은 hard delete 대신 archive하며 조명이나 Gateway 담당 범위가 남아 있으면 archive를 차단한다.
- `Site.timezone`, `Site.currency`, `Floor.status`, `Floor.displayOrder`를 명시적 필드로 추가한다.

### 조명과 그룹

- 1,000개 이상 조명을 서버 페이지네이션하고 층, 상태, 그룹, 통신 품질로 필터링한다.
- operator/admin은 조명 이름, 정격전력, 도면 좌표와 표시 크기를 수정한다.
- 제품 serial, Mesh 주소, 펌웨어, 인증 관련 값은 읽기 전용이다.
- 그룹 생성·수정·archive와 구성원의 일괄 추가·제외를 지원한다.
- 장비 교체는 논리 Fixture와 전력 이력을 유지하고 연결된 MeshNode만 교체하는 별도 workflow로 구현한다.

### Gateway와 시운전

- 다중 Gateway 목록에서 이름, serial, heartbeat, 펌웨어, 인증서 만료, Mesh 품질과 담당 범위를 표시한다.
- `GatewayFloorCoverage`로 층별 주·보조 Gateway를 지정한다.
- operator 전용 시운전 화면에서 Claim, 검색, provisioning, 임시 배치, 품질 검사를 순서대로 수행한다.
- 완료 시 등록 성공·실패, Mesh 주소, 펌웨어, RSSI, hop count, 명령 성공률과 작업자를 보고서로 보존한다.
- claim code, private key와 Mesh key는 UI, DB 원문과 감사 로그에 노출하지 않는다.

### 운영 정책과 알림

- `SiteOperationPolicy`에 Gateway offline, Fixture stale, 명령 ACK·완료 제한 시간, 디밍 범위와 정전 복구 동작을 저장한다.
- API와 MQTT 처리기가 고정 상수 대신 현장 정책을 사용한다.
- `AlertRule`, `NotificationChannel`, `NotificationRecipient`, `NotificationDelivery`로 조건, 수신자와 결과를 분리한다.
- 반복 장애에는 지연과 cooldown을 적용하고 점검 시간에는 지정 알림을 억제한다.

### 사용자, 보안과 감사

- `SiteMembership`으로 operator와 viewer의 현장 접근 범위를 제한한다.
- 이메일 초대, 역할 변경, 비활성화, 세션 강제 종료와 operator/admin MFA를 제공한다.
- 서비스 운영사 Organization과 고객사 Organization을 구분하고 operator의 고객 현장 배정은 서비스 운영사 권한으로만 변경한다.
- 최초 서비스 계정은 `auth:bootstrap-operator`로 서비스 운영사 Organization에 생성한다.
- operator가 고객사 Organization과 첫 현장·층을 생성하면 자기 계정의 SiteMembership을 함께 만든다.
- operator가 고객사 admin을 초대하고, 이후 고객사 admin은 자기 Organization의 admin/viewer만 초대한다.
- 공통 `AuditLog`에 작업자, 현장, action, 대상, 변경 요약, 결과, IP, User-Agent와 관련 revision을 기록한다.
- 비밀번호, claim code, private key와 인증서 원문은 감사 로그에 저장하지 않는다.

### 펌웨어와 유지보수

- 서명된 OTA package에 대상 제품, hardware revision, firmware version과 SHA-256을 기록한다.
- 시험 장비, 일부 층, 전체 현장 순서의 단계 배포와 유지보수 시간을 지원한다.
- Gateway와 ESP32-H2가 서명과 hash를 검증하며 웹은 바이너리를 장비에 직접 전달하지 않는다.
- 배포 진행률, fixture별 실패, 중단, rollback과 인증서 갱신·폐기 상태를 관리한다.

## API와 데이터 모델 변경 예정

### 주요 API

- `GET/PATCH /sites/:siteId/settings`
- `POST /sites/:siteId/floors`
- `PATCH /floors/:floorId`
- `POST /floors/:floorId/archive`
- `PUT /sites/:siteId/floors/order`
- `GET/PUT /floors/:floorId/editor-state`
- `GET /floors/:floorId/editor-revisions?cursor={revision}&limit={1..100}`
- `POST /floors/:floorId/editor-revisions/:revision/restore`
- `POST/DELETE /floors/:floorId/editor-lease`
- `GET /sites/:siteId/fixtures`
- `PATCH /fixtures/:fixtureId/profile`
- `POST/PATCH /sites/:siteId/groups`
- `PUT /fixture-groups/:groupId/fixtures`
- `GET/PATCH /sites/:siteId/operation-policy`
- `GET /sites/:siteId/audit-logs`

### 주요 신규·확장 모델

- `SiteMembership`
- `Organization.type`: `service_provider`, `customer`
- `FloorMapRevision`
- `GatewayFloorCoverage`
- `SiteOperationPolicy`
- `AlertRule`, `NotificationChannel`, `NotificationRecipient`, `NotificationDelivery`
- `AuditLog`
- OTA package, deployment, target와 result 모델
- `Site.timezone`, `Site.currency`
- `Floor.status`, `Floor.displayOrder`, `Floor.mapRevision`

DB 모델이 실제 변경되는 작업에서는 `docs/database-schema.md`를 같은 커밋에서 갱신한다.

## 구현 순서

1. 현장 접근 범위와 역할 Guard
2. URL 기반 설정 shell과 역할별 navigation
3. 현장·층 CRUD와 archive
4. 도면 에디터를 모니터링에서 설정으로 이동
5. 단일 transaction 저장, revision과 복구
6. Redis 편집 lease와 비공개 asset pipeline
7. 조명 정보와 그룹 관리
8. 다중 Gateway coverage와 시운전 화면 정리
9. 운영 정책과 알림
10. 사용자, MFA, 세션과 공통 감사 로그
11. 서명된 OTA와 유지보수

- 각 단계는 실패 테스트, 최소 구현, 관련 테스트 통과, 메뉴·DB 문서 갱신과 독립 커밋으로 완료한다.
- API를 먼저 배포해 이전 웹과 호환한 뒤 웹을 전환하고, 사용되지 않는 개별 에디터 변경 API를 제거한다.
- 기존 Floor, FloorPlan, Fixture와 FloorMapObject는 삭제하거나 재생성하지 않는 비파괴 migration을 사용한다.
- legacy migration은 기존 Organization을 모두 customer로 유지하고, 현장 유무로 service provider를 추론하지 않는다. service_provider Organization은 배포 권한이 있는 bootstrap CLI로만 명시 생성한다.
- 기존 `owner`/`operator`와 Invitation은 모두 admin으로 변환하고 viewer는 viewer로 유지한다. 기존 customer viewer의 SiteMembership backfill은 유지한다.
- 수정된 legacy migration을 이미 적용한 로컬 개발 DB는 Prisma checksum 충돌이 날 수 있다. 데이터 보존 여부에 따라 reset 또는 감사 기반 수동 보정 migration을 선택하며, 이 기능은 파괴적 DB 명령을 자동 실행하지 않는다.

## 테스트와 완료 기준

- 백엔드 단위 테스트: 역할, 현장 범위, 입력 검증, 층 archive 조건, revision 충돌
- DB 통합 테스트: 원자 저장 rollback, revision 생성·복구, 다른 조직 격리
- 프론트 테스트: 역할별 메뉴, 읽기 전용, 편집 dirty state, API 오류와 충돌 UI
- 웹 E2E: operator 설치 후 admin 도면 편집, 모니터링 반영, viewer 변경 차단
- 동시성 테스트: 동일 층의 두 사용자, lease 만료, 강제 해제와 `409`
- 성능 테스트: 조명 1,000개 로딩·이동·선택·변경분 저장
- 보안 테스트: 다른 조직 IDOR, 직접 API 호출, 악성 파일, private asset URL 만료
- Hardware E2E: Raspberry Pi와 ESP32-H2의 Claim, provisioning, 상태 수신, 제어와 OTA
- 실제 Pi/ESP32-H2 반복 로그와 firmware hash가 없으면 Hardware E2E 또는 양산 검증 완료로 표시하지 않는다.

## 미구현

- 고객사 사용자 초대·비활성화와 operator별 `SiteMembership` 현장 배정을 관리하는 설정 UI
- 현장 정보 수정과 층 CRUD/archive UI
- 비공개 도면 asset과 보안 처리 pipeline
- 조명 정보·그룹 CRUD 관리 화면
- 다중 Gateway와 층 coverage
- ESP32-H2 factory reset과 장비 교체 workflow
- 시운전 보고서
- 운영 정책과 알림
- MFA·세션 관리 UI
- 공통 설정 감사 로그
- 서명된 OTA package, 단계 배포, 중단과 rollback
- 외부 API·Webhook·BMS 연동 설정
- 스케줄·센서·이벤트·장면 설정은 제어 메뉴의 후속 범위로 유지한다.

## 작업 재개 지점

- 2026-07-21 기준 Task 1~5의 역할·현장 접근·설치 시운전 기반 구현을 완료했다.
- Task 5 최종 보완으로 기존 현장이 있는 경우에도 Gateway claim과 조명 provisioning UI를 service-provider `operator`에게만 노출한다. customer `admin/viewer`의 직접 API 호출은 백엔드에서도 계속 차단한다.
- Task 1~5 통합 보안 리뷰와 보완 재리뷰를 완료했다. Floor editor SiteAccess, invitation 원자 소비, legacy migration 역할 보존과 bootstrap singleton을 검증했다.
- Task 6 URL 기반 설정 shell과 현장 선택은 `b5a92bd`, `8b53420`, `7e75f1f`로 완료하고 재리뷰 APPROVED를 받았다.
- Task 8 atomic save/revision API는 `d8d42f1`, `edde0a8`, `8d7aa2e`, `a3aa1b7`, `669be7e`, `d8041f6`, `63cd6fd`, `45336dc`, `f786d3f`에서 단계적으로 보정했다.
- Task 9 웹 변경분 생성, atomic save 전환, 충돌·revision 복구 UI와 dirty navigation guard는 `c43ff85`, `7b1fae0`, `f103f7c`, `d67e27e`, `f0c9e3a`, `3c8bd02`, `1a8bce3`에서 보정했다.
- Task 10/11의 원래 완료 선언 이후 whole-branch final fix wave에서 invitation membership lifecycle, selected-site statistics, viewer read-only control, PostgreSQL authoritative lease fence, legacy mutation 제거, dirty logout guard, Docker shared build 계약, customerName site selector를 추가 보정했다. 승인 여부는 이 문서가 아니라 scoped final re-review가 결정한다.
- 상세 커밋, 테스트 증거와 재개 순서는 `.superpowers/sdd/progress.md`에 유지한다.

## 부족하거나 개선이 필요한 기능

- 설정 shell은 역할별 navigation과 도면 목록 골격까지만 제공한다. 현장·층, 조명·그룹, Gateway, 정책, 알림, 보안, 펌웨어, 외부 연동, 장비 상태의 route는 명확한 placeholder view만 제공하며 CRUD, 실시간 진단, 권한별 상세 workflow는 아직 없다.
- 모바일 WebView용 설정 navigation은 현장 선택 아래 가로 스크롤 메뉴로 전환하며, 에디터 본문은 단일 열 전체 폭을 사용한다. 네이티브 상단 선택 메뉴와의 통합은 후속 UI 작업이다.
- dirty 내부 이동 guard는 링크, 현장 전환과 same-URL sentinel 기반 브라우저 history 이동을 확인한다. Task 10 이후 추가되는 programmatic navigation 경로도 같은 discard/guard 계약에 연결해야 한다.
- Gateway claim, inventory disable, provisioning action은 배정된 operator의 현장 시운전 범위로 제한된다. customer admin/viewer의 현장 설치 작업은 의도적으로 지원하지 않는다.
- 현재 도면 asset은 장기 공개 URL을 응답하므로 민감한 건물 도면에 맞는 private access로 전환해야 한다.
- 다중 Gateway coverage와 층별 radio 품질 진단은 아직 제공하지 않으므로, 사용자가 선택한 Gateway가 해당 층을 실제로 커버하는지는 설치 검증 절차로 확인해야 한다.
- 실제 ESP32-H2 검색·provisioning·model bind, RF 품질과 전체 OTA는 실기 검증 증거가 아직 부족하다.
- MinIO 기반 local S3 integration test는 준비됐지만 현재 개발 머신에 Docker CLI가 없어 실제 실행 증거는 아직 없다.
- PDF는 첫 페이지만 도면 배경으로 렌더링한다. 다중 페이지 선택과 원본 PDF 파일 관리 UI는 후속 작업이다.
- 도형 삭제, 조명/도형 다중 선택과 일괄 이동, undo/redo는 아직 없다. Konva Transformer는 모서리/변 resize만 제공하므로 회전, grid snap과 키보드 미세 조정이 필요하다.
- CAD/DWG/DXF import와 AI 도면 해석 기반 editor object 자동 생성은 후속 MVP 범위다.

## 경쟁 서비스 참고 근거

- Emblaze: Planner의 도면·그룹·센서, Autopilot의 시운전, Dashboard의 모니터링·유지보수 분리
  - https://emblaze.co.kr/support/faq/
- Silvair: 웹 planning과 모바일 commissioning, area·zone·scene·schedule·mesh quality·보고서
  - https://silvair.com/support/faq/
- Casambi Pro: PC planning, tablet commissioning, project·layout·group·cloud gateway 관리
  - https://support.casambi.com/support/solutions/articles/12000102096-introduction-to-casambi-pro
- Signify Interact: Expert와 User의 그룹·zone·firmware·schedule 관리 권한 분리
  - https://sme.interact-lighting.com/web/help/interact-pro/2.7/system-guide/access-per-role.html
- Lutron Vive: schedule, occupancy, daylight, load shed와 energy·health 운영 기능
  - https://www.lutron.com/us/en/controls/systems/vive

## 관련 파일

- `apps/web/src/App.tsx`
- `apps/web/src/api/queries.ts`
- `apps/web/src/features/settings/SettingsShell.tsx`
- `apps/web/src/features/settings/settings-sections.ts`
- `apps/web/src/features/sites/SiteSwitcher.tsx`
- `apps/web/Dockerfile`
- `apps/web/nginx.conf.template`
- `apps/web/src/features/settings/SettingsView.tsx`
- `apps/web/src/features/settings/floor-plans/FloorPlanSettingsView.tsx`
- `apps/web/src/features/settings/floor-plans/FloorEditorRoute.tsx`
- `apps/web/src/features/monitoring/MonitoringView.tsx`
- `apps/web/src/features/floor-editor`
- `apps/web/src/features/floor-map/FloorScene.tsx`
- `apps/web/src/features/floor-editor/editor-diff.ts`
- `apps/web/src/features/floor-editor/editor-store.ts`
- `apps/web/src/features/setup`
- `apps/web/src/features/registration`
- `apps/api/src/floor-editor/floor-editor.controller.ts`
- `apps/api/src/floor-editor/editor-lease.service.ts`
- `apps/api/src/floor-editor/floor-editor.service.ts`
- `apps/api/src/floor-editor/floor-editor-snapshot.ts`
- `apps/api/src/floor-editor/floor-editor.integration.spec.ts`
- `packages/shared/src/schemas.ts`
- `packages/shared/src/product-identity.ts`
- `apps/web/src/api/floor-editor.ts`
- `apps/api/src/floor-editor`
- `apps/api/src/redis`
- `apps/api/src/setup`
- `apps/api/src/gateway-onboarding`
- `apps/api/src/registration`
- `apps/api/prisma/schema.prisma`
- `packages/shared/src/schemas.ts`
- `docs/database-schema.md`
- `docs/menus/monitoring.md`
- `docs/menus/control.md`

## 갱신 규칙

- 설정 메뉴의 현장, 층, 도면, 조명, 그룹, Gateway, 시운전, 운영 정책, 알림, 사용자, 보안, OTA와 연동 기능을 구현·수정·삭제할 때 이 문서를 같은 작업에서 갱신한다.
- 도면 에디터 또는 등록 진입점이 바뀌면 `docs/menus/monitoring.md`도 같은 작업에서 갱신한다.
- DB schema가 바뀌면 `docs/database-schema.md`를 같은 작업에서 갱신한다.
- 자동 테스트 완료, 코드 완료, Raspberry Pi 검증과 ESP32-H2 Hardware E2E를 별도 상태로 기록한다.
