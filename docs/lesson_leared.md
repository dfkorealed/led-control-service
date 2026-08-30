# 프로젝트 오답 노트 (Lessons Learned)

## 2026-08-31 / ISR symbol 이름 확인과 IRAM 안전은 같은 검증이 아니다
- **발생했던 문제/실수**: ISR object disassembly에서 허용한 외부 symbol 세 개만 보인다는 사실로 cache-disabled 안전까지 통과했다고 기록했지만 `gpio_get_level`은 flash text에 링크되어 있었다. Build metadata와 분리된 editable `sdkconfig`만으로 test flash를 막아 binary 자체의 mode/CID도 증명하지 못했다.
- **원인**: 호출 집합 검증과 최종 linked address/section 검증을 같은 것으로 취급했고, compile 성공과 wrapper 입력을 artifact provenance로 확대 해석했다.
- **해결 및 예방책**: GPIO control IRAM 옵션을 defaults와 compile guard에 고정하고 build가 linker map에서 ISR과 모든 외부 호출의 IRAM/ROM 주소를 검사한다. Binary, sdkconfig, map, generated flash args, partition, mode/CID와 signed manufacturing approval hash를 artifact manifest에 결속하고 flash 전에 재검증한다. Test image는 metadata 우회와 무관하게 app 첫 분기에서 side-effect 없이 fail-stop한다.
- **반복 방지 체크**: ISR 변경 시 symbol 이름뿐 아니라 linked address를 failure fixture와 clean target map 양쪽에서 확인한다. Production artifact는 exact CID signed approval와 release OTA margin을 통과해야 하며 실제 key/manifest가 없을 때 임의 숫자로 성공시키지 않는다.

## 2026-08-30 / Telemetry gap aggregate와 replay receipt를 함께 bounded하게 유지하기
- **발생했던 문제/실수**: Fixed journal reimport를 accepted aggregate baseline으로 고쳐 exact count는 맞췄지만, journal clear가 계속 실패하는 동안 교체된 일반 source receipt를 outbox `acceptedHandoffs`에서 제거하지 않았다. Journal metadata와 inode는 8 KiB로 고정돼도 source 100회 교체 뒤 regular outbox에는 aggregate 1개와 source receipt 100개가 남아 strict 64 MiB 예산을 계속 소비했다.
- **원인**: Source receipt를 uncleared state replay 방지용 identity와 aggregate count 계산용 metadata로 분리한 뒤에도 stale 정리를 coordinator의 journal clear 이후 reconciliation에만 맡겼다. Clear 예외가 그 경로를 매번 차단하므로, fixed journal의 O(1)만 검사한 테스트는 regular outbox의 O(n)을 보지 못했다.
- **해결 및 예방책**: Fixed journal에 accepted aggregate baseline과 acceptance handoff ID/hash를 유지하고 reimport는 `aggregate - acceptedBaseline`만 반영한다. Baseline에 흡수되고 state/journal에서 더 이상 재생할 수 없는 general source receipt는 같은 outbox import commit에서 제거한다. 현재 state pending handoff/gap, current journal source, cumulative source, aggregate와 active baseline identity는 보호하며 cleanup commit uncertainty는 기존 visible previous/next reconciliation으로 수렴시킨다. Clear tombstone generation과 최초 state gap의 fixed-journal acceptance, cumulative in-memory fallback은 그대로 유지한다.
- **반복 방지 체크**: Clear 100회 실패와 source 교체, 50회 지점 restart, 네 종류 보호 identity, cleanup definite failure 및 previous/next uncertainty, clear 회복 뒤 exact total/event ID/sequence/final hash를 focused 회귀로 유지한다. Journal inode/block뿐 아니라 regular outbox `acceptedHandoffs` 수와 64 MiB 예산도 함께 검사하고, 실제 Raspberry Pi power-cut과 flash wear 결과 없이는 HIL 완료로 표시하지 않는다.

## 2026-08-30 / Local control의 memory-only 예외를 protocol cleanup에 전파하지 않기
- **발생했던 문제/실수**: Full disk에서 RF를 계속하기 위해 도입한 automation state의 in-memory commit이 telemetry handoff/gap clear에도 적용되어, coordinator가 durable source는 pending인데 outbox receipt를 먼저 제거할 수 있었다. Crash 뒤 같은 handoff가 새 event ID와 sequence로 다시 저장되거나 gap count가 늘어날 수 있었다.
- **원인**: 물리 제어 진행성과 cross-file protocol ordering이 같은 generic mutation 성공값을 공유했고, state mutation 결과에 durability가 드러나지 않았다.
- **해결 및 예방책**: State API를 `updateControlState`와 `updateDurable`로 분리하고 모든 결과에 `durable|memory_only`를 명시한다. Memory-only는 schedule/vehicle/manual local transition에만 허용한다. Handoff/gap clear 실패는 memory와 disk를 바꾸지 않고 coordinator batch를 중단하며, source clear가 durable해질 때까지 outbox receipt를 보존하고 bounded backoff로 stable handoff를 재시도한다.
- **반복 방지 체크**: Outbox accepted 뒤 state clear ENOSPC, commit-uncertain rollback 실패, crash/restart exact event identity, disk recovery 뒤 clear-before-release, 다른 gap 성공에 의한 retry starvation과 full-disk local RF 지속을 한 회귀 세트로 유지한다.

## 2026-08-30 / 비동기 실행 보고의 검증 기준은 현재 rule이 아니라 applied revision snapshot
- **발생했던 문제/실수**: Gateway가 이전 revision을 실행한 정상 report를 현재 mutable rule의 source/target으로 검증해, cloud 수정·이동·삭제 직후 execution 원장과 application ACK를 영구 누락했다. Exact desired rejection 뒤 lower applied ACK가 rejection을 지웠고 config retry 정책도 brief와 반대로 무기한이었다. Snapshot 검증 함수 교체 뒤에는 함수가 참조하는 `revision`과 `payload`가 trigger의 `UPDATE OF` 목록에서 빠져 단독 변경이 검증을 우회했다.
- **원인**: Cloud desired state와 Gateway가 실제 실행한 immutable revision을 같은 시점으로 가정했고, out-of-order ACK 전이와 config/application-ACK failure matrix를 양방향 순서·경계로 고정하지 않았다. Trigger 함수의 입력 의존성을 바꾸면서 발화 열 계약을 함께 갱신하지 않았다.
- **해결 및 예방책**: Execution authorization은 `event.revision`의 stored config outbox full snapshot과 canonical hash로 검증하고 live relation은 nullable 감사 FK 연결에만 사용한다. Trigger를 재생성해 `revision`과 `payload` UPDATE도 같은 검증을 거치게 한다. Lower applied ACK는 applied revision만 전진시키며 current rejection을 보존한다. Config와 application ACK 모두 10회 또는 15분에 stored payload를 유지한 retained deadletter로 전환한다.
- **반복 방지 체크**: Rule target 변경·이동·삭제 뒤 old revision report, execution revision-only 및 payload source identity-only UPDATE, rejected-then-lower-applied 순서, config/ACK 각각의 10번째 실패와 정확한 15분 age 경계를 RED/GREEN 및 live PostgreSQL trigger test로 유지한다.

