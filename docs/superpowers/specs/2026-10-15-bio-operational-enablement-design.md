# BIO 실사용 운영 적용 설계

기준일: 2026-10-15 (Asia/Seoul)

## 1. 목적과 승인 경계

이미 병합한 BIO 시간제 제어·스케줄 달력을 실제 로컬 현장에 연결한다. 남은 Gateway 배포, DB-host 시각 신뢰 증거, 공휴일 자동 수집, MQTT 최소 권한을 함께 충족해야 실사용 준비 완료로 판정한다. 기존 조명 등록·기본 밝기·센서 설정·지도·비활성 시험 규칙·사용자 미커밋 변경은 보존한다.

사용자는 이 운영 적용과 ServiceKey 사용, 별도 브랜치 후 로컬 머지, 변경·최소 연관 테스트를 요청했다. 이 문서는 그 범위를 구체화한 **검토 대상 설계**이며, 아직 서면 설계/실행 계획 승인 또는 설치·배포 완료 증거가 아니다. 승인 다음 단계는 상세 실행 계획 작성·검토다. 새 OS 서비스 계정 및 관리자 설치가 포함되므로 그 권한 경계를 명시적으로 확인한다.

포함하지 않는 사항:

- 실제 밝기 SET, 시간제 시작/종료, 센서 움직임 HIL, 기존 시험 규칙 활성화.
- 기존 Command Set epoch egress/retention/purge 활성화 및 durable epoch continuity 구현.
- Gateway 인증서 신규 발급·회전 강제, TLS/ACL/시각 안전 관문 완화, OS 시각 강제 조정.
- 다른 장치 지원 추가, 기존 native 데이터 삭제·변환, 전체 테스트/감사, 원격 push/PR.
- 클라우드 이전, 새로운 DB 역할/DB 자격 증명 발급, DB 스키마 변경.

## 2. 확인한 현재 환경

- 소프트웨어 기준: `773abdba3956a9b32cad72187e5146b918835611`, 원본 브랜치 `codex/mvp1-cloud-web`.
- 격리 작업: `codex/bio-operational-enablement-20261015`.
- DB는 Docker VM이 아닌 Mac native Homebrew PostgreSQL 16, loopback 5432다. 현재 PID 같은 휘발성 식별자는 실행 직전 다시 결속한다.
- API live/ready 200, postgres/redis/mqtt/objectStorage/cadConverter 5개 up, Web 200을 사전 확인했다. 이것은 신규 기능의 실장비 성공 증거가 아니다.
- 현장 `41bd16e5-442a-47ac-bcf7-e958d9f3b49a`, Gateway `37dd512d-a61f-4903-9967-1b1ea24e6a02`, assignmentVersion 1, V2 선언이다. 사전 관측 당시 desired/applied 19/19였으며 다른 세션의 정상 UI 작업으로 바뀔 수 있다.
- Pi는 `dfkorea@dfkorea.local`, ARM64, NTP synchronized였다. 실행 중 컨테이너는 고유 `task3-address-*` 이름이며, 보존된 stopped `led-control-gateway-bio`는 현재 런타임이 아니다.
- 실행 이미지의 OCI revision은 `440ead0c5475f0e8f71ed501d16881af342b5af8`, 영속 root는 `/opt/led-control/gateway/data-admin4/{identity,gateway,mesh}`, automation state는 V6였다.
- 현재 BIO 최초 전환 launcher와 BlueZ release/state manager는 이 런타임의 일반 업그레이드·복원을 제공하지 않는다.
- `COMMAND_DB_CLOCK_EVIDENCE_SOURCE`, `HOLIDAY_PROVIDER`는 운영 DI binding이 없다. HolidayYearCoverage는 비어 있고 신규 temporary-control ACL은 없다.
- 발급된 특일 정보 키는 원본 checkout의 `.local/secrets/kasi-holiday-service-key`에 0600, 상위 디렉터리 0700으로 보관했다. 키는 Git·클라이언트·로그·문서에 넣지 않는다. 기존 provider로 실제 2026-10 조회/정규화 1회를 성공했고 DB 쓰기는 하지 않았다.
- 별도 세션의 `센서 UI 시험 · L006 → L001` 비활성 규칙과 준비된 센서 설정은 이번 작업의 삭제/활성화 대상이 아니다.

