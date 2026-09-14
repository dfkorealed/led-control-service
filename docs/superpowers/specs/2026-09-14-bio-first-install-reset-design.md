# BIO Gateway 최초 설치 재구성 설계

## 목적

admin4 계정의 사용자·현장·층은 유지하면서, 기존 Gateway와 조명 등록 및 그 장비에서 파생된 운영·통계·에너지 이력을 제거한다. Raspberry Pi는 제조 단계에서 발급된 장치 신원만 보존하고 assignment, MQTT 신원, BIO mapping과 runtime state를 초기화한다. 이후 사용자가 Web에서 Gateway claim과 조명 등록을 다시 수행하고, 새 BIO presence polling runtime을 실장비에서 검증한다.

이 절차는 단순 컨테이너 재시작이 아니다. 서버의 claim 상태, 활성 MQTT 인증서, Gateway 관계 데이터와 Pi의 영속 상태가 하나의 설치 세대를 이룬다. 일부만 초기화하면 이미 소비된 claim code, 폐기되지 않은 MQTT 인증서, 오래된 BIO 논리 주소 mapping 또는 이전 outbox가 새 설치에 섞일 수 있으므로 reset 경계를 명시적으로 관리한다.

## 확정된 사용자 범위

- 유지: admin4 사용자 계정, 소속 Organization, Site, Floor와 현재 도면 원본.
- 유지: `GatewayInventory` 제조 인벤토리, 제조용 device certificate ledger, Pi의 제조용 device private key/certificate/CA.
- 삭제: 기존 Gateway, Fixture, MeshNode, 등록 세션, 명령·자동화 실행, 모니터링 사건, 상태·presence 처리 기록과 해당 Gateway/Fixture에서 파생된 통계·에너지 이력.
- 삭제: 기존 BIO runtime의 assignment, MQTT identity, gateway state, mesh/BIO mapping, durable outbox.
- 폐기: 기존 활성 MQTT certificate. 폐기 원장은 보안 감사와 재사용 차단을 위해 삭제하지 않는다.
- 새로 발급: 한 번만 노출되는 claim code, Web claim으로 생성되는 새 Gateway ID, bootstrap으로 생성되는 새 MQTT identity.
- 사용자 수동 단계: Web의 Gateway claim, 조명 검색·식별·등록.

제조용 device identity까지 지우면 `/gateway-bootstrap`의 mTLS 인증 자체가 불가능해져 제조 station에서 새 key/certificate를 넣어야 한다. 따라서 제조 신원과 폐기 감사 원장은 “사용 중인 등록 데이터”가 아니며 reset의 의도적 보존 예외다.

## 선택한 접근

검증 가능한 전용 recommission 도구를 추가한다. 수동 SQL과 임의 Docker 명령은 관계 누락, 잘못된 data root, secret 노출, 두 runtime의 동시 USB open 위험이 있어 사용하지 않는다. 새 제조 serial을 만드는 방식은 제조 station을 요구하고 사용자가 원하는 Web 최초 등록 흐름과 맞지 않는다.

도구는 preview와 apply를 분리한다. preview가 만든 exact target digest를 apply가 다시 요구하며, target Site·Inventory·Gateway·container·data root의 identity가 달라졌으면 어떤 삭제도 수행하지 않는다. 범용 `--all`, wildcard, 임의 경로와 환경변수 기반 recursive delete는 제공하지 않는다.

## 구성 요소

### 1. API recommission service와 운영 CLI

API 내부에 재사용 가능한 `GatewayRecommissionService`를 두고, trusted operator가 로컬에서 실행하는 CLI가 이를 호출한다. 일반 customer Web API에는 reset endpoint를 노출하지 않는다. admin4 사용자는 reset 이후 기존 Web onboarding UI만 사용한다.