## 2026-08-30 / MQTT runtime module과 HTTP module 의존성 분리
- **발생했던 문제/실수**: production `MqttModule`에 automation consumer를 연결하면서 controller까지 가진 `AutomationModule` 전체를 import해 standalone MQTT module compile test가 HTTP session guard 의존성 누락으로 실패했다.
- **원인**: MQTT background runtime이 필요한 service provider와 HTTP route/controller 조립 경계를 같은 Nest module로 묶었다.
- **해결 및 예방책**: controller 없는 `AutomationRuntimeModule`에 clock, snapshot, capability와 MQTT consumer만 모아 export하고 HTTP `AutomationModule`과 `MqttModule`이 이 runtime module을 각각 import한다. Publisher는 MQTT service를 필요로 하므로 순환을 피하기 위해 `MqttModule`이 직접 소유한다.
- **반복 방지 체크**: background worker를 production module에 추가할 때 standalone module compile test로 controller/guard 의존성이 유입되지 않는지 확인하고, lifecycle/shutdown coordinator provider 존재도 함께 검증한다.

## 2026-08-30 / application ACK exact-report identity와 publisher lease 소유권
- **발생했던 문제/실수**: ACK key가 처음에는 Gateway/event, 이후 Gateway/node/event까지만 포함해 cross-node overwrite는 고쳤지만 same-node 동일 eventId의 altered payload가 원본 applied ACK를 받았다. Published/deadletter ACK도 exact report가 다시 와도 발행 가능 상태로 돌아오지 않았다.
- **원인**: report의 실제 idempotency identity인 complete canonical payload hash보다 ACK key와 Gateway terminal matching이 좁았고, ingestion replay와 outbox publisher가 같은 row의 delivery 상태를 바꾸는 경합에서 lease 소유권 조건이 빠졌다.
- **해결 및 예방책**: ACK에 필수 `reportPayloadHash`를 넣고 key를 Gateway/node/event/report-hash로 고정해 최초 payload/outbox hash/ingestion 시각을 exact report별 불변으로 유지한다. Exact replay는 해당 hash row의 published, deadletter 또는 만료 lease만 조건부 `updateMany`로 재큐잉하며 `leaseExpiresAt > now`인 active publisher는 상태를 마칠 때까지 row를 소유한다. Gateway는 event/node/revision이 같아도 payload hash가 다르면 ACK를 무시한다.
- **반복 방지 체크**: 원본 node 적용 후 cross-node 동일 eventId 충돌, same-node altered payload와 양 replay 순서, published-lost, deadletter, live/expired lease, payload/hash/timestamp 불변을 실제 PostgreSQL 세트로 유지한다. Publisher 구현은 저장 ACK exact publish, variant별 `SKIP LOCKED` claim과 shutdown drain을 함께 검증한다.

## 2026-08-29 / 물리 작업 세션 복구와 불확실 결과 처리
- **발생했던 문제/실수**: 진행 중인 조명 등록 session ID를 브라우저 상태에만 두어 새로고침 시 작업이 사라졌고, provisioning 결과가 불확실한 노드가 있어도 새 scan을 시작할 수 있었다.
- **원인**: 장기 작업의 정본을 서버가 아닌 화면 수명에 의존했고, terminal scan과 물리 작업 완료를 같은 의미로 취급했다.
- **해결 및 예방책**: 현장별 active session 조회로 화면을 복구하고, `provisioning/reconcile_required`가 남으면 retry와 complete를 API에서 차단한다. 불확실 노드는 상태 재조회 뒤 명시적으로 제외하며 성공 노드가 없는 session은 완료가 아니라 취소한다. MQTT 완료와 운영자 제외·취소는 같은 Session/Node 잠금과 허용 상태 재검증으로 직렬화한다.
- **반복 방지 체크**: 장기 작업 UI에는 새로고침 복구, 작업 결과가 일부 생성된 뒤의 재진입, 과거 attempt 미해결 상태 노출, 중복 시작 차단, 서버 불변식, 물리 이벤트와 운영 mutation 경합, 성공 0건 종료 의미를 함께 테스트한다.

## 2026-08-26 / durable outbox 최초 생성과 운영 중 소실 구분
- **발생했던 문제/실수**: 상태 outbox 파일이 없을 때 항상 빈 파일을 생성해 운영 중 미ACK 이벤트 파일 소실을 정상 first-run으로 오인했고, dimming 이외의 RF 작업은 용량 gate 없이 시작할 수 있었다.
- **원인**: 파일 존재 여부만으로 초기화 상태를 판단했고 producer마다 별도 용량 확인을 사용했으며 자발 publication을 위한 선예약이 없었다.
- **해결 및 예방책**: 별도 `0600` manifest와 `0700` 디렉터리로 초기화 이력을 보존하고 missing/corrupt/permission 오류를 health에 명시해 시작을 차단한다. command·scan·identify·provision은 같은 reservation gate를 통과하며, Mesh publication listener는 한 슬롯을 선예약하고 ACK 회복 뒤 재구독·강제 resync한다.
- **반복 방지 체크**: first-run, restart, outbox-only missing, manifest corrupt, unsafe directory, startup-full, concurrent producer와 ACK 회복 테스트를 한 세트로 유지하고 두 outbox 파일을 같은 백업 단위로 다룬다.

## 2026-08-26 / application ACK 수렴과 MQTT ACL producer 권한
- **발생했던 문제/실수**: scan terminal을 MQTT connect 시점에만 재발행해 DB transaction 또는 ACK publish가 한 번 실패한 동일 연결에서는 journal이 영구 undelivered로 남았고, Gateway의 광범위한 `write .../acks/#` 권한이 API 전용 commit ACK self-publish도 허용했다.
- **원인**: reconnect를 유일한 retry trigger로 보았고 ACK namespace를 consumer 관점의 wildcard로 열어 실제 producer별 권한을 구분하지 않았다.
- **해결 및 예방책**: terminal을 durable journal에 저장한 직후 최초 publish 결과를 기다리기 전에 scheduler를 깨우고, 1초~30초 exponential bounded backoff와 exact application ACK로 수렴시킨다. close는 timer와 active publish를 취소하고 reconnect는 generation fence 뒤 즉시 재시작한다. Gateway ACL은 `acks/acceptance`, `acks/device-status` write만 열고 `acks/state-ingested`, `acks/provisioning/scan-terminal-ingested`는 read-only로 고정한다.
- **반복 방지 체크**: transaction 실패·ACK publish 실패 뒤 동일 연결 duplicate 수렴, ACK 뒤 무발행, backoff 상한, concurrent single-flight, close/reconnect와 Gateway certificate의 application ACK publish 거부 테스트를 함께 유지한다.