## 3. 선택한 접근과 대안

추천은 기존 API/Gateway 계약을 유지하면서 **현재 Mac DB-host용 독립 read-only 시각 제공자와 BIO 전용 업그레이드/복원 도구만 추가**하는 것이다. 새 서비스의 필요성은 API 자신이 환경변수·현재시각으로 건강 증거를 만들어 안전 관문을 통과시키지 못하게 하는 데 있다.

대안은 공휴일/MQTT/Gateway만 먼저 연결하고 시간제 제어를 계속 차단하는 것이다. 변경은 작지만 실사용 목표를 충족하지 못한다. 전체 운영 DB failover·Set epoch까지 통합하는 방안은 별도 보안/운영 프로젝트로 남긴다.

## 4. 독립 시각 검증 서비스

### 4.1 신뢰 경계와 배포

- 현재 Mac native DB-host 전용이다. 원격 DB·Docker VM·다중 primary를 이 제공자로 건강하다고 판정하지 않는다.
- 한 번의 관리자 설치로 비로그인 서비스 UID `_kinda_clock`와 root가 보호하는 실행물/설정을 준비한다. API UID와 같거나 공유 `nobody` 계정을 사용하지 않는다. 상시 root 실행은 하지 않는다.
- 제품 실행물과 설정은 저장소/사용자 쓰기 가능 경로에서 직접 실행하지 않는다. root 소유의 고정 설치 디렉터리에 검증한 파일을 복사하고 interpreter/경로·해시·권한을 확인한다. 기존 이름/파일이 다른 소유자로 존재하면 덮어쓰지 않고 중단한다.
- launchd가 producer를 관리한다. 보호된 Unix socket을 통해 API reader가 `read()`만 요청한다. producer는 kernel peer UID를 확인해 설정된 API UID만 허용하며, API가 sample/offset/primary/generation을 지정하는 명령은 없다.
- 실행 디렉터리·socket 상위·설정·세대 상태는 API UID가 교체/쓰기 할 수 없어야 한다. 일반 응답은 16 KiB 이내 엄격 JSON이며 요청 nonce를 exact echo한다. prototype/중복 필드·모르는 필드·불완전 응답을 거절한다.
- primary binding은 설치/명시 재결속 시 운영자가 기존 연결로 읽어 검증한 `startedAt/address/port`, native PostgreSQL 프로세스 시작 신원, 같은 호스트임을 결속한다. DB credential은 producer에 전달/저장하지 않는다. 실행 중 primary 변경은 API의 같은 transaction 비교에서 차단되고, 서비스 재시작/새 primary 재결속은 명시 운영 절차를 거친다.

### 4.2 시간원·정상 판정

