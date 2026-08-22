# 모니터링·제어 집중 구현 설계

기준일: 2026-08-19

## 1. 목표

설정, 통계, 스케줄, 이벤트 기능을 확장하지 않고 다음 현장 검증에 필요한 모니터링과 수동 제어 흐름을 완성한다.

- 조명 상태를 10분 주기로 조회하고 사용자가 즉시 새로고침할 수 있다.
- 자사 ESP32-H2 BLE Mesh 모듈만 검색한다.
- 검색한 조명을 일괄 또는 개별 정보로 등록한다.
- 설정 메뉴에서 저장한 도면 배경, 도형, 텍스트, 조명 배치를 모니터링에서 읽기 전용으로 동일하게 표시한다.
- 개별, 임의 다중 선택, 층 전체, 저장 구역 단위로 밝기를 제어한다.
- 층과 저장 구역은 BLE Mesh Group Address 단일 전송을 사용한다.
- 사용자는 실제 장치 상태 응답으로 명령이 종료될 때까지 하나의 동기 작업처럼 제어한다.
- 장비에서 Health Current 상태만 수집한다.

## 2. 이번 범위에서 제외하는 기능

다음 항목은 삭제하지 않고 후속 기능으로 보류한다.

- WebSocket/SSE 실시간 push
- RSSI, hop count, 명령 성공률 등 통신 품질 고도화
- 장애 이력, 등급, 원인, 담당자와 조치 workflow
- heatmap, 차량 감지, 이벤트 타임라인, gateway coverage
- 스케줄 제어와 이벤트 제어
- 다중 gateway 명령 집계 고도화
- ACK 계약 전면 개편과 MQTT 소비 내구성 재설계
- 명령 재시도, 취소, rollback, 명령 이력 전용 화면
- 설정 메뉴의 사용자, 보안, 현장, 층, 알림, OTA, 외부 연동 신규 기능
- 모바일 전용 화면
- 자동 HIL 판정. 실제 하드웨어 검증은 수동으로 수행한다.

보류 항목은 현재 기능이 완전하다는 의미가 아니다. 특히 단일 gateway 현장 검증을 통과한 뒤 다중 gateway와 장기 운전 검증을 별도 작업으로 진행한다.

## 3. 설계 원칙

### 3.1 양산 경로와 테스트 경로를 분리하지 않는다

구현 코드에는 가상 조명 생성기, mock scan 결과, shell 기반 BLE 대체 adapter를 넣지 않는다. 자동 테스트의 fake는 테스트 디렉터리 안에서만 사용한다.

### 3.2 동기 제어는 사용자 경험의 동기성을 의미한다

HTTP 연결을 BLE Mesh 응답이 올 때까지 유지하지 않는다. 기존 Command, CommandDispatch, PostgreSQL outbox, MQTT ACK 구조를 유지한다.

1. 웹이 명령 생성 API를 호출한다.
2. API는 command ID를 즉시 반환한다.
3. 웹은 대상 선택, 밝기 입력과 적용 버튼을 잠근다.
4. 웹은 command가 terminal 상태가 될 때까지 기존 상태 API를 1초 간격으로 조회한다.
5. 실제 장치 상태가 확인된 조명만 성공으로 처리한다.
6. 전체 성공, 일부 실패, 실패, timeout을 표시한 뒤 제어 잠금을 해제한다.

페이지 새로고침이나 네트워크 재연결 후에도 진행 중 command ID를 복구하여 결과를 다시 조회할 수 있어야 한다. 제어 잠금은 브라우저 전역이 아니라 현재 현장과 현재 제어 작업에만 적용한다.

### 3.3 BLE Mesh 단일 전송의 적용 범위를 명확히 한다