## 2026-08-26 / 검색 outbox 재발행과 Gateway 논리 실행 중복
- **발생했던 문제/실수**: API durable outbox가 PUBACK 기록 전 crash 뒤 같은 scan-start를 재발행할 수 있는데 Gateway가 이를 새 BlueZ scan으로 매번 실행했고, callback이 멈춘 publish는 lease만 만료될 뿐 retry 횟수가 증가하지 않았다.
- **원인**: broker 전달 멱등성과 물리 scanner 실행 멱등성을 같은 것으로 보았고, outbox lease보다 짧은 publish 종료 경계를 두지 않았다.
- **해결 및 예방책**: API publisher는 30초 lease보다 짧은 10초 timeout으로 timeout/reject를 backoff/dead-letter terminal로 전환한다. Gateway는 logical scan key와 terminal payload를 0600 atomic journal에 보존해 running duplicate를 차단한다. restart는 running을 publish 전 정제 failed terminal로 원자 전환하고, command/application ACK subscription 뒤 connect-ready에서 미전달 terminal만 same eventId/sequence로 직렬 재시도한다. broker PUBACK은 delivered 근거로 사용하지 않고 API의 scan terminal transaction commit 뒤 exact application ACK만 `deliveredAt`을 기록한다. 미전달 terminal은 retention/capacity eviction에서 제외하고 한도 초과는 fail-closed 한다. recovery publish는 10초 timeout과 disconnect cancellation으로 다음 reconnect의 fresh drain을 보장한다.
- **반복 방지 체크**: migration rehearsal에는 historical session duplicate를 migration 전에 넣고, publisher에는 stalled callback/lease 경계 테스트를 유지한다. Gateway에는 pre-connected startup, PUBACK-only journal 보존, exact ACK, duplicate ACK, 24시간 미전달 보존, capacity fail-closed, never-callback timeout/disconnect, reconnect fresh drain, concurrent drain과 corrupt journal 테스트를 유지한다.

## 2026-08-26 / 동일 membership row의 operation 실패 덮어쓰기
- **발생했던 문제/실수**: 동일 `meshNodeId`의 주소 교체에서 old-address Delete 실패 뒤 new-address Add 성공을 같은 `MeshControlGroupMember` row에 순차 기록해, 마지막 성공이 실패를 지우고 group을 `ready`로 승격할 수 있었다.
- **원인**: operation 단위 ACK와 member 단위 최신 상태를 같은 집계 근거로 사용했고, group 실패 여부를 최종 member row에서만 다시 계산했다.
- **해결 및 예방책**: 검증된 subscription result의 전체 operation을 별도로 집계해 하나라도 실패하면 member row의 마지막 write와 관계없이 group `failed`와 operation error를 보존한다. 모든 operation 성공과 현재 member version 일치를 함께 만족할 때만 `ready`로 전환한다.
- **반복 방지 체크**: 동일 node의 old-address Delete 실패와 new-address Add 성공 조합을 API MQTT 회귀 테스트로 유지하고, Gateway의 `(action, meshNodeId, meshAddress)` exact diff 검증을 함께 실행한다.

## 2026-07-15 / Gateway PKI와 원자적 identity
- **발생했던 문제/실수**: API server CA를 Device issuing CA처럼 사용했고, enrollment token을 빠른 hash로 저장했으며, OpenSSL key 생성 직후 권한 노출과 current pointer fsync 실패 시 dangling 가능성이 있었다.
- **원인**: CA 용도, 1회용 secret lookup, multi-file identity 활성화를 각각 독립된 계약으로 분리하지 않고 정상 경로 테스트에 집중했다.
- **해결 및 예방책**: API/Device/MQTT/Manufacturing CA를 별도 파일과 DTO로 구분한다. token은 `<UUID>.<고엔트로피 secret>`으로 만들고 DB에는 salted scrypt hash만 저장하며 serial별 활성 token은 partial unique index로 제한한다. key 파일은 OpenSSL 전에 `0600`으로 선생성하고 immutable generation과 원자 current pointer를 사용한다.
- **반복 방지 체크**: pointer rename 후 fsync 실패, rollback 실패, serial mismatch 후 token 재사용, 잘못된 CA, private key 권한의 생성 순간을 부정 테스트로 유지한다. 실제 Vault/ARM64/Pi/ESP32 증거 없이는 양산 E2E 완료로 기록하지 않는다.

## [날짜 / 태스크명] - 예시
- **발생했던 문제/실수**: 서브 에이전트 리뷰 반영 중 토큰 초과로 끊겼을 때 구문 에러가 방치됨.
- **원인**: 이전 컨텍스트 확인 없이 무작정 코드 빌드부터 실행함.
- **해결 및 예방책**: 재개 시 반드시 린터와 계획서(`writing-plans`)를 먼저 로드할 것.

## 2026-07-03 / 모니터링 화면 실제 연동
- **발생했던 문제/실수**: 모니터링 화면에 층 선택, 조명 상세, 통신 품질, 게이트웨이 상태 UI가 있었지만 일부는 mock 데이터 또는 고정 텍스트에 가까웠고, API 조회도 사용자 조직 범위로 제한되지 않았다.
- **원인**: 화면 구현과 장비/MQTT 계약 구현이 별도 흐름으로 진행되어 `Fixture` 최신 상태, `Gateway` heartbeat, dashboard API, 웹 상세 패널 사이의 연결 검증이 부족했다.
- **해결 및 예방책**: UI 기능을 확정할 때는 항상 `UI 동작 -> API 응답 필드 -> DB 필드 -> MQTT/펌웨어 이벤트` 순서로 미구현 목록을 먼저 작성하고, 서비스 테스트와 화면 테스트를 함께 추가한다.
- **반복 방지 체크**: 인증이 필요한 조회 API는 controller guard, module import, service 조직 필터 테스트를 한 세트로 확인한다.

## 2026-07-05 / 빈 DB 상태 로그인 실패
- **발생했던 문제/실수**: 조명/현장 데이터를 모두 삭제한 뒤 mock 게이트웨이가 과거 fixture ID로 상태 이벤트를 계속 발행했고, API가 존재하지 않는 fixture를 `update`하려다 크래시했다.
- **원인**: 장비 이벤트는 DB 초기화, 장비 교체, mock 데이터 삭제 이후에도 늦게 도착할 수 있는데, MQTT 수신 로직이 대상 row 존재를 전제로 했다. 또한 조직에 `Site`가 0건인 최초 가입 상태를 dashboard API가 처리하지 못했다.
- **해결 및 예방책**: MQTT 상태 반영은 `updateMany`처럼 대상이 없어도 실패하지 않는 방식으로 처리하고, 현장이 없는 조직은 빈 dashboard를 반환한다.
- **반복 방지 체크**: DB를 초기 상태로 만들 때 gateway를 중지하고, 실제 장비의 지연 이벤트가 삭제된 장비 ID를 포함해도 API가 죽지 않는 테스트를 유지한다.