- `/usr/bin/sntp -t 1 time.apple.com`을 고정 argv로 읽기 전용 실행한다. `-S/-s/-z`, shell 문자열 실행, 환경변수 offset 주입을 금지한다.
- 기본은 요청 시 새로운 외부 표본을 읽는 방식이다. 같은 in-flight 요청은 합치고, 이미 측정한 표본은 **원 측정 시작시각 기준 1초 이내에서만** 재사용한다. 이전 표본의 발급시각을 현재시각으로 바꾸지 않는다. 공용 시간원에 지속적인 고빈도 polling을 하지 않는다. 수집 timeout/제한으로 표본을 얻지 못하면 새 시작을 보류한다.
- producer 요청의 외부 수집 deadline은 750ms다. 초과한 child/응답은 안전하게 drain하고 건강 증거를 발급하지 않는다. 측정·IPC·API transaction 관측을 합쳐 기존 1,000ms freshness 관문을 통과해야 한다.
- 숫자 offset만 보지 않는다. `abs(offset) + SNTP uncertainty + 측정 구간 wall/continuous 차이의 최대 오차 + 2ms 정밀도 여유 <= 100ms`를 producer/reader에서 추가 강제한다. uncertainty 누락·비정상 exit·잘못된 숫자/단위·예상 밖 출력은 거절한다. 기존 interface의 `offsetMs`에는 실제 signed offset을 전달해 의미를 유지하고, 기존 health의 경계 검사도 그대로 유지한다.
- 시각 관측은 Darwin `CLOCK_MONOTONIC_RAW`처럼 sleep을 포함하고 시각 조정에 영향받지 않는 연속 counter를 사용한다. sleep 제외 uptime으로 대체하지 않는다. wall/continuous 차이가 10ms를 넘게 바뀌거나 관측 공백이 1초를 넘으면 새 step generation을 만들고 unhealthy로 latch한다. 관측 간격은 100ms이며 clock 읽기/구현이 이 계약을 제공하지 못하면 시작하지 않는다.
- 시작/재시작/step/primary 프로세스 신원 변화는 기본 deny다. 3개의 독립 정상 외부 표본과 동일 primary 프로세스가 확인된 현재 관측에 대해서만 관리자 `approve`가 해당 generation을 clear한다. `approve`도 건강하지 않은 표본을 정상으로 바꾸지 못한다. 승인할 관측의 해시/세대가 바뀌면 재시도 대신 중단한다.
- `readEpochContinuity()`는 구현하지 않는다. BIO가 아닌 기존 epoch 경로가 함께 활성화됐다고 주장하지 않는다. provider 장애는 새 start/delivery를 차단하며, 기존 replay/query/accepted end intent·Gateway durable 만료/복구를 폐기하지 않는다.

### 4.3 명시적 한계

일반 SNTP는 인증된 NTS가 아니다. 이 설계는 운영자가 관리하는 호스트/네트워크에서 `time.apple.com`을 시간원으로 신뢰한다는 가정을 둔다. 로컬 API의 증거 위조 방어를 네트워크 공격까지 방어하는 암호학적 시각 증명으로 표현하지 않는다. 이 가정을 수용할 수 없는 배포에서는 새 시작을 닫고 인증된 시간원 제공자를 별도로 설계한다.

관측 사이에 변경됐다 원상 복귀한 모든 OS 시각 조정을 완전히 감사하는 시스템도 아니다. privileged OS 관리와 시간원 자체는 신뢰 경계이며, 새 설치/권한 없이 same-UID child로 대체해 통과시키지 않는다. 관리 권한이 없으면 운영 적용을 중단하고 필요한 설치 단계를 사용자에게 넘긴다.

## 5. 공휴일 연결

- 서버 전용 `KASI_HOLIDAY_SERVICE_KEY_PATH`로 위 보호 파일을 읽어 기존 `KasiHolidayProvider`를 `HOLIDAY_PROVIDER`에 binding한다. `VITE_*`/Web bundle·Gateway로 키를 전달하지 않는다.
- 파일은 symlink가 아닌 regular file, 현재 서버 사용자 소유, 0600 및 API 쓰기 권한 없는 다른 사용자 접근 제한을 검증한다. 누락/잘못된 키는 provider unavailable이며 가짜 키/목업 provider로 대체하지 않는다.
- 기존 최초 당해+다음해 및 일일 갱신 lifecycle를 사용한다. 적용 시 2026/2027 각각 12개월/모든 페이지와 빈 월을 검증하고 기존 단일 transaction 승격·snapshot promotion을 유지한다.
- 부분 실패는 해당 연도를 complete로 만들지 않는다. 이미 검증된 캐시가 있으면 보존하며, coverage 없는 휴일 제외 저장/활성화는 계속 거절한다. provider가 다음 연도를 제공하지 않으면 빈 응답만으로 미래 휴일을 확정하지 않고 원문/공식 제공 범위와 완전성 계약을 검토한다.
- 키는 기존 개발계정 승인 만료(2028-10-15)·트래픽 범위 내에서만 사용한다. 키·raw 요청 URL·오류 body를 출력하지 않는다. 새로운 운영계정 신청·약관 동의는 하지 않는다.

## 6. MQTT 최소 권한