- 개별 조명: 해당 unicast address로 1회 전송
- 임의 다중 선택: 하나의 사용자 command로 생성하되 gateway가 선택 조명에 제한된 병렬 unicast 전송
- 층 전체: 미리 구독한 floor Group Address로 1회 전송
- 저장 구역: 미리 구독한 zone Group Address로 1회 전송
- 임의 선택이 층 또는 저장 구역 구성과 정확히 같으면 API가 해당 Group Address 경로를 사용

임의 조합을 제어 직전에 임시 Group Address로 구성하지 않는다. subscription 설정 자체가 여러 configuration message를 요구하고 장치 구성을 불필요하게 변경하기 때문이다.

## 4. 모니터링 설계

### 4.1 10분 자동 갱신과 수동 새로고침

모니터링 데이터는 목적에 따라 query를 분리한다.

- 현장·층·gateway metadata: 10분 `staleTime`, 10분 `refetchInterval`
- 선택 층 fixture snapshot 전체 페이지: 10분 `staleTime`, 10분 `refetchInterval`
- 선택 층 지도 snapshot: 10분 `staleTime`, 10분 `refetchInterval`
- 브라우저 focus만으로 자동 refetch하지 않는다.

상단에 아이콘과 `새로고침` 텍스트를 함께 가진 버튼을 둔다. 버튼을 누르면 현재 현장의 dashboard metadata, 현재 층 fixture 전체 페이지, 현재 층 지도 snapshot을 병렬로 다시 조회한다.

- 실행 중에는 버튼을 비활성화하고 회전 아이콘을 표시한다.
- 성공 시 `마지막 갱신: YYYY-MM-DD HH:mm:ss`를 서버 응답 완료 시각 기준으로 갱신한다.
- 일부 요청이 실패하면 성공한 데이터를 유지하고 실패한 영역에 재시도 가능한 오류를 표시한다.
- 새로고침은 DB snapshot 조회이며 BLE Mesh Get을 전체 조명에 즉시 전송하는 기능은 아니다.

마지막 조건은 1,000대 현장에서 사용자의 새로고침 한 번이 Mesh 트래픽 폭주로 이어지는 것을 막는다. 실제 상태는 펌웨어 publication과 gateway startup resync가 DB에 반영한다.

### 4.2 읽기 전용 지도 snapshot

모니터링은 editor API를 직접 사용하지 않는다. `SiteAccess read` 권한으로 조회 가능한 전용 floor map snapshot API를 제공한다.

응답에는 다음 정적 지도 값이 포함된다.

- `floorId`, `revision`, `width`, `height`
- 배경 도면의 렌더링 URL과 source type
- `visible=true`인 map object의 type, 위치, 크기, 회전, 점 좌표, 텍스트, 선·채우기 색상, 두께, 글자 크기, z-index

fixture의 위치, 크기와 모니터링 상태는 기존 paginated fixture snapshot에서 가져와 동일한 stage에 합성한다. 지도 snapshot과 fixture snapshot의 책임을 섞지 않는다.

에디터와 모니터링은 동일한 Konva scene renderer를 공유한다. renderer는 `interactive` 속성을 받는다.

- 설정 에디터: `interactive=true`, selection과 Transformer 사용
- 모니터링: `interactive=false`, drag/resize/selection/keyboard handler 미등록

도형 렌더링 코드는 한 곳에서 관리하고 모니터링 전용 status marker layer만 별도로 합성한다. 객체는 z-index 순서대로 그리고 조명 상태 marker는 최상위 layer에 둔다.

설정 에디터 저장 성공 시 같은 브라우저의 map snapshot query를 invalidate한다. 다른 브라우저는 10분 갱신 또는 수동 새로고침으로 변경을 확인한다.

### 4.3 자사 제품 검색 필터

BLE Mesh unprovisioned device UUID에 자사 제품 namespace를 정의한다.

| 바이트 | 의미 |
| --- | --- |
| 0~5 | ASCII `DFKLED` 고정 prefix |
| 6 | UUID format version, 최초 `0x01` |
| 7 | product family |
| 8 | model code |
| 9 | hardware revision |
| 10~15 | ESP32-H2 고유 MAC 기반 6바이트 식별자 |