## 2026-07-05 / 조명 등록 전 선행 설정 누락
- **발생했던 문제/실수**: 빈 DB 상태에서 조명 등록을 시작하려 했지만 `Site`, `Floor`, `Gateway`가 없어 등록 세션을 만들 수 없었다.
- **원인**: 조명 등록 UX는 층과 게이트웨이가 이미 있다고 가정했지만, 최초 가입 사용자가 직접 현장과 층을 만드는 온보딩 흐름이 없었다.
- **해결 및 예방책**: 빈 현장 상태에서는 조명 등록 버튼보다 `초기 설치 설정`을 먼저 보여준다. 현장과 층을 생성한 뒤 제조 원장 기반 gateway claim이 성공해야 조명 검색을 연다.
- **반복 방지 체크**: 기능 진입점마다 필요한 선행 데이터가 무엇인지 문서와 empty state에 함께 표시한다.

## 2026-07-06 / 인증 Guard가 있는 신규 API 모듈 부팅 실패
- **발생했던 문제/실수**: `FloorEditorController`에 `SessionAuthGuard`를 적용했지만 `FloorEditorModule`이 `AuthModule`을 import하지 않아 Nest 앱 부팅 시 `AuthService` 의존성 해석이 실패했다.
- **원인**: 서비스 단위 테스트와 타입체크는 통과했지만 실제 Nest module graph 부팅 검증이 빠져 있었다.
- **해결 및 예방책**: `SessionAuthGuard`를 사용하는 신규 module은 `AuthModule`을 imports에 추가한다. API 기능 추가 후에는 관련 서비스 테스트뿐 아니라 로컬 API 서버 부팅 또는 module graph를 검증한다.
- **반복 방지 체크**: `@UseGuards(SessionAuthGuard)`를 추가한 controller가 있으면 같은 module의 `imports`에 `AuthModule`이 있는지 확인한다.

## 2026-07-07 / 도면 에디터 캔버스 이벤트 대상 불일치
- **발생했던 문제/실수**: 에디터 좌측 도구를 선택해도 도면 위 클릭이 내부 `world` 레이어에서 발생하면 도형이 추가되지 않았고, 조명 드래그는 이동량 누적 방식이라 포인터 중심을 정확히 따라오지 않았다.
- **원인**: 테스트가 바깥 캔버스 클릭만 검증했고, 실제 사용자가 클릭하는 배경 이미지/월드 레이어와 조명 드래그 시작점을 충분히 재현하지 못했다.
- **해결 및 예방책**: 도형/조명 객체 클릭은 이벤트 전파를 막고, 빈 도면 영역 클릭은 도구 객체 생성으로 처리한다. 조명 드래그는 누적 delta가 아니라 현재 포인터의 world 좌표를 직접 조명 좌표로 반영한다.
- **반복 방지 체크**: 캔버스 기능 테스트는 바깥 캔버스뿐 아니라 내부 레이어, 배경 이미지, 객체, 조명 각각의 이벤트 전파 경로를 포함한다.

## 2026-07-07 / Konva 에디터 테스트 환경
- **발생했던 문제/실수**: `react-konva` 전환 후 jsdom에는 실제 `canvas.getContext`가 없어 Stage 마운트가 실패했고, 기존 DOM 객체 선택 테스트도 더 이상 유효하지 않았다.
- **원인**: Konva는 실제 canvas context를 전제로 렌더링하며, 도형/조명은 DOM 노드가 아니라 canvas 픽셀로 그려진다.
- **해결 및 예방책**: `apps/web/src/test/setup.ts`에 최소 canvas context mock을 두고, 단위 테스트는 DOM 도형 조회 대신 툴바, 속성 패널, Zustand editor state, 저장 payload를 기준으로 검증한다.
- **반복 방지 체크**: Canvas 기반 라이브러리로 전환할 때는 테스트 setup의 브라우저 API mock과 기존 DOM selector 테스트의 전환 범위를 먼저 점검한다.

## 2026-07-08 / 워크스페이스 스크립트 의존성 해석
- **발생했던 문제/실수**: 루트 `scripts` 디렉터리에 둔 게이트웨이 smoke test가 `pnpm --filter @led-control/gateway exec`로 실행되어도 `mqtt` 패키지를 찾지 못했다.
- **원인**: ESM import의 패키지 해석은 실행 명령의 작업 디렉터리가 아니라 스크립트 파일 위치를 기준으로 상위 `node_modules`를 탐색한다.
- **해결 및 예방책**: 특정 워크스페이스 패키지 의존성을 사용하는 실행 스크립트는 해당 패키지 내부(`apps/gateway/scripts`)에 둔다.
- **반복 방지 체크**: 루트 스크립트에 패키지별 dependency import를 추가할 때는 루트 의존성으로 승격할지, 패키지 내부 스크립트로 둘지 먼저 결정한다.

## 2026-07-08 / ESP-IDF BLE Mesh 모델 옵션 누락
- **발생했던 문제/실수**: ESP32-H2 펌웨어에 Generic OnOff Server와 Light Lightness Server 코드를 추가했지만 링크 단계에서 `esp_ble_mesh_register_generic_server_callback`, `esp_ble_mesh_register_lighting_server_callback` 심볼을 찾지 못했다.
- **원인**: `CONFIG_BLE_MESH=y`와 `CONFIG_BLE_MESH_NODE=y`만으로는 SIG model server 구현이 링크되지 않고, `CONFIG_BLE_MESH_GENERIC_SERVER=y`, `CONFIG_BLE_MESH_LIGHTING_SERVER=y`가 별도로 필요했다.
- **해결 및 예방책**: BLE Mesh model을 추가할 때는 ESP-IDF 예제의 `sdkconfig.defaults`를 같이 확인하고 model별 Kconfig 옵션을 명시한다.
- **반복 방지 체크**: 펌웨어 기능 추가 후에는 반드시 `scripts/esp32-h2-build.sh`로 실제 target build를 돌려 컴파일뿐 아니라 링크까지 확인한다.

## 2026-07-09 / ESP-IDF flash 스크립트 Python 버전 불일치
- **발생했던 문제/실수**: `scripts/esp32-h2-flash.sh /dev/cu.usbmodem1301` 실행 시 Homebrew 기본 `python3` 3.14.6을 잡아 `idf5.5_py3.14_env`를 찾다가 실패했다.
- **원인**: ESP-IDF v5.5.1 설치는 Python 3.12로 진행되어 실제 venv는 `idf5.5_py3.12_env`였지만, flash/build 스크립트가 Python 3.12 PATH를 직접 보정하지 않았다.
- **해결 및 예방책**: `scripts/esp32-h2-build.sh`, `scripts/esp32-h2-flash.sh`에서 `/opt/homebrew/opt/python@3.12/libexec/bin`을 PATH 앞에 자동 추가한다.
- **반복 방지 체크**: ESP-IDF 스크립트 실행 전 로그에서 `Checking "python3" ... Python 3.12.x`와 `idf5.5_py3.12_env` 사용 여부를 확인한다.