- `DEV_TEMPORARY_CONTROL_SCOPES`에는 현재 DB와 Pi assignment가 일치하는 한 쌍만 넣는다. 불일치하면 쓰기/재시작 전에 중단한다.
- 기존 canonical ACL renderer와 atomic publisher를 사용한다. 사전 ACL이 현재 canonical base와 동일한지 확인한 뒤 API write/read/write, 해당 Gateway read/write/read의 command/result/ingested **6개 grant만** 추가한다.
- 기존 권한을 지우거나 wildcard를 넓히지 않는다. 키·인증서·CRL·Set generation은 보존한다. exact 현재 broker 신원을 재확인하는 기존 reload 경로로 SIGHUP하고 생존·연결·ready를 확인한다.
- 기존 ACL/환경 파일은 보호된 exact 백업을 보존한다. 검증 실패 시 새 grant만 제거한 원본을 복구하고 같은 broker 소유 신원으로 reload한다. 다른 프로세스에 signal을 보내지 않는다.

## 7. Gateway 업그레이드와 복구

### 7.1 배포 전

- tracked BIO 전용 진입점을 추가한다. 이전 주소-only one-shot wrapper를 문자열 치환해 재실행하지 않고, BlueZ manager/최초 전환 launcher의 차단을 우회하지 않는다.
- clean isolated commit에서 production ARM64 bundle을 만들고 exact commit/image/archive/inventory/policy를 검증한다. test-only/이전 bundle을 운영 후보로 쓰지 않는다.
- API를 일시적인 `GATEWAY_DEPLOYMENT_READ_ONLY=1`로 재기동한다. 새 middleware는 GET/HEAD/OPTIONS 이외의 HTTP 요청을 side effect 전에 503 `gateway_deployment_read_only`로 차단하고 이 모드의 응답에는 `X-Kinda-Read-Only: 1`을 붙인다. 정상 모드에는 기존 동작을 유지한다. 이는 읽기 전용 점검 창이며 로그인·저장도 잠시 제한됨을 알린다.
- HTTP admission을 닫은 뒤 기존 명령/임시제어/자동화/준비/등록/refresh/recovery outbox와 활성 의도를 drain한다. 모든 자동 규칙은 비활성이거나 현재 운전 기간 밖이어야 하며 임시 hold/pending release가 없어야 한다. 실제 최신 상태가 다르면 규칙을 임의 비활성화하지 않고 중단한다. broker 기존 명령 TTL 대기도 수행한다.
- fresh receipt에 active container full ID/image/StartedAt, 세 root, identity/assignment/mapping/센서 설정, USB 물리 신원/owner, DB 현재 귀속, 후보 digest를 결속한다. 과거 PID/receipt를 재사용하지 않는다.
- 후보 image의 no-network/no-device/UID999 preflight와 복사본 state V6→V10 보존 검사를 수행한다. 처음 읽은 복사본이 자동 원본 쓰기로 바뀌지 않게 한다.

### 7.2 중단·백업·교체

- 기존 shared/BIO lock과 crash journal을 지킨다. 메타데이터/용량을 미리 검사하고 정확한 active container에 TERM, terminal 및 USB owner 0을 확인한다. timeout이면 강제 kill/다른 owner 중지 없이 중단한다.
- quiesced 동일 시점의 세 root 전체를 CMS 암호화한다. 기존 검증된 recipient/custody를 재사용하되 키 내용은 출력/복사하지 않는다. off-Pi 복호화/manifest/전체 hash·소유권/권한 검증과 실제 격리 복원 drill을 통과해야 교체한다. 원본/이전 백업을 지우지 않는다.
- 원본/보존 stopped 컨테이너는 남기고 고유한 후보 이름을 사용한다. 허용 차이는 검증한 image와 새 배포 소유 label/name뿐이며 실제 Engine config·mount·권한·주소·USB 설정 drift는 거절한다.
- 새 candidate에만 USB를 부여한다. 정상 기동에 필요한 read-only 장치 초기 조회는 예상 동작으로 기록하지만 SET/새 규칙 활성화/시간제 시작을 검증 명목으로 추가하지 않는다.

### 7.3 확인·실패 복구