펌웨어는 부팅 시 이 형식으로 16바이트 device UUID를 생성해 provisioning에 사용한다. gateway는 scan 결과를 API로 발행하기 전에 prefix, format version, 허용 product family와 model code를 검증한다.

- 검증 실패 장치는 사용자 검색 결과와 provisioning session DB에 기록하지 않는다.
- 중복 device UUID는 한 session에서 하나로 합친다.
- 이미 MeshNode로 등록된 device UUID는 `이미 등록됨`으로 구분하고 신규 등록 대상으로 선택할 수 없게 한다.
- 허용 product/model 목록은 gateway 환경변수가 아니라 versioned 제품 registry 코드로 관리하고 테스트 벡터를 펌웨어와 gateway에 동일하게 둔다.

UUID 필터는 주변 타사 장치를 숨기는 제품 식별 규칙이지 보안 인증이 아니다. 위조 장치의 provisioning을 막는 OOB 인증 또는 인증서 기반 provisioning은 별도 보안 작업으로 남긴다.

### 4.4 일괄·개별 조명 정보 등록

검색 결과에서 여러 장치를 선택한 뒤 설정 방식을 고른다.

#### 일괄 설정

- 공통 정격전력
- 이름 prefix. 기본값은 층 이름을 정규화한 `${층이름}-L`
- 시작 번호와 자릿수. 기본값은 다음 예약 번호와 3자리
- 기본 조명 크기
- 자동 배치 시작점과 간격. 화면에서는 `자동 배치`로 제공하고 기본 grid를 사용

이름은 `B2-L001`, `B2-L002`처럼 서버가 원자적으로 번호 구간을 예약하여 생성한다. 브라우저가 최종 번호를 결정하지 않는다.

좌표는 도면 크기 안에서 행 우선 grid로 자동 배치한다. 기존 fixture와 겹치지 않는 첫 cell부터 배치하며 배경 도면이 없으면 기본 1200x800 canvas를 사용한다. 등록 후 설정 에디터에서 실제 위치를 조정할 수 있다.

#### 개별 설정

선택 장치마다 다음 값을 수정할 수 있다.

- 조명 이름
- 정격전력
- x, y 좌표 또는 지도 클릭 위치
- 조명 marker 크기

개별 설정에서도 빈 이름은 서버 자동 이름으로 대체할 수 있다. 이름, 전력, 좌표, 크기는 provisioning 명령 전에 모두 검증한다.

#### 등록 실행

일괄 등록 API는 선택한 node마다 별도 HTTP 요청을 보내지 않는다. 하나의 batch 요청으로 검증하고 다음을 처리한다.

1. session과 선택 node 소유권 확인
2. floor 이름 번호와 gateway mesh unicast 주소 구간을 DB transaction에서 원자 예약
3. 각 discovered node에 pending fixture 정보를 저장
4. node별 provisioning MQTT command 생성
5. 결과를 node 단위로 추적

전체 rollback은 이미 물리 provisioning된 node를 되돌릴 수 없으므로 사용하지 않는다. 대신 각 node를 `pending`, `provisioning`, `completed`, `failed`, `reconcile_required`로 독립 추적하고 성공한 node는 유지한다. provisioning 시작 전 실패만 바로 재시도한다. MQTT ACK 유실처럼 물리 적용 여부가 불명확한 실패는 device UUID와 gateway mapping을 먼저 조회해 일치시키며, 확인 없이 다시 provisioning하지 않는다.

## 5. 제어 설계

### 5.1 제어 대상 UI

제어 화면은 다음 세 모드를 제공한다.

- `개별/다중`: 검색 가능한 조명 목록에서 checkbox로 하나 이상 선택
- `층`: 현재 현장의 층 하나 선택
- `구역`: 저장된 FixtureGroup 하나 선택