## 2026-07-10 / 조명 검색 MQTT 이벤트 생산자 누락
- **발생했던 문제/실수**: 웹에서 조명 검색 세션과 MQTT `provisioning-scan-start` 명령은 생성됐지만, 실제 gateway가 해당 명령을 구독해 `unprovisioned-device-found` 이벤트를 만들지 않아 검색 결과가 0개였다.
- **원인**: API/UI의 등록 세션 구현과 gateway의 BLE Mesh scan/provisioning adapter 구현이 분리되어 있었고, mock gateway도 고정 `MOCK_SITE_ID`만 구독해 실제 DB 현장 ID와 맞지 않았다.
- **해결 및 예방책**: gateway가 `provisioning-scan-start`, `identify-device`, `provision-device`를 구독하고 stub/command adapter를 통해 발견/완료/실패 이벤트를 발행하도록 했다.
- **반복 방지 체크**: MQTT 기반 기능은 command 발행 테스트와 event 생산자 테스트를 같은 작업 범위에 포함하고, 실제 DB의 site/gateway ID와 gateway 환경변수가 일치하는지 확인한다.

## 2026-07-11 / MQTT topic과 tenant 범위 검증
- **발생했던 문제/실수**: 기존 상태 이벤트는 topic의 site ID보다 payload의 fixture ID를 중심으로 갱신해, 인증된 gateway라도 다른 현장 식별자를 섞은 이벤트를 보낼 여지가 있었다.
- **원인**: broker ACL과 topic 문자열을 애플리케이션의 최종 권한 검증으로 간주했다.
- **해결 및 예방책**: topic의 site/gateway, payload의 site/gateway, DB의 Site-Gateway-MeshNode-Fixture 관계가 모두 일치할 때만 이벤트를 반영한다. `eventId`와 영속 sequence로 QoS 1 중복 및 역전도 차단한다.

### Capability 컬럼 추가는 기존 supported fixture까지 함께 이관해야 한다

- **문제**: MeshNode capability에 revision/model flag coherence를 추가하자 기존 DB E2E fixture의 `supported + verifiedAt` seed가 새 기본값 `revision=0`, model flag `false`와 결합해 CHECK를 위반했다.
- **원인**: 새 컬럼의 안전한 create 기본값과 이미 검증된 legacy row의 migration backfill 상태가 다르다는 점을 테스트 fixture가 표현하지 않았다.
- **해결 및 예방책**: 새 노드는 항상 `unknown/revision 0/unverified/unbound`로 시작하고, 검증된 fixture는 status/verifiedAt/revision/model flag를 한 묶음으로 생성한다. forward migration은 fresh replay뿐 아니라 직전 migration까지 적용한 seeded DB에서 supported/unsupported/unknown과 nullable legacy event hash를 각각 확인한다.
- **반복 방지 체크**: 모든 장비 이벤트 테스트에 정상 범위, 다른 tenant 위조, 중복 event ID, 낮은 sequence를 포함한다.

### Node-local 원장 migration은 이름 순서와 legacy 식별 복구를 함께 rehearsal한다

- **문제**: node-local capability migration의 최초 디렉터리 이름이 같은 날짜의 `vehicle_sensor_state_ordering`보다 사전순으로 앞서 fresh replay에서 선행 constraint를 찾지 못했고, 기존 원장에는 직접 `meshNodeId`가 없어 node identity를 무조건 채울 수 없었다.
- **원인**: migration 이름의 날짜가 같으면 설명 문자열까지 실제 적용 순서를 결정한다는 점과, 신규 uniqueness key에 필요한 identity가 legacy row에서 복구 가능한지 여부를 별도로 검증하지 않았다.
- **해결 및 예방책**: migration을 기존 ordering migration 뒤인 `20260831_node_local_capability_ack_outbox`으로 배치하고, capability row는 같은 Gateway의 `fixtureId -> meshNodeId` 관계로만 backfill한다. 해석 불가능한 행은 event/gateway/fixture/sequence를 포함한 remediation 오류로 transaction 전체를 중단하며 자동 삭제하거나 임의 node를 선택하지 않는다.
- **반복 방지 체크**: 새 migration마다 빈 DB 전체 replay, 직전 커밋 migration만 적용한 valid seeded upgrade, 해석 불가능한 invalid seed rollback을 모두 실행하고 실제 적용 로그의 순서를 확인한다.

## 2026-07-11 / 제조 credential 원문 저장 금지
- **발생했던 문제/실수**: 기존 수동 gateway 등록은 serial만 알면 DB Gateway를 만들 수 있어 제조 identity 소유권과 실제 장비를 연결하지 못했다.
- **원인**: 개발용 환경변수의 site/gateway ID 입력 방식을 양산 흐름에도 확장하려 했다.
- **해결 및 예방책**: 제조 원장에는 serial, scrypt claim code hash, certificate fingerprint만 저장한다. claim 성공 시 hash를 폐기하고 private key와 claim code 원문은 DB, Git, assignment에 저장하지 않는다.
- **반복 방지 체크**: credential 기능 리뷰 시 원문 저장 위치, 로그 노출, 재사용 차단, rate limit, 감사 로그를 함께 검사한다.

## 2026-07-11 / ACK 의미 분리와 transactional outbox
- **발생했던 문제/실수**: gateway가 MQTT 메시지를 받았다는 ACK를 실제 조명이 밝기를 적용했다는 성공으로 표시할 수 있었다.
- **원인**: Command 하나에 전송 접수와 fixture별 장비 결과를 함께 저장했다.
- **해결 및 예방책**: 사용자 Command를 gateway별 Dispatch로 분할하고 acceptance ACK와 device-status ACK를 별도 계약으로 관리한다. Command, Dispatch, fixture result, MQTT outbox는 같은 DB transaction에 생성한다.
- **반복 방지 체크**: 그룹 제어 테스트에 여러 gateway, 부분 실패, timeout, 중복 idempotency key를 포함하고 상위 Command는 모든 dispatch 종료 후 확정한다.

## 2026-07-11 / 하드웨어 검증 수준 구분
- **발생했던 문제/실수**: Mac stub 테스트나 ESP-IDF build 성공을 Raspberry Pi BlueZ Mesh 및 실제 RF 성공과 혼동할 가능성이 있었다.
- **원인**: 코드 완료, target build 완료, 단일 보드 검증, 2-node 현장 검증의 완료 용어가 분리되지 않았다.
- **해결 및 예방책**: 상태를 `자동 검증 완료`, `Raspberry Pi Phase 0 완료`, `2-node HIL 3회 완료`로 분리한다. 상위 수준의 로그가 없으면 양산 준비 완료로 기록하지 않는다.
- **반복 방지 체크**: 하드웨어 기능 문서에는 사용 장비, firmware hash, 실행 명령, 반복 횟수, 실제 status와 journald 로그 경로를 남긴다.