- exact candidate/restart 0/단일 USB owner/health의 assignment·MQTT·mapping·heartbeat·transport·protocol, 증가하는 heartbeat 3회, 실제 V3·temporary/durable/readback capability와 서버 current revision/hash의 applied ACK를 확인한다. 시각 marker/producer 증거도 확인한다.
- credential rotation·새 RF mutation·새 서버 작업이 발생했는지 확인한다. 관측이 불분명하거나 이미 외부 효과가 생기면 과거 state를 자동 복원하지 않고 journal/lock/실패 상태를 보존해 운영 판단을 요청한다.
- 되돌릴 수 있는 실패에서는 후보 exact ID를 정상 종료하고 USB 해제를 확인한다. 실패한 새 상태를 별도 보호 보존한 다음 **검증된 pre-upgrade 세 root 전체**를 staged rename/journal로 복원해 metadata/hash를 확인한 뒤 old container/image를 재개한다. V10 파일을 남긴 채 구 이미지로만 돌아가는 경로는 금지한다.
- Docker timeout/지연 create/start, rename 중단, 불명확한 owner는 성공/복원 완료로 축약하지 않는다. 재진입은 journal 상태를 먼저 검토한다.
- 구버전 복귀 시 서버가 실제 구버전 capability/current ACK를 다시 관측하기 전 신규 제어를 열지 않는다. 성공 시에도 모든 관문 확인 후 normal API로 재기동해 admission을 열고 journal commit한다.

## 8. 업무 분담·검증·완료 조건

총괄은 설계/체크리스트·공유 경계·결과만 통합한다. backend는 공휴일 DI·독립 제공자 reader·점검 창 middleware, gateway/운영 역할은 producer installer와 BIO 업그레이드/복원 도구를 담당한다. 동일 공유 파일 writer는 한 명이며 계약 커밋을 소비자에게 순차 전달한다. UI 변경은 계획하지 않으며 필요해지면 지정 `제어 UI 개선 담당자`와 협의한다. `제어 페이지 담당자`의 시험 준비를 덮어쓰지 않는다.

최소 검증 범위:

- credential loader/provider binding, 누락/권한/오류 비밀 비노출, complete-year/실패 캐시 보존의 직접 회귀.
- producer/parser/Unix peer·경로 경계, stale/future/timeout/uncertainty/offset 경계, startup·step·primary 변경·재승인, API health/start/publisher 직접 회귀.
- 점검 창의 mutation 차단과 정상 모드 비변경, 기존 accepted end/recovery의 배포 전 drain 보존.
- V6→V10 보존·V10 기록 후 전체 root 복원, 백업 실패·TERM/USB 불명확·늦은 create/start·중간 rename/journal 복구·stopped 기존 컨테이너 보존.
- 실제 공휴일 연도 coverage, exact MQTT allow/타 현장 deny, 새 image의 격리 preflight, 배포 후 health/heartbeat/V3·ACK, API/Web 응답과 변경 기능의 읽기 전용 시각 확인.

전체 suite/production audit 재실행은 하지 않는다. 기존 Web 5개 실패와 무관한 경고를 이번 작업에서 고치거나 숨기지 않는다. schema 변경이 없으므로 migration을 재적용하지 않는다. 제품 변경과 함께 영향 메뉴·운영 문서·상태판을 갱신한다.

**실사용 준비 완료**는 위 운영 관문 통과 및 정상 admission 재개까지다. 실제 점등/유지/자동 복귀 성공은 별도 명시 장비 시험을 수행하기 전에는 완료로 표현하지 않는다. 설치 권한·시간원 신뢰 가정·백업 복원·provider coverage 중 하나라도 충족하지 못하면 그 지점에서 닫고 정확한 차단 사유를 보고한다.

## 9. 현재 단계

- [x] 기존 코드/실행 환경·담당 역할의 읽기 전용 사전 조사
- [x] 발급 인증키의 보호 저장 및 실제 provider 조회 1회 확인
- [x] 독립 작업 브랜치/작업 공간 생성
- [x] 추천 범위의 서면 설계 작성·자체 검토
- [ ] 사용자 서면 설계 검토: 관리자 설치·전용 UID·일반 SNTP 신뢰 가정 포함
- [ ] 상세 실행 계획 작성·검토 후 구현/운영 적용

이 체크리스트는 설계 단계 기록이며 이전 소프트웨어 구현 계획의 완료된 45개 항목을 재개하거나 대체하지 않는다.