조명이 많은 현장을 위해 이름 검색, 상태 필터, 층 필터와 가상 스크롤 또는 페이지 조회를 적용한다. 선택 개수와 제어 불가 개수를 항상 표시한다.

적용 전에 서버가 반환한 `controllable` 상태를 다시 확인한다. 선택 대상에 제어 불가 조명이 있으면 전체 적용을 막고 조명별 사유를 표시한다.

### 5.2 명령 API 계약

명령 생성 입력을 다음 target 형태로 확장한다.

```ts
type DimmingTarget =
  | { type: "fixture"; fixtureId: string }
  | { type: "fixtures"; fixtureIds: string[] }
  | { type: "floor"; floorId: string }
  | { type: "group"; groupId: string };
```

서버는 항상 사용자 site 권한과 실제 DB 관계를 기준으로 대상 fixture를 다시 계산한다. 클라이언트가 보낸 fixture 목록을 floor/group의 권위 있는 구성으로 신뢰하지 않는다.

명령 응답에는 다음 값이 포함된다.

- command ID
- 선택 대상 수
- 실제 전송 대상 수
- `deliveryMode`: `unicast`, `parallel_unicast`, `mesh_group`
- terminal 상태 조회 URL

한 gateway 검증 범위에서는 floor와 group의 모든 fixture가 같은 gateway에 매핑되어 있어야 한다. 그렇지 않으면 명령을 만들지 않고 `현재 여러 게이트웨이에 걸친 대상은 지원하지 않습니다`를 반환한다.

### 5.3 Mesh control group 저장 구조

기존 FixtureGroup에 주소 문자열만 추가하지 않고 gateway별 MeshControlGroup을 둔다. 이후 다중 gateway에서도 같은 floor/group을 gateway별 group address로 나눌 수 있게 하기 위해서다.

MeshControlGroup은 다음 정보를 가진다.

- gateway ID
- target type: `floor` 또는 `fixture_group`
- target ID
- BLE Mesh group address
- 구성 상태: `configuring`, `ready`, `failed`
- 구성 version과 마지막 오류

MeshControlGroupMember는 group과 MeshNode 관계, subscription 적용 상태와 적용 version을 가진다.

- gateway 안에서 group address는 unique여야 한다.
- floor와 FixtureGroup마다 gateway별 control group 하나만 존재한다.
- `ready`가 아닌 group에는 group 명령을 보내지 않는다.
- fixture가 등록되면 floor group subscription을 자동 설정한다.
- fixture가 저장 구역에 추가되면 해당 zone group subscription을 설정한다.
- 구성 변경은 gateway ACK 후에만 `ready`로 확정한다.

이번 범위에서는 설정 메뉴의 그룹 CRUD를 만들지 않는다. 이미 DB에 존재하는 FixtureGroup을 대상으로 subscription 동기화와 제어만 구현한다.

### 5.4 Gateway와 펌웨어의 그룹 명령

Gateway command payload는 `deliveryMode`, `destinationAddress`, `meshControlGroupId`, `meshControlGroupVersion`, `targetFixtureIds`를 포함한다.

- `unicast`: 기존 acknowledged Light Lightness Set 사용
- `parallel_unicast`: concurrency limit을 적용해 acknowledged Set 병렬 실행
- `mesh_group`: group address에 Light Lightness Set Unacknowledged를 정확히 한 번 전송

ESP32-H2는 group Set을 적용한 뒤 실제 PWM 반영값으로 Lightness Status를 publication한다. 많은 노드가 동시에 응답해 Mesh 충돌을 일으키지 않도록 primary unicast address 기반의 결정적 jitter를 적용한다.

Gateway는 expected fixture의 실제 Lightness Status를 모아 fixture별 결과를 만든다. 제한 시간 안에 관측되지 않은 node는 `timed_out`, 다른 밝기를 보고한 node는 `state_mismatch`로 처리한다. 일부 실패는 command의 `partial_failed` 상태로 표시한다.