## 2026-07-13 / 운영 MQTT 보안 전환 후 로컬 개발 실행 계약 불일치
- **발생했던 문제/실수**: API는 모든 환경에서 MQTT mTLS 인증서를 강제하도록 변경했지만 루트 `.env`, Docker 기본 서비스, mock gateway와 README는 평문 1883 실행 방식을 유지해 `pnpm dev`가 `MQTT_CA_PATH is required`로 종료됐다.
- **원인**: 런타임 보안 정책만 변경하고 루트 개발 오케스트레이션, 인증서 발급, mock client identity, 고정 포트와 문서를 하나의 실행 계약으로 함께 검증하지 않았다. 상대 인증서 경로도 workspace별 현재 디렉터리에 따라 잘못 해석될 수 있었다.
- **해결 및 예방책**: 루트 `pnpm dev`가 절대 인증서 경로를 주입하고 개발 PKI, mTLS Mosquitto, DB migration과 자식 프로세스 수명주기를 관리하도록 했다. 런타임 mock identity는 제거하고 실제 claim된 `DEV_GATEWAY_ID`만 허용한다.
- **반복 방지 체크**: 인증·전송 정책을 강화할 때 API, 실제 gateway, compose, `.env.example`, 루트 실행 명령을 같은 테스트 단위로 확인하고 실제 루트 명령으로 로그인까지 검증한다.

## 2026-07-13 / Raspberry Pi 호스트 패키지와 pnpm store 불일치
- **발생했던 문제/실수**: Debian 13에서 `rfkill` 명령을 `util-linux` 패키지로 설치하려 했고, 로컬 의존성 갱신은 기존 pnpm store v11과 현재 pnpm 9 store v3가 달라 실패했다.
- **원인**: macOS와 Debian의 패키지 구성을 일반화했고, workspace의 기존 `node_modules`가 어떤 pnpm/store로 설치됐는지 확인하기 전에 add 명령을 실행했다.
- **해결 및 예방책**: Pi host preflight는 Debian의 `rfkill` 패키지를 직접 설치한다. pnpm 의존성 변경 전에는 `node_modules/.modules.yaml`의 store 경로와 실행 pnpm 버전을 확인하고 기존 설치를 임의로 재생성하지 않는다.
- **반복 방지 체크**: 실제 OS package 이름은 대상 OS의 `apt-cache show`로 검증하고, appliance build는 clean container의 frozen lockfile 설치로 재현한다.

## 2026-07-13 / private D-Bus 실기 호출과 64비트 token
- **발생했던 문제/실수**: fake D-Bus 테스트는 통과했지만 Pi에서는 bus 접속 정책, callback 메서드의 `this` 손실, Promise/callback 호출 규약, uint64 정밀도 문제로 `CreateNetwork`와 `Attach`가 차례로 실패했다.
- **원인**: 테스트 double이 실제 `@homebridge/dbus-native`의 callback API와 Long.js 반환 형식을 재현하지 않았고, system bus 정책에서 연결 허용과 daemon 응답 수신을 별도 권한으로 보지 않았다.
- **해결 및 예방책**: root/gateway만 private bus 접속을 허용하고 DBus/BlueZ 응답 수신을 명시했다. introspected 메서드는 원 interface에 bind해 callback을 Promise로 변환하며 `ReturnLongjs`의 low/high를 bigint로 저장하고 Attach에는 10진 문자열을 사용한다.
- **반복 방지 체크**: D-Bus wrapper 테스트에는 callback 방식, `this` 의존 메서드, 다중 반환, 64비트 최대 범위를 포함하고 실제 Pi Phase 0를 자동 테스트와 별도 관문으로 유지한다.

## 2026-07-14 / 기본 개발 실행에 mock 장비 혼입
- **발생했던 문제/실수**: 사용자가 실제 조명 검색을 시험하려고 `pnpm dev`를 실행했지만 mock gateway가 함께 시작되어 하드웨어가 꺼진 상태에서도 가짜 후보 4개가 즉시 검색됐다.
- **원인**: 일반 개발 실행과 cloud pipeline 시뮬레이션 실행을 같은 명령으로 묶었고 mock producer의 기본 발견 개수 4가 실제 BLE scan 결과처럼 API DB에 저장됐다.
- **해결 및 예방책**: `pnpm dev`는 API와 Web만 실행하고 실제 gateway MQTT 이벤트만 받는다. 실행 가능한 Mock gateway와 `dev:mock` 경로는 제거하고, 테스트 데이터는 `src/test` 또는 `*.spec.ts` 내부의 불변 fixture로만 격리한다.
- **반복 방지 체크**: 양산 장비 시험 명령에는 mock/stub/simulator process를 포함하지 않고, 가짜 장비 이벤트에는 mock firmware 식별자를 유지해 DB 정리와 감사 시 구분 가능하게 한다.

## 2026-07-14 / 테스트 전용 런타임과 양산 E2E 경로 혼재
- **발생했던 문제/실수**: 웹 mock API, mock gateway, 파괴적 demo seed, legacy MQTT v1이 실제 장비 경로와 같은 workspace와 실행 설정에 남아 있었고 고정 통계·설정 문구가 실제 기능처럼 표시됐다.
- **원인**: 초기 MVP 시뮬레이션 자산을 실제 BlueZ/MQTT v2 구현 뒤에도 제거하지 않았고, 현장 생성과 제조 gateway claim을 별도 흐름으로 구현하면서 전체 온보딩 E2E를 다시 연결하지 않았다.
- **해결 및 예방책**: 제품 런타임의 mock 선택지를 제거하고 테스트 fixture/stub은 test directory로 격리했다. demo seed는 빈 DB 전용 operator bootstrap으로 교체하고 MQTT v1을 제거했다.
- **반복 방지 체크**: 실장비 완료 판정은 `operator -> site/floor -> inventory claim -> assignment -> scan -> provision -> monitor -> v2 ACK control` 전체가 한 번에 실행된 증거가 있을 때만 한다. claim UI 구현만으로 완료 처리하지 않고 Raspberry Pi와 ESP32-H2의 연속 로그를 증거로 남긴다.

## 2026-07-15 / 제조 등록과 배포의 인증서 순환 의존성
- **발생했던 문제/실수**: 배포 스크립트가 claim 뒤에 발급되는 MQTT 인증서를 실행 전에 요구해, image를 올리고 제조 device identity를 생성하는 최초 절차 자체가 막혔다.
- **원인**: 제조 identity, claim, MQTT identity의 발급 순서를 배포 사전 조건과 함께 검증하지 않았다.
- **해결 및 예방책**: image를 먼저 load한 뒤 제조 device identity만 확인하고, MQTT key·CSR·인증서는 claim과 assignment 이후 gateway가 자동 발급한다.
- **반복 방지 체크**: 온보딩 배포 테스트는 `image load -> 제조 등록 -> claim -> bootstrap -> MQTT 발급` 순서를 기준으로 각 단계가 다음 단계 산출물을 미리 요구하지 않는지 검사한다.

## 2026-07-15 / Docker secret scan의 문서 예시 오탐
- **발생했던 문제/실수**: image secret scan이 실제 key가 아니라 dependency README의 예시 PEM을 private key로 감지했다.
- **원인**: 양산 runtime에 필요 없는 Markdown이 node_modules에 포함됐고, 단순 문자열 scan이 실제 secret과 문서 예시를 구분하지 못했다.
- **해결 및 예방책**: runtime image에서 dependency Markdown을 제거하고 image와 배포 archive를 다시 scan한다.
- **반복 방지 체크**: secret scan은 source, runtime image, 배포 archive를 구분해 수행하고, 오탐 제거 후에도 `BEGIN ... PRIVATE KEY` 0건을 증거로 남긴다.