이 Lab reset은 admin4 Site에 claimed Gateway가 정확히 한 개이고 모든 Fixture가 그 Gateway에 속한 경우만 허용한다. 다른 Gateway, 다른 Inventory claim 또는 gateway 없는 Fixture가 함께 있으면 임의로 일부만 남기지 않고 preview 단계에서 중단한다. 따라서 아래 삭제는 선택된 Gateway 하나뿐 아니라 admin4 Site의 기존 설치 세대 전체를 의미한다.

Preview는 다음을 읽기 전용으로 산출한다.

- 대상 Organization/Site/Floor, 제조 Inventory, claimed Gateway의 exact ID
- Gateway와 연결된 Fixture/MeshNode/Provisioning/Command/Automation/Incident/Event row 수
- 대상 Fixture/Group의 Energy identity, dimension, membership, cursor, hourly/daily aggregate 수
- claim audit와 Site energy report처럼 외래키 cascade만으로 남을 수 있는 history 수
- 활성 device/MQTT certificate 상태. 인증서 serial/fingerprint 원문은 출력하지 않고 개수와 purpose/status만 표시한다.
- 예상 삭제 범위의 canonical hash인 `resetDigest`

Apply는 같은 행을 transaction에서 잠그고 preview digest를 재계산한다. digest가 다르면 중단한다. 기존 Gateway의 활성 MQTT certificate 폐기가 외부 PKI에 확정되기 전에는 새 claim code를 만들지 않는다. 폐기 확정 후 하나의 DB transaction에서 다음을 수행한다.

1. 대상 Fixture와 FixtureGroup이 참조하는 `EnergyFixtureIdentity`와 `EnergyGroupIdentity`를 명시적으로 삭제해 nullable `SET NULL` 관계 뒤에 과거 aggregate가 남지 않게 한다.
2. admin4 Site의 Command, Automation, Provisioning, Monitoring, processed event/watermark/outbox 데이터를 제거한다. Gateway cascade 후에도 Site 또는 Inventory에 남는 대상 serial의 claim audit도 명시적으로 제거한다.
3. Gateway를 삭제하고 `GatewayInventory.claimedGatewayId`, `claimedAt`을 null로 만든다.
4. `crypto.randomBytes`로 새 claim code를 만들고 기존 scrypt 형식으로 hash만 저장한다.
5. Site 단위 snapshot에 예전 설치 정보가 남지 않도록 기존 `EnergyReportJob`과 그 object cleanup 대상, Floor map revision history를 모두 제거한다. Object storage cleanup은 기존 durable cleanup 경로로 완료하며 DB row 삭제만으로 파일 삭제를 성공 처리하지 않는다.
6. 각 Floor의 fixture sequence와 map revision counter를 초기화하되 Floor, 현재 도면 원본과 도면의 비조명 객체는 보존한다.

평문 claim code는 DB, audit metadata 또는 일반 log에 저장하지 않는다. CLI가 성공 시 owner-only `0600` 임시 파일에 정확히 한 번 기록하고 경로만 출력한다. 사용자가 Web claim을 완료하면 파일을 즉시 삭제하고, claim 실패 시 같은 code를 재발급하지 않고 현재 Inventory 상태를 먼저 확인한다.

Transaction 또는 PKI 폐기가 실패하면 Inventory를 claimable 상태로 만들지 않는다. PKI 폐기는 성공했지만 DB reset이 실패한 불확실 상태는 reconciliation ledger로 남기고 자동 재시도나 새 code 발급을 금지한다.

### 2. Gateway first-install reset helper

Pi에는 기존 `gateway-bio-runtime.sh`의 최초 start 계약을 약화시키지 않고, 별도 `gateway-bio-first-install-reset.sh preview|apply|finalize` helper를 둔다. 입력은 다음 exact 값만 허용한다.

- allowlist 형식의 `/opt/led-control/gateway/data-<installation>` data root
- 실행 중인 BIO candidate의 full 64자리 container ID
- 로그인한 deployment UID
- preview에서 생성된 filesystem/container `resetDigest`