이 방식은 제어 명령 자체는 단일 Mesh 전송으로 유지하면서, 사용자에게는 각 조명의 실제 적용 결과를 제공한다.

Gateway는 group ID/address/version별 로컬 적용 상태를 `configuring | ready | failed`로 내구 저장한다. 저장 파일은 gateway 데이터 디렉터리에 `0600` 권한으로 두고 임시 파일 쓰기, 파일 `fsync`, 원자 rename, 상위 디렉터리 `fsync` 순서로 교체한다. 상태에는 `groupId`, `groupAddress`, `configurationVersion`, `status`, 마지막 오류와 갱신 시각을 포함한다.

- subscription sync는 첫 Config Model Subscription 요청 전에 `configuring(version)`을 원자 저장하고 `fsync`가 끝나야 시작한다.
- 같은 group의 subscription sync와 dimming은 group ID 기반 단일 직렬화 queue를 공유한다. 다른 group끼리는 병렬 실행할 수 있다.
- 모든 현재 member가 적용된 뒤에만 `ready(version)`을 내구 저장하고, 저장 완료 후 cloud에 ready ACK를 보낸다.
- member 하나라도 실패하거나 state 저장에 실패하면 `failed(version)` 또는 더 보수적인 차단 상태를 유지한다. 이전 ready version으로 되돌리거나 일부 적용 상태에서 group 제어를 허용하지 않는다.
- group dimming은 lock 안에서 `groupId`, address, version과 durable state의 `ready`가 모두 정확히 일치할 때만 BLE 송신한다. `configuring`, `failed`, 누락, 손상, 불일치는 BLE 전에 실패한다.

재시작 시 Gateway는 durable state를 먼저 복원한다. 정상 `ready` snapshot은 exact-match 명령에만 사용할 수 있고 `configuring` 또는 `failed`는 계속 차단한다. 파일이 없거나 JSON/schema/checksum이 손상되면 파일을 격리하고 모든 group을 fail-closed로 취급한 뒤 `mesh-group/resync-request`를 반복 발행한다. Cloud는 해당 gateway의 `ready`를 포함한 모든 control group을 같은 version의 `configuring`으로 되돌리고 member result 상태를 초기화해 전체 subscription sync를 다시 발행한다. Gateway는 각 group의 configuring barrier와 member 전체 적용을 다시 완료하기 전까지 group 제어를 받지 않는다.

### 5.5 Health Current 수집

이번 범위의 장비 health는 BLE Mesh Health Current Status만 사용한다.

- ESP32-H2는 현재 fault code 목록을 Health Server에 유지한다.
- Gateway는 Health Current Status를 fixture state event에 포함한다.
- API는 마지막 Health 관측 시각과 현재 fault code 목록을 저장한다.
- 모니터링 상세와 제어 대상 목록은 `정상`, `장애`, `확인 대기`만 표시한다.
- RSSI, hop count, 품질 등급과 장애 이력은 계산하지 않는다.

기존 Fixture의 단일 status/fault 표현과 호환하면서 `Fixture.healthFaultCodes Json?`와 `Fixture.healthLastSeenAt DateTime?`에 최신 원본 snapshot을 보존한다. 현재 fault가 하나라도 있으면 기존 status는 `fault`로 계산한다.

## 6. 오류 처리

- 10분 polling 실패는 기존 snapshot을 지우지 않는다.
- 수동 새로고침 실패는 metadata, map, fixture 중 실패한 query를 구분한다.
- 제품 UUID가 유효하지 않은 scan event는 gateway 구조화 로그에 사유와 함께 남기되 클라우드로 전송하지 않는다.
- batch 등록의 validation 오류는 provisioning을 시작하기 전에 node별 field 오류로 반환한다.
- provisioning 중 일부 실패는 성공 node를 유지하고 실패 node만 재시도한다.
- group subscription이 `ready`가 아니면 unicast로 몰래 대체하지 않고 제어를 차단한다.
- 진행 중 command가 있으면 같은 화면에서 두 번째 명령을 만들지 않는다.
- 브라우저가 닫혀도 서버와 gateway의 command 처리는 계속되며 재접속 후 결과를 복구한다.