## 2026-08-06 / Playwright API route glob의 source module 가로채기
- **발생했던 문제/실수**: E2E API fixture에 `**/api/**` route를 등록했더니 `/src/api/auth.ts`, `/src/api/queries.ts` Vite module 요청까지 `404`로 처리되어 React가 빈 화면으로 남았다.
- **원인**: Playwright glob은 pathname segment 경계를 강제하지 않으므로 `src/api`도 패턴에 포함된다. fixture handler가 URL pathname을 다시 검사하지 않고 모든 비매칭 요청을 API `404`로 fulfill했다.
- **해결 및 예방책**: route handler 첫 단계에서 `pathname.startsWith("/api/")`를 확인하고 그 외 요청은 `route.continue()`로 넘긴다. fixture data는 E2E support 아래에만 두고, tenant/site 범위를 벗어난 실제 API path만 `404`로 제한한다.
- **반복 방지 체크**: Vite SPA E2E route mock을 추가하면 source module과 asset 요청이 정상 `200`인지, 인증 loading 화면이 아닌 실제 React 화면이 렌더되는지 함께 확인한다.
## 2026-08-13 / Lab PKI도 제품 신뢰 흐름을 우회하지 않기

- **발생했던 문제/실수**: 실제 장비 E2E에 필요한 Vault, Root 서명, 제조 station 준비가 수동 단계로 흩어져 재현하기 어렵고 개발 CA 경로와 혼동될 수 있었다.
- **원인**: PKI 산출물의 소유 경계, 발급 순서와 reset 범위를 하나의 실행 계약으로 검증하지 않았다.
- **해결 및 예방책**: `PKI_ENV=lab` 전용 orchestrator가 persistent Vault, 목적별 intermediate, 별도 제조 CA/station, CRL, 제한 token과 실행 bundle을 생성한다. 제품의 제조 등록, claim, bootstrap, MQTT mTLS API는 그대로 사용한다.
- **반복 방지 체크**: root token/private key 비출력, secret `0600`, loopback Vault, 동일 입력 멱등성, 타 CA·폐기 station 거부와 Lab 디렉터리만 삭제하는 reset을 자동 테스트한다. 실제 Pi/ESP32 증거 없이는 양산 완료로 표시하지 않는다.

## 2026-08-21 / 동일 opcode 비동기 응답 상관관계

- **발생했던 문제/실수**: 같은 source/opcode를 공유하는 BLE Mesh Config Status를 동시에 기다릴 때, 다른 요청의 응답이나 parser 실패가 잘못된 waiter를 먼저 reject시켰다.
- **원인**: source/opcode까지만 맞으면 parser를 바로 실행했고, 요청별 element/group/model 같은 세부 상관관계를 parser 이전에 확인하지 않았다.
- **해결 및 예방책**: 공통 wait API에 request-specific raw matcher를 추가해, parser 전에 해당 요청과 일치하는 raw payload만 waiter가 소비하게 한다.
- **반복 방지 체크**: 동일 source/opcode로 동시에 발행되는 요청은 역순 응답, 타 요청 status failure, malformed payload를 포함한 상관관계 테스트를 유지한다.

## 2026-08-26 / 병렬 서브에이전트의 Git index 공유 충돌

- **발생했던 문제/실수**: 서로 다른 파일을 수정하던 병렬 서브에이전트가 동시에 `git add`와 `git commit --amend`를 실행해 다른 작업의 staged 파일이 잘못된 커밋에 포함됐다.
- **원인**: 파일 쓰기 범위는 분리했지만 모든 에이전트가 같은 working tree와 Git index를 공유한다는 점을 커밋 절차에 반영하지 않았다.
- **해결 및 예방책**: 병렬 서브에이전트는 코드 수정, 테스트, 변경 파일 보고까지만 수행한다. 메인 에이전트가 `git diff`와 정확한 파일 목록을 확인한 뒤 작업 단위별로 순차 stage/commit한다.
- **반복 방지 체크**: 병렬 구현을 시작할 때 모든 구현자에게 `git add/commit 금지`를 명시하고, 각 커밋 직후 `git show --name-status`로 다른 작업 파일 혼입 여부를 확인한다.

## 2026-08-26 / MQTT customHandleAcks 내부 publish 교착

- **발생했던 문제/실수**: 조명 상태 DB transaction 뒤 같은 MQTT client로 application ACK publish 완료를 기다린 다음 수신 PUBACK을 보내도록 구현해, outgoing PUBACK 처리가 custom ACK callback에 막히고 10초 후 연결이 끊겼다.
- **원인**: MQTT.js packet 처리 callback 안에서 같은 연결의 후속 QoS 1 publish callback까지 await해 순환 대기를 만들었다.
- **해결 및 예방책**: 상태 DB commit 뒤 수신 PUBACK을 먼저 완료하고 application ACK는 추적되는 후속 handler로 발행한다. application ACK가 실패하면 Gateway durable outbox가 같은 event를 재발행하고 API duplicate ACK로 수렴한다. 종료 시작 뒤 새 custom ACK 입력은 연결을 끊어 persistent session 재전달을 보존한다.
- **반복 방지 체크**: custom ACK 테스트는 미완료 outgoing publish를 둔 상태에서도 수신 PUBACK이 먼저 호출되는지, shutdown drain 이후 새 입력이 DB에 들어가지 않는지 검증한다. 실제 mTLS broker E2E에서 상태를 2건 이상 연속 발행해 application ACK를 확인한다.

## 2026-08-27 / pnpm script 인자 구분자 전달

- **발생했던 문제/실수**: 제조 등록 런북의 `pnpm gateway:manufacturing:enroll -- --target ...` 명령이 단독 `--`까지 shell script에 전달해 `invalid arguments`로 종료됐다.
- **원인**: 직접 실행하는 shell script의 엄격한 인자 parser와 pnpm 명령 구분자의 실제 전달 방식을 확인하지 않고 일반적인 `--` 예제를 사용했다.
- **해결 및 예방책**: 옵션을 `pnpm gateway:manufacturing:enroll --target ...` 형태로 직접 전달하고, 두 실장비 런북에 단독 `--`가 다시 들어오지 않는 문서 회귀 테스트를 추가했다.
- **반복 방지 체크**: pnpm script 예제는 문서에 넣기 전에 그대로 실행해 parser가 첫 인자로 무엇을 받는지 확인하고, 보안·제조 명령은 런북 문자열도 자동 검사한다.

## 2026-08-27 / 중단된 Lab PKI 산출물과 macOS symlink 권한 검사