Preview는 current container ID/image/name/running/restart 상태, deploy lock 부재, exact-one BIO USB, data root와 device identity/mapping의 type·owner·mode·inode를 검사한다. secret, UUID, assignment, certificate, mapping payload는 출력하지 않는다.

Apply 순서는 다음과 같다.

1. host 고정 reset lock을 원자적으로 획득하고 모든 identity/inode snapshot을 재검증한다.
2. 새 image가 ARM64에서 검증됐고 bootstrap-only와 BIO runtime preflight artifact를 포함하는지 network-none/read-only 경계에서 확인한다.
3. exact current container를 stop하고 실제 `Running=false`, restart count를 확인한다. container는 즉시 삭제하지 않고 reset ownership label을 붙인 stopped evidence로 보존한다.
4. 같은 filesystem의 owner-only quarantine으로 기존 operational generation을 원자 이동한다. 보존 대상은 device identity generation과 CA뿐이며 MQTT identity, assignment, gateway state, mesh/BIO mapping과 outbox는 새 empty generation에서 사용하지 않는다.
5. UID/GID 999와 기존 mode 계약으로 빈 `gateway`, `mesh`, MQTT identity 위치를 만들고 device identity만 복사하지 않는 원자 pointer/allowlisted 경로로 연결한다.
6. API recommission apply가 성공하기 전에는 새 runtime을 시작하지 않는다.

Apply 전 실패는 container와 filesystem을 변경하지 않는다. current container stop 또는 local generation 이동 뒤 API reset이 확정되기 전 실패하면 quarantine을 원복하고 exact old container를 다시 시작할 수 있다. API가 MQTT certificate 폐기와 DB reset을 확정한 뒤에는 old runtime을 재시작하지 않는다. 이 지점 이후 복구는 새 Web claim을 계속하는 것뿐이다.

Finalize는 새 Gateway bootstrap, BIO runtime health, Web 조명 등록과 read-only polling HIL이 모두 성공한 후에만 실행한다. exact reset ownership/digest를 다시 확인하고 stopped old container와 quarantine operational data만 제거한다. 제조용 device identity와 새 active generation은 삭제 대상이 아니다. recursive delete 대상은 helper가 만든 exact quarantine directory 하나이며 canonical path/inode가 다르면 중단한다.

### 3. 사용자와 함께하는 최초 설치 흐름

1. 전체 build/test와 ARM64 image 검증을 완료한다.
2. API/Pi preview의 exact 대상과 삭제 건수를 사용자에게 보여준다.
3. 현재 BIO runtime을 quiesce하고 Gateway local operational state를 격리한다.
4. 기존 MQTT certificate를 폐기하고 server recommission apply를 실행한다.
5. 사용자에게 owner-only 파일의 새 claim code를 전달한다.
6. 사용자가 admin4 Web에서 기존 Site/Floor를 선택하고 Gateway serial, claim code, 이름을 입력한다.
7. claim 결과의 새 Site/Gateway scope를 secret 비노출 방식으로 Pi bootstrap-only에 전달한다.
8. bootstrap-only가 assignment 저장, 새 MQTT certificate 발급과 CONNECT probe를 한 번 수행한다.
9. 새 BIO runtime을 시작하고 heartbeat가 서로 다른 sequence로 3회 증가하는지 확인한다.
10. 사용자가 Web에서 scan, 필요 시 identify, 선택, Fixture 정보 입력과 등록 완료를 수행한다.
11. 등록 이후 별도 read-only poll에서 scan → high-brightness GET → control-mode GET → fixture-presence publish → state-ingested application ACK를 확인한다.
12. API의 `lastSeenAt`과 BIO metadata가 갱신되고 실제 `brightness`, `powerOn`, energy cursor/aggregate가 poll 때문에 바뀌지 않는지 비교한다.
13. 성공 후 finalize로 old operational data와 container를 제거하고 claim code 임시 파일을 삭제한다.