## 7. 테스트 전략

자동 테스트는 계약과 상태 전이를 검증하고 실제 RF/HCI 검증은 사용자가 수동 수행한다.

### 7.1 자동 테스트

- React Query 10분 interval, focus refetch 비활성화, 수동 새로고침 query 범위
- 읽기 전용 Konva renderer가 editor object와 동일한 geometry를 그리며 interaction handler를 등록하지 않는지 검증
- product UUID 유효/버전 불일치/타사 prefix/중복/기등록 필터 테스트
- batch 자동 이름의 동시 예약과 충돌 테스트
- batch 일부 provisioning 실패와 재시도 테스트
- fixture, fixtures, floor, group target 권한과 대상 해석 테스트
- 임의 선택은 parallel unicast, floor/group은 mesh group으로 결정되는지 테스트
- subscription 미완료 group 제어 거부 테스트
- 제어 중 UI 잠금, terminal 복구, 성공/부분 실패/timeout 표시 테스트
- group command 1회 송신과 fixture별 status 수집 gateway 테스트
- sync 첫 전송 전 configuring fsync 순서, sync 중 이전 version 제어 차단, member 부분 실패 fail-closed 테스트
- group별 sync/control 직렬화와 서로 다른 group 병렬 실행 테스트
- Gateway 재시작 ready/configuring/failed 복원, state 파일 유실·손상 시 cloud ready group 전체 resync 테스트
- Health Current fault code 저장과 기존 fixture status 변환 테스트

### 7.2 수동 하드웨어 검증

1. 타사 또는 prefix가 다른 BLE 장치가 검색 결과에 나오지 않는지 확인한다.
2. ESP32-H2 여러 대를 일괄 등록하고 자동 이름과 좌표를 확인한다.
3. 일부 장치 전원을 끈 상태에서 batch 부분 실패와 재시도를 확인한다.
4. 설정 에디터의 배경, 사각형, 삼각형, 선, 텍스트, 색상과 조명 위치가 모니터링에서 동일하게 보이는지 확인한다.
5. 10분 자동 갱신과 수동 새로고침을 확인한다.
6. 개별 unicast와 임의 선택 parallel unicast 결과를 확인한다.
7. 층과 저장 구역 제어 시 gateway 로그에서 group destination 명령이 한 번만 전송되는지 확인한다.
8. 일부 조명의 status publication을 차단해 `partial_failed`와 timeout 표시를 확인한다.
9. ESP32 Health fault를 발생·해제해 웹 상태가 갱신되는지 확인한다.
10. 명령 중 브라우저 새로고침 후 진행 상태와 최종 결과가 복구되는지 확인한다.

## 8. 완료 조건

- 모니터링 자동 조회가 10분 간격이며 수동 새로고침이 동작한다.
- 등록되지 않은 자사 모듈만 검색 결과에 노출된다.
- 일괄/개별 등록이 실제 provisioning 경로를 사용하고 부분 실패를 복구할 수 있다.
- 설정에서 저장한 지도 snapshot이 viewer를 포함한 모니터링 사용자에게 읽기 전용으로 동일하게 표시된다.
- 개별, 임의 다중, 층, 저장 구역 밝기 제어가 동작한다.
- 층과 저장 구역 제어는 group destination 단일 전송을 사용한다.
- UI는 실제 상태 기반 terminal 결과 전까지 제어 입력을 잠근다.
- Health Current fault가 웹 상태에 반영된다.
- 보류 기능이 모니터링, 제어, 설정 메뉴 문서에 명확하게 남아 있다.