- **발생했던 문제/실수**: Docker Desktop 내부 VM 정지 뒤 Lab PKI 실행이 중단되면서 헤더와 푸터만 남은 CSR을 재사용했고, 정상 발급된 station key도 macOS에서 symlink 자체 권한을 검사해 거부했다.
- **원인**: 파일 존재 여부를 유효성으로 간주했고, 인증서 chain을 가져오면 Root와 intermediate issuer가 함께 생기는 Vault 동작 및 BSD `stat`의 symlink 처리를 반영하지 않았다.
- **해결 및 예방책**: 기존·신규 CSR을 OpenSSL로 검증하고, Vault import 응답에서 개인키에 연결된 issuer만 기본값으로 선택한다. secret 권한은 경계 검증을 마친 실제 대상 경로에서 확인하며 모든 발급 역할을 EC P-256으로 고정한다.
- **반복 방지 체크**: PKI 재실행 테스트에 손상 CSR, 다중 issuer mapping, 경계 내부 symlink와 EC CSR 발급을 포함하고, Docker API 500이 발생하면 먼저 Docker 엔진 응답과 Desktop VM 상태를 확인한다.

## 2026-08-30 / 복구 안전성은 우선순위와 queue 진행성을 함께 검증한다

- **발생했던 문제/실수**: Clock-untrusted restart에서 만료를 판단할 수 없는 manual을 arbiter에서 제거해 event/schedule이 실제 출력을 덮었고, targeted resync는 4,096개 capacity 바깥 fixture를 one-shot full resync에만 맡겨 첫 pass 오류 뒤 durable fence를 고립시켰다. Rolling old API wire는 broker 이전 outbox 지연을 증명할 metadata가 없는데도 전체 요청 duration을 새 monotonic lifetime으로 만들었다.
- **원인**: 불확실한 상태를 제외하는 fail-safe가 `manual > event > schedule` 우선순위를 깨뜨렸고, bounded queue 자체를 recovery source-of-truth로 취급해 durable pending ID와 pass 실패 뒤 재삽입 경로를 연결하지 않았다. Broker remaining TTL이 증명하는 범위를 broker 체류 이후로 한정하지 않고 pre-broker delay까지 추정했다.
- **해결 및 예방책**: Trust 회복 전에는 recovered manual의 관측된 현재 출력을 manual 후보로 유지한다. Scheduler의 durable pending fixture snapshot을 queryable source로 두고, full/targeted pass마다 아직 관측되지 않은 ID를 회전된 capacity window로 다시 넣는다. Full error와 incomplete report도 capped backoff로 재예약하며 restart에서 source를 targeted worker에 seed한다. Untrusted Gateway는 legacy timed wire를 `legacy_timing_unverifiable` terminal로 거부하고 RF를 실행하지 않는다. 배포는 새 API publisher 가동, old publisher 종료, broker 최대 expiry 10초 drain, Gateway 순서로 고정한다.
- **반복 방지 체크**: 복구 테스트에는 active event/schedule RF 0회, 4,098개 terminal commit failure에서 첫 full pass 실패 후 두 번째 targeted batch의 overflow 관측과 fence 해제, 영구 offline fence 유지 및 다른 fixture의 starvation 방지, full `timedOut`/`failed` rerun, shutdown timer 취소, old API 1시간/30일 untrusted RF 0회, trusted legacy와 untrusted new-generation 성공 경로를 함께 넣는다.

## 2026-08-30 / 입력 dedupe도 상태 파일 소실을 첫 실행과 구분한다
- **발생했던 문제/실수**: 차량 event dedupe 파일이 처리 후 삭제돼도 다음 시작에서 빈 최초 상태로 해석하면 이미 적용한 vendor event가 다시 runtime에 들어갈 수 있었다.
- **원인**: 원자 rewrite와 정상 restart만 검증하고, 한 번 생성된 durable 파일의 소실을 first run과 구분하는 marker를 두지 않았다.
- **해결 및 예방책**: dedupe와 capability journal에 별도 manifest를 먼저 원자 저장한다. Manifest가 있는데 state가 없거나 둘의 구조가 손상되면 자동 초기화하지 않고 startup을 fail-closed한다. 새 event는 runtime durable commit, dedupe atomic commit, application ACK 순서로 처리하며 duplicate는 상태를 바꾸지 않고 ACK만 재전송한다.
- **반복 방지 체크**: durable input/outbox 파일에는 최초 실행, 정상 restart, target 삭제, manifest 삭제·손상, atomic write 실패와 process restart 테스트를 함께 둔다.

## 2026-08-30 / Exactly-once 입력 receipt는 도메인 상태와 같은 transaction에 둔다
- **발생했던 문제/실수**: 차량 runtime state와 별도 dedupe 파일 사이 crash에서 같은 이벤트가 재적용될 수 있었고, 마지막 boot만 보존해 `A -> B -> A` oscillation도 새 session으로 오인했다.
- **원인**: 중복 방지를 transport client 책임으로 분리하고 source session history를 current 한 건으로 축약했다.
- **해결 및 예방책**: normalized sensor identity를 automation state v5의 bounded inbox receipt로 옮겨 active/hold transition과 같은 durable mutation에 저장한다. Source별 current boot와 최근 8개 boot high-water를 보존해 관측한 이전 boot는 ACK만 한다.
- **반복 방지 체크**: definite failure, previous/next/unknown uncertainty, restart, boot oscillation, duplicate ACK와 active/hold 회귀를 함께 검증한다.

## 2026-08-30 / Bluetooth Company Identifier는 소유권 있는 배포 입력이다
- **발생했던 문제/실수**: ESP-IDF 예제의 Espressif Company Identifier를 제품 vendor opcode와 Health composition에 하드코딩했다.
- **원인**: 테스트 fixture와 제품 소유 assigned number를 같은 상수로 취급했다.
- **해결 및 예방책**: Gateway와 firmware가 명시적 배포/Kconfig 입력으로 동일 자사 할당값을 받고, 누락·미할당·타사 기존값·테스트 예약값을 fail-closed한다. 테스트 fixture는 test 전용 모듈에만 둔다.
- **반복 방지 체크**: production factory의 dependency injection 경로도 설정 검증을 우회하지 않는지와 Gateway/firmware 설정 키 계약을 shared 테스트로 유지한다.

## 2026-08-30 / 전체 상태 journal은 노드별이 아니라 operation batch로 갱신한다
- **발생했던 문제/실수**: capability startup refresh가 source마다 pending 추가, binding 기록, pending 완료를 각각 atomic rewrite해 N개 node에서 3N번 journal 전체를 다시 쓰고 O(N²) bytes를 만들었다. 최초 pending write가 실패하면 retry identity도 남지 않았다.
- **원인**: node 단위 API를 transaction 경계로 사용했고 durable enqueue 전에 controller가 작업 identity를 소유하지 않았다.
- **해결 및 예방책**: controller가 먼저 bounded volatile pending set에 batch identity를 보존한다. Journal은 `requestRefreshBatch` 한 commit과 `recordBindingsAndCompleteBatch` 한 commit만 수행하고 Config 실패 node는 pending에 남긴다. 두 commit 모두 exact previous/next/unknown read-back을 사용하며 volatile retry는 1초~30초 backoff와 shutdown drain에 포함한다.
- **반복 방지 체크**: 100/1,000 node에서 journal write count 상수, bytes 선형, 첫 enqueue ENOSPC 자동 회복, partial failure 뒤 later node 진행, restart, unchanged revision과 stale retry timer 중복 방지를 함께 검증한다.