Web 등록 버튼을 누르기 전에는 address assignment, brightness/mode SET, identify, sensor restore를 보내지 않는다. 사용자가 scan/identify/등록을 직접 실행한 구간의 제조사 전용 write는 사용자 동작으로 허용되며, 이후 read-only polling HIL 구간과 trace를 분리한다.

## 동시성 및 안전 경계

- reset 중 API는 해당 Inventory/Gateway의 새 claim과 bootstrap을 거부한다.
- Pi reset lock은 BIO deploy lock과 상호 배타적이어야 하며 이름이 아닌 exact container ID와 ownership label에 결속된다.
- current와 new runtime을 동시에 실행하지 않는다. USB dongle은 전역 응답 correlation slot 하나를 가지므로 두 process open은 금지한다.
- reset target은 admin4의 exact Site와 제조 serial 한 개다. Site/Organization 전체 삭제, PostgreSQL volume reset, broad Docker prune, glob/환경변수 recursive delete는 금지한다.
- 제조 device private key, claim code, MQTT private key, certificate 원문, UUID/address mapping payload는 trace와 Git에 남기지 않는다.
- reset 완료 후 기존 MQTT certificate로 broker 연결이 거부되는지 확인하고, 새 Gateway certificate만 새 scope에 연결돼야 한다.

## 테스트 전략

### API

- preview가 정확한 관계 row와 history closure를 세고 target mutation에 따라 digest가 달라지는 테스트
- wrong Site/Inventory/Gateway, 이미 unclaimed, disabled inventory, active reset, digest mismatch를 mutation 전에 거부
- MQTT certificate 폐기 실패 시 DB와 claim code 무변경
- DB transaction 후반 실패 시 Gateway/history/Inventory/hash 전체 rollback
- Energy identity/aggregate/cursor, command/automation, incidents, provisioning, events/watermarks, claim audit와 embedded report snapshot 삭제 확인
- admin4 User/Site/Floor, 제조 Inventory/device certificate ledger 보존 확인
- 평문 claim code가 DB/audit/log에 없고 hash 검증만 성공하는지 확인
- disposable PostgreSQL에 전체 migration을 적용한 integration test

### Gateway helper

- fake Docker/filesystem으로 preview/apply/finalize의 exact ID·digest·inode·owner/mode 검사
- candidate가 없거나 둘 이상, container ID drift, USB drift, active deploy lock, symlink/broad path를 모두 mutation 전에 거부
- stop 실패, atomic move 실패, directory prepare 실패에서 old runtime/state 원복
- API reset 확정 이후 old runtime 재시작 금지
- finalize 전 health/HIL evidence 부재 시 old data/container 삭제 금지
- cleanup interruption에서 ownership이 불명확하면 lock과 quarantine을 보존하고 fail closed

### 최종 검증

- Shared/Gateway/API/Web 전체 test, typecheck, build
- 신규 reset API disposable PostgreSQL integration
- Gateway shell contract suite와 ARM64 image verify
- Web 수동 claim/registration
- heartbeat 3회, read-only BIO poll trace, application ACK, API pre/post snapshot
- `KNOWN_STATE_WINDOW_MS=180000`, poll 600000ms, freshness 1200000ms 유지 확인

## 완료 조건

- admin4 계정, Site, Floor와 도면 원본, 제조 device identity만 유지된다.
- 기존 Gateway/Fixture와 관련된 앱 데이터 및 통계·에너지 이력이 조회되지 않는다.
- 기존 MQTT certificate는 폐기됐고 이전 컨테이너/identity로 연결할 수 없다.
- 사용자가 Web에서 새 claim code로 Gateway를 등록하고 조명을 수동 등록한다.
- 새 runtime이 3회 heartbeat와 read-only presence round trip을 완료한다.
- read-only poll이 실제 output/energy state를 변경하지 않는다.
- finalize 뒤 old operational data, stopped container와 claim-code 파일이 남지 않는다.
