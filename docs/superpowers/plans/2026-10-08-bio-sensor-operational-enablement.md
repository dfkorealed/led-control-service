# BIO 센서 이벤트 실제 서비스 연동 실행 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 머지된 공통 센서 기능을 현재 테스트 현장의 정식 서비스 UI에서 사용하고, 감지·유지 연장·원래 밝기 복귀를 확인한다.

**Architecture:** 기존 프로파일·준비 작업·권한·펄스 실행 경로를 그대로 사용한다. 기존 증거 확인→배포 준비→승인된 현장 적용→정식 UI 확인 순서로 진행하며, 대상 환경·프로파일·장비 변경 승인 전에는 OFF를 유지한다. 추가 기능과 양산 전체 전환은 별도 설계·승인 범위다.

**Tech Stack:** React, NestJS/Prisma/PostgreSQL, MQTT, Raspberry Pi BIO Gateway.

## 10월14일 모든 조명 공통 준비 UI 보완

- [x] 사용자 `진행해줘`로 기존 공통 패널의 등록 연결 확인→센서 사용 설정 설계를 승인했다. 센서모드 전환의 자체점등 가능성을 설명했고 실제 이벤트 활성화/움직임 시험은 하지 않는다. 로컬API만 검증 후 정상 재기동하는 추가 승인도 받았다.
- [x] 별도 `codex/sensor-common-ui-20261014`에서 기존 등록 재확인 POST/GET/apply를 공통 컴포넌트로 연결한다. 현재 gateway.assignmentVersion만 기존 dashboard/조명 page 응답에 추가하며 버전이 없거나 권한/online/범위가 바뀌면 요청을 차단한다. 새API·공유MQTT·schema·권한 변경은 없다.
- [x] 버튼 부재·조회 버전 누락·지연 조회 완료 후 pending 잔류를 RED로 확인하고 GREEN으로 보완했다. 관련Web122/122, API36/36, 타입 포함Web빌드와APItypecheck, mock Chromium320/390/1024/1440px6/6이다. 조회정보/ID·기본밝기 보존·등록apply와 센서자격 분리, 중복POST/유실응답·권한회수·만료proof 차단을 확인했다. 전체suite/HIL 완료로 확대하지 않는다.
- [x] API빌드/typecheck exit0, 직접diff리뷰·메뉴문서·diff check를 확인했다. 현재API는 동일root/apps/api watcher3493(전날08:52시작)의 child19395이며 정상ready200이다. 새권한/schema/계약/DB강제변경 없이 기존 API를 소비하고 구형버전은 fail-closed한다. 사용자 단독진행 요청에 따라 독립에이전트리뷰는 하지 않았다.
- [x] `c20a6529`를 메인에 ff-only 반영하고 동일 API watcher3493의 새 child37376(17:32:10KST)을 확인했다. 메인 공통패널19/19도 다시 통과했다. 잘못된 테스트 경로로 no-test exit1 뒤 실제 경로 실행을 구분한다. 사용자AGENTS/landing dirty diff와 `.env`/AGENTS SHA를 보존했다.
- [ ] 현재 로그인 UI에서 온라인조명의 정상등록재확인·필요한센서사용설정을 수행하고 현재 sourceEligible와 자유로운 source/target 선택을 확인한다. 오프라인/미검증조명 강제허용·규칙활성화/움직임 START는 하지 않는다.
- 17:41–17:44KST 실제 적용 확인: API ready는 MQTT만down, UI는4대offline·기존규칙비활성이다. 현재Gateway sameimage/running/restart0·USB1/owner1·주소/TCP/transport/protocol/mapping true지만 MQTT/heartbeat false다. 브로커 CRL nextUpdate=2026-10-14 14:57:46KST 만료와 openssl client검증 `CRL has expired`를 확인했다. leaf 만료/issuer 누락은 아니다. 새공통 등록확인UI는 실제 표시되고 offline 요청을 차단한다. RFquery/SET/등록apply/규칙활성화0이다.
- 사용자가 `CRL도 갱신해줘`로 갱신을 승인했다. 동일 issuer 서명·Root CRL·폐기 serial 보존·정확한파일 백업→원자교체→동일broker SIGHUP만 준비한다. 기존Vault가33시간 전 exit255 상태이고 현재 issuer공개조회는 연결실패다. Vault1개 동일데이터/설정 기동·기존인증으로 MQTT CRL만 발행하는 추가확인을 요청했으며 아직 Vault/CRL/인증 변경0이다. CRL검증/연결복구 전에는 실제UI준비 완료로 표시하지 않는다.

## 10월14일 직접 UI 시험 준비 재개

- [x] 현재 로그인 UI의 비활성 규칙/준비 차단을 확인한다. 조명4대 오프라인, 기존 A→B100%/60초/적용됨이다. 서버 ready200/의존성5up, strict SSH 정상이다. Mac 주소는 전날과 다르고 Apple NTP 읽기 offset +0.007670±0.025955초로 현재 시간 동기화 변경은 불필요하다.
- [x] 현재 exact Gateway·USB owner·저장 주소와 서버 TCP 경계를 최소 읽기로 대조한다. 같은 이미지/running/restart0·USB1/owner1/현재 runtime 귀속·transport/protocol/mapping true다. 저장된 두 별칭·ExtraHosts는 이전 PC 주소이며 그 주소 TCP8883은 실패, 현재 주소 TCP8883은 성공이다. MQTT/heartbeat false로 UI 시험은 아직 불가다. 제품 쓰기·USB open·RF query0이며 이전 승인/원장을 재실행하지 않았다.
- [x] 오늘 새 승인 뒤 서버 별칭2개/ExtraHosts 주소만 교정했다. fresh3root 암호화 백업52항목/69,222,078bytes 전체 hash 검증·TERM1/create1/start1/hosts write1이다. 실제 중단은00:13:51→00:14:18UTC 약27초였다. 동일 이미지/launch/등록/매핑/state·이전 컨테이너/백업을 보존하고 fresh health/MQTT/heartbeat/transport/protocol/mapping true·singleUSB owner1/restart0을 확인했다. 브로커/API 재시작·SET·PKI/ACL 변경0이다.

현재 사용자가 새 승인 요청에 `승인, 주소 교정과 일시 중단 진행`으로 답했다. 오늘의 최대6~8분 중단·기존 두 서버 별칭의 현재 주소 교정만 승인됐으며 같은 이미지/등록/밝기/인증/센서 설정과 새 암호화 백업을 보존한다. 브로커/API 재시작·규칙 활성화/움직임 시험은 범위 밖이다. 어제의 승인/원장을 재사용하지 않고 `task-3-oct14-ui-*` 원장을 사용한다.
- [x] 정상 UI에서 새 A 준비 query1회/기존 요청 GET만 수행하고 현재 자격·활성화 차단을 확인했다. report/서버 모두unverified·BIO_PREPARATION_UNVERIFIED·fingerprint 없음·mode/link false·ACK applied다. clock stale로 거부된 것이 아니며 준비 완료로 승격하지 않는다.
- [x] 사용자는 특정A/B 변경 선택 대신 모든 조명을 UI에서 자유롭게 시험하도록 요청했다. 현재online 전체의 정상 준비 조건을 점검하며 실제online/호환/자격 관문은 유지한다. 오프라인조명은 전원/연결 복구가 필요하고 강제지원/규칙활성화는 하지 않는다.
- [x] 일반 이벤트 추가→모든조명 목록→준비 상태 보기로 현재online을 확인했다. B1-L006의 dashboard 재조회 후 준비query1개는 approved fingerprint 정확1개일치·needs_setup/BIO_SENSOR_MODE_REQUIRED·ACK applied다. B1-L002는 현재완료등록의 discovery 상태가discovered로 낮아져 binding_changed/후보false다. readonly9개 provision귀속관문은일치한다. B1-L006은provisioned/후보true이며 센서모드준비가 필요하다.
- [ ] 온라인조명 정상 등록연결 재확인과 센서사용모드 변경의 사용자 승인을 받는다. ID/기본밝기/인증은보존하나 센서모드로 바뀌면 자체점등이가능함을 설명했다. 공통준비패널에 기존 서버 검증/감사 API를 이용한 등록연결확인을 추가하는 bounded 설계를 제시했으며 제품코드는 승인 전 작성하지 않는다.
- [ ] 비활성 A→B100%/60초 규칙과 유지시간10초 변경 가능한 UI를 인계하고 결과를 메뉴/상태판에 기록한 뒤 작업 브랜치에서 메인으로 통합한다. 규칙 활성화·움직임 START는 실행하지 않는다.

## 10월13일 제품 이벤트 UI 진단 영역 정리

- [x] 긴 `BIO 운영 상태` 영역이 시험 전용이 아닌 제품 UI임을 확인하고 사용자 승인 범위를 정한다. 시험 전용 도구/기록은 보존한다.
- [x] 메인 개발 브랜치에서 격리한 `codex/event-user-status-cleanup`에서 공통 상태 배지를 구현하고 긴 진단 영역만 제거한다. 자격/활성화/장애 차단은 유지한다.
- [x] 짧은 상태와 기술 설명 제거를 RED→GREEN으로 확인한다. 관련 패널84/84와 타입 포함 빌드 exit0이다.
- [x] 모바일·PC mock Chromium8/8, 직접 diff 리뷰(자격/권한/명령 계약 무변경)와 메뉴 문서 갱신을 완료한다. 초기 새 PC 검사의 모바일 터치 정책 적용 실패는 보존하고 PC viewport/no-scroll과 기존 모바일 터치 검사를 구분했다. 독립 에이전트 리뷰는 사용자 단독 진행 요청에 따라 수행하지 않았다.
- [x] `ad1dcd5a`를 메인 개발 브랜치에 ff-only 병합하고 병합 후84/84·타입 포함 build exit0·현재 로그인 화면의 간결한 상태/긴 진단 제거를 확인했다. 규칙 비활성100%/60초/적용됨과 다른 작업의 미커밋 diff를 보존했다. 현재4대 오프라인·활성화 차단을 별도 후속으로 기록한다. API/장비 명령·실제 시험·시간 동기화는 하지 않았다. 시험 기록이 있는 재사용 작업 공간은 보존한다.

## 10월13일 직접 UI 시험 준비 후속

- [x] 기존 실제 Gateway를 새로 식별하고 서버 ready/SSH/runtime/현재 주소의 TCP8883을 최소 읽기로 대조한다. 17:34 KST 기존 주소는 실패(errno113), 현재 서버 주소는 성공하며 assignment 별칭/ExtraHosts가 현재 IP와 다르다. Gateway running/restart0·서버5서비스 up이다.
- [x] 현재 중단 승인을 받은 뒤 서버 별칭2개 주소만 교정하고 동일 이미지·등록·인증·state를 보존하여 Gateway를 재구성한다. fresh3root 백업52항목/67,249,820bytes 전체 hash 확인·TERM1/create1/start1·hosts write1, 기존 컨테이너/백업 유지다. 현재 singleUSB owner1·restart0·MQTT/heartbeat/transport/protocol/mapping true·UI4online이다. 신뢰/ACL 확장·새 이미지·DB/cache 강제 수복은0이다.
- [ ] 서버 PC의 시간 동기화 실행 범위를 추가 승인받는다. A query 보고가 수신보다2.015초 앞서1초 future gate에 걸렸으며, Pi NTP synchronized와 Mac Apple NTP offset +2.041126±0.004667초를 확인했다. 시간 허용 오차나 sourceEligible를 강제로 바꾸지 않는다.
- [ ] 정상 heartbeat/현재 catalog ACK/장비 준비 자격을 확인한다. 필요한 새 센서 준비는 정상 현장 관리자 UI를 사용하고, 중복 pending 요청 없이 결과를 확인한다.
- [ ] 기존 A→B100%/60초 비활성 규칙과 명시적 활성화 UI를 사용자에게 인계한다. 실제 활성화/움직임 시험은 자동으로 시작하지 않는다.

사용자가 후속 `진행해`로 이번 주소 교정·동일 이미지 Gateway 재구성·제어 중단을 승인했다. 새 snapshot과 단독 USB owner를 확인하고 현재 state를 fresh 암호화 백업한 뒤 교정한다. 기존 one-shot 원장은 덮거나 재실행하지 않고 별도 `ui-address` 원장을 사용한다. 이 후속은 다른 채팅 공유/위임 없이 직접 실행하며 과거 START를 재사용하지 않는다.

실제 후속: 주소 복구는 완료했다. 시작 직후 postflight의 빈 JSON 실패는 원장에 보존했고 독립 읽기는 정상이다. A의 정상 UI query1회는 mode/link true·ready 보고라도 서버가 future 시각으로 stale 거절했으므로 사용 가능/전체 시험 준비 완료로 승격하지 않는다. OS 시간 동기화는 별도 승인 전 실행하지 않으며 활성 규칙0·SET/움직임 시험0을 유지한다. 제품 소스 변경/전체 테스트/독립 리뷰는 이번 운영 작업에서 하지 않았다.

**Spec:** `../specs/2026-10-08-common-bio-sensor-configuration-design.md`의 승인된 공통 프로파일·준비·실행 설계와 `2026-10-08-bio-sensor-local-merge.md`의 남은 제품 과제를 구현·적용한다. 10월12일 현재 테스트 현장의 필요한 호환 버전 적용·장비 조회·프로파일 등록은 승인됐으며 정책/규칙 활성화와 새로운 현장 감지 시험은 별도다.

**상태:** 계획 초안 작성·사용자 검토 대기. 아래 작업은 미실행이다. 기준 main `208d6833`; 실제 실행 시 최신 HEAD/현장 상태를 다시 확인한다.

**10월12일 현재 상태 보충:** 아래 초기 승인/진단 기록과 구분해, 필요한 현장 호환 버전 적용·장비 조회·프로파일 등록은 후속 승인 범위다. normal ARM64 artifact 빌드/검증·원격 이미지 적재 및 독립 identity 확인은 통과했다. 실제 DB 복제본에서 기존 17개 테이블 보존과 BIO forward migration12개를 확인했다. 실제 DB/API/Gateway 교체는 아직 미실행이다. 준비 중 현재 main API가 재기동되고 최신 CAD 소스6개·의존성 변경이 확인돼 해당 사용자 작업을 보존한 격리 서버 배포본을 준비한다. 운영자는 정상 로그인으로 등록하며 비밀번호/세션을 추출하지 않는다. 현장 정책·이벤트 규칙 활성화와 새 감지 시험은 이번 완료 기준에 포함하지 않는다.

**후속 실제 상태:** 사용자 승인으로 총괄/Shell 두 채팅과 조율했다. 해당 작업의 동일 BIO migration12개 적용 후 actual DB를 다시 읽어 finished138·historical rolledback1·미완료/누락/checksum 차이0과 feature5개, catalog3·프로파일0·정책/규칙OFF·위험 pending0을 확인했다. 중복 migration은 폐기한다. main 최신 CAD·iconv와 후보의 기존 security dependency graph를 결합한 격리 API prepare/typecheck/build는 통과했으며, API runtime만 필요한 보안 보완을 반영하는 정확한 교체안을 검토 중이다. 총괄/Shell의 추가 API/DB 변경은 조율 전 보류하며 실제 Gateway 교체·장비 조회·프로파일 등록은 아직0이다.

**최신 적용 결과(10월12일 15:53 KST):** 총괄/Shell 모두 추가 API·DB 변경 없이 대기를 확인했다. 검토된 API runtime-only 교체1회는 exit0·ready200·의존 서비스5개 정상이다. 현재 main 소스951개와 최신 CAD 기능을 유지하며 격리 Prisma client·보완 dependency graph를 적용했다. 기존 ID/설정밝기와 17개 테이블의 행 수·비 telemetry 전체 설정 digest를 보존했고 DB migration·DB 쓰기 명령·강제 종료는0이다. Gateway snapshot/GET-only 조회/버전 교체는 exact once GO 후 진행 중이며, 완료·현재 readiness·프로파일 등록·catalog ACK는 아직 주장하지 않는다.

## Global Constraints

**최신 실행 체크리스트(10월12일, 아래 과거 시점 기록과 구분):**

- [x] 승인된 normal ARM64 Gateway와 현재 main 기능을 보존한 격리 API runtime 적용; authentic DB 적용을 재사용하고 중복 migration/강제 reset0.
- [x] 서로 다른 canonical/discovery ID 도메인을 각각 현재 DB·동일 물리 귀속에 결속하여 완전 fingerprint와 독립 GET3회를 확보; 동일 Gateway 재개, SET/밝기 쓰기0.
- [x] 재현 가능한 증거 digest·관측 범위·fail-closed 링크 정책을 strict schema로 검증하고 정상 operator UI에서 profile revision1 단1회 등록.
- [x] 후속 사용자 승인대로 API 카탈로그 WRITE/ACK READ 권한2개만 추가하고 exact broker SIGHUP1회; 원본 ACL/백업·브로커 lifetime 보존.
- [x] 새 current catalog4/profile1의 exact Gateway 적용 ACK와 Gateway 캐시 revision/hash/등록 계약 일치 확인. 최소 현재 readiness5항목·단일 USB owner1·기존 등록/설정밝기 보존·정책/규칙OFF·위험 pending0 확인.
- [x] 실제 완료 범위·관측 제한·남은 센서 준비/정책/규칙 활성화 경계를 문서화. GET은 force-off이며 센서 준비·실제 이벤트 활성화 완료가 아니다. 아래 Tasks3/4 전체 완료로 승격하지 않는다.

- 10월12일 사용자의 후속 `진행해줘 결국 완성이 되어야 해 어떻게든`은 직전 제안한 공통 센서 버전 반영과 장비 조회/프로파일 등록의 계속 진행을 승인한다. 검토된 현장 Gateway 교체·필요한 호환 서버 적용과 제어 일시 중단은 exact 보존/복구안을 총괄 검토 후 진행한다. profile/catalog 적용까지를 완료 기준으로 삼으며 정책/규칙 ON·sensor SET/밝기 쓰기·PKI/ACL 재설계·강제 DB reset·양산 release promotion·새 움직임 시험으로 자동 확대하지 않는다. 실패 관문을 우회하지 않고 원인별 최소 보완한다.

- 10월12일 연결 복구 후 사용자는 장비정보 조회와 호환 프로파일 등록을 추가 승인했다. 이 범위는 현재 장비의 완전 discovery·독립 mode GET·검증 근거에 맞는 프로파일의 정상 권한 API 등록·정확 catalog ACK 확인이다. 필요한 최소 확인만 수행한다. 새 배포/migration/PKI/ACL·센서 SET·밝기 쓰기·정책/규칙 ON·움직임 시험은 포함하지 않는다. 현재 active는 보호 기록의 새 exact Gateway이며 이전 canonical container를 재사용하지 않는다.

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

**현재 버전 반영 후속 — 사용자 계속 진행 승인:**

10월12일 진행 근거: Gateway fresh 타입/빌드 및 영향 계약35/35 통과, 이미지 frozen 설치의 누락 hook은 `440ead0c`의 최소 수정/표적 RED→GREEN으로 보완했다. 해당 clean commit의 normal LinuxARM64 이미지 빌드와 default bundle 검증은 exit0이다. 전체 저장소 production 보안 관문 통과를 의미하지 않으며 이번 Gateway 의존 graph의 gated 항목은0, 기존 mobile High2는 남는다. 현재 설치 교체는 아직 하지 않았다. 14:33:57 KST 기존 Gateway 연결·단일 USB owner와 mapping/assignment 보존을 확인했다. 실제 DB는 BIO migration12개 미적용·과거 floor migration1개 checksum 차이로 분리됐으며 이력 복원/호환성 확인 전에는 DB를 변경하지 않는다. 전역 이벤트 규칙0·기존 schedule1/manual66은 보존 대상이다. 운영자 정상 로그인과 기존 프로파일 UI를 사용하며 계정/인증 우회는 하지 않는다.

- [ ] 현재 후보 소스/실제 설치 및 API/Web 계약과 현장 pending/migration·단일 owner를 필요한 항목만 대조하고, 정확한 교체·보존/실패복구안을 제출한다.
- [ ] 해당 현장 artifact의 필요한 build/타입·센서 계약/기동 검증을 한 번 수행하고 교체한다. 실제 schema 변경이 필요하면 정확한 forward migration/백업 범위를 먼저 검토한다. 근거 없는 구 artifact 재사용/보안 예외·무승인 PKI 변경은 하지 않는다.
- [ ] 같은 서비스의 장비 조회와 독립 mode GET으로 완전 fingerprint·현행 링크 근거를 얻고, 제한된 재사용 근거를 갖춘 프로파일을 정상 공급자 API로 등록한다.
- [ ] 현재 catalog revision/hash와 exact Gateway ACK·기존 ID/밝기 보존·통신 상태를 확인하고, 실제 적용/남은 센서 준비·활성화 경계를 인계한다.

**최신 승인/진행:** 10월12일 기존 연결 복구 뒤 장비정보 조회와 호환 프로파일 등록만 추가 승인됐다. 아래 Task3의 전체 배포·활성화 및 Task4는 여전히 별도 범위다.

- [ ] 현재 배포된 조회/프로파일 계약·권한과 새 Gateway의 단일 USB 소유·귀속·안전 조건을 최소 읽기로 확인한다.
- [ ] 기존 단일 client 경로로 전체 fingerprint와 독립 링크 정책의 실제 근거를 확보한다. 유지보수 중단이 필요하면 exact 중단/재개안을 먼저 검토하며 모드/밝기를 변경하지 않는다.
- [ ] 기존 accepted pulse 근거와 현재 식별/링크를 묶어 재사용 범위를 제한한 schema-valid 프로파일을 정상 공급자 API로 한 번 등록하고 exact catalog ACK를 확인한다. 근거·현행 계약이 부족하면 해당 사유만 인계하고 추정값/직접 DB/우회로 완료하지 않는다.
- [x] 조회·등록 실제 결과와 미검증 경계를 상태판/계획에 반영한다. 전체 suite·감사·움직임 재시험은 반복하지 않는다. 설치 경로 확인에서 보류한 결과 인계만 완료이며 실제 조회/등록 완료가 아니다.

**10월12일 조회/등록 부분 결과:** 13:55:56 KST 새 exact active/image/running 및 실행 번들 hash 보존을 한정 확인했다. 첫 split-module 경로 가정은 installed artifact가 단일 번들이라는 로컬 근거로 교정했고 selector 회귀 RED1→GREEN0을 기록했다. 교정된 실제 번들은 discovery 이름 지표11/11, 공통 catalog/runtime/preparation/mode/adapter 지표0이다. 기존 격리 compiled artifact의 공통 지표7/7 및 다른 hash, image label에 대응하는 로컬 commit의 필수 source0/3은 필요한 설치 계약 불일치의 교차 근거다. 이름 지표/label은 실제 loaded 동작·인증된 build proof가 아니므로 의미적 부재를 절대 단정하지 않는다. 현재 필요한 공통 경로와 exact catalog 전달이 확립되지 않아 추가 권한/DB/RF 확인을 확장하지 않고 보류했다. full fingerprint/독립 링크 수치·reuse 근거·정상 operator 접근/최신 policy·rules·pending은 여전히 미완료이며 장비 query0/profile POST0/배포·중단·DB·모드·밝기 쓰기0이다. 다음은 공통 contract의 검토된 버전 적용/release 범위 승인 후 조회/등록을 이어가는 것이다. 상세 보호 결과는 `task-3-profile-report.md`, `task-3-profile.log`, `task-3-profile-proposal.md`에 유지한다. broader Task3/4와 기존 복원·보안/출력 예외 한계는 유지한다.

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

**최신10월13일14:01–14:09 KST — 연결/준비 확인 완료:** 사용자 명시대로 위임·다른 채팅 공유 없이 직접 수행했다. 동일440 image/설정/3root 상태·신뢰를 보존하고 기존 Pi hosts/ExtraHosts의 서버별칭2개 주소만 교정했다. TERM1/create1/start1·broker/API 재시작0, 원본 stopped와 fresh encrypted3root/off-Pi검증51항목을 보존한다. Docker 마운트 전체 필드 순서 독립 비교와 OomKillDisable null→false 기본값 표현만 허용했다. 실제5health/단독USB/assignment/mapping·등록/설정밝기 보존과 current catalog5 exact ACK, 정상 UI A ensure_sensor 새1개 ready·result/ACK 발행·current 사용 가능을 확인했다.

- [x] 승인된 서버 별칭2개 주소만 교정하고 같은 image/state의 Gateway를 최소 재구성한다.
- [x] fresh 상태의 암호화 전체 백업과 off-Pi 복호화/전체 payload hash 검증, 기존 원본·키·state 보존을 확인한다.
- [x] 현재 MQTT/heartbeat/BIO transport/protocol/mapping·단일 USB 소유·등록/설정밝기 보존을 최소 확인한다.
- [x] 정상 현장 관리자 UI 새 준비 요청1개의 실제 ready·결과/ACK와 current sourceEligible 사용 가능, current catalog exact ACK를 확인한다.
- [x] 승인된 A→B100%/60초 시험 규칙을 비활성 초안1개로 저장하고 exact membership·configuration APPLIED를 확인한다. 활성 규칙0이다.
- [x] 사용자 후속 승인: Web의 BIO 활성화 차단/고정 OFF, 활성 규칙 편집 시 비활성화, API 동기화 응답·필터·집계를 직접 수정했다. 현재 현장/Gateway/프로토콜과 모든 sourceEligible을 대조하고 명시적 활성화만 제공한다. 새 BIO는 비활성 초안, 기존 활성 상태는 유지한다. BIO APPLIED는 현재 양수 desired와 같은 V2 rule appliedRevision이 있어야 하며 V1 ACK/이전 revision/0은 PENDING이다. Gateway REJECTED는 센서 건강/실행 성공의 근거가 아니다.
- [x] 원래 증상 RED→GREEN, Web103/103·API4 suites71/71·mock Chromium7/7(320/390/1440px)·양쪽 타입/빌드·자체 diff 검토 및 메뉴/상태판을 갱신했다. 사용자의 단독 진행/최소 검증 지시에 따라 위임·외부 메시지·독립 리뷰·실제 DB 필터 통합·실장비 시험은 하지 않았다. 기존 Web chunk 경고는 미해소다.
- [x] 사용자 후속 승인으로 현재 메인 `codex/mvp1-cloud-web`에 `92d5b83d`만 cherry-pick(`e243110c`)하고 양쪽 문서를 보존했다. 메인 Web103/API71/mock Chromium7·양쪽 타입/빌드가 통과했다. 동일 watcher3493/상속 환경으로 API24883이 새로 기동하고 Web3528·ready200/5서비스 up·정상 기존 로그인 UI의 비활성100%/60초 규칙 `적용됨`을 확인했다. 규칙 활성화/새 움직임 START는 하지 않았다.
- [ ] 최신 actual heartbeatFresh=false·조명4대 오프라인이므로 현장 연결을 확인한 뒤 현재 sourceEligible 및 새 현장 START를 다시 확인한다. 등록/조명·노드 수·AGENTS/.env는 보존됐으나14:09 설정 보고 캐시 digest와 지금 값은 다르다. 마지막 보고는4개 모두 이번 통합 이전이고 직접 DB쓰기/장비 명령0이다. 최초 보존 검사 incomplete(exit2)와 현재 장비 GET/광학 밝기 미검증 한계를 보존하며 cache를 원복하거나 정상으로 합성하지 않는다.
- Ruling: 전체 센서 브랜치가 아니라 이번 수정 커밋만 통합한다. 메인은 최신 지도 작업209개 커밋이 진행돼 있고 이전 센서36개에는 별도 의존성/배포 변경이 포함돼 있기 때문이다. 이번 UI/API 수정만 승인한 사용자 범위를 보존하며, 제외한 과거 커밋은 원 브랜치와 보호 작업 공간에 남긴다.
- [ ] 아래 Task4의 fresh 현장 START 뒤 감지·연장·복귀/10초 변경을 필요한 최소 범위로 확인한다.

아래 오전/10월12일 기록은 당시 상태다.

**10월13일 주소 복구 승인 — 직접 진행:** 사용자가 exact 주소 교정 및 필요한 동일 image/state container 재구성을 승인했다. 다른 에이전트 위임/총괄 책임자 채팅 공유 없이 총괄이 직접 진행한다. 기존 자료·원본 컨테이너·상태 복구 근거를 보존하고 새 상태/대기 확인 뒤 주소 변경만 수행한다. broker/API 재시작·새 움직임 시험은 하지 않는다.

**10월13일 승인 후속 — 진행 중:** 사용자가 기존 API의 준비 command WRITE/result READ/result ACK WRITE3개와 재시작 없는 설정 반영을 승인했다. 현재 신원/ACL 최소 재확인→검토된 원본 보존 writer→SIGHUP1회→실제 반영 확인→정상 UI 새 준비 요청1회 순으로 진행한다. 어제 terminal 요청/준비 증거를 재사용하지 않는다. 규칙 ON/움직임 시험은 별도 현재 준비와 새 START를 기다린다.

**10월13일 실제09:05 KST — 실행 보류:** 현재 읽기에서 승인된3grant는 이미 API block에 존재하나 ACL inode/size/hash가 어제와 다르고 기존 broker stopped/이전 private API 부재·Gateway heartbeat 오래됨을 확인했다. config/공개인증서/principal/renderer는 보존됐다. 추가 write/SIGHUP/준비 요청0이며 현재 서비스 대상을 최소 읽기와 승인된 두 담당 채팅으로 조율한다. 이미 존재하는 권한을 중복 추가하거나 stopped broker를 reload 승인만으로 기동하지 않는다.

**현재 대상 정정:**09:08 조회의 실행 브로커0은 Docker 후보만의 결과다. Shell 담당과 현재 설정 담당 기록은 사용자 승인된 새 로컬 `pnpm dev`의 native Mosquitto/API/Web를 확인했다. Docker/privateAPI 부활 없이 현재 native broker와3grant/접속 주소를 좁게 대조한다. 실제 Gateway 준비·새 요청/START는 미실행이다.

**실제09:16 KST — 재읽기 완료:**3grant가 이미 있는 현재 native broker에 SIGHUP1회만 수행했다. 전후 process identity·ACL/config bytes/metadata·공개TLS hash와 내구 백업을 대조했다. 정상 Web proxy ready200/5개 up, ACL write/재시작/PKI/DB 변경0이다.09:15 SSH는 기존 exact440 Gateway running/재시작0을 확인했지만 환경변수 MQTT_URL은 effective 경로가 아니었다. 실제 assignment.mqttUrl와 현재 서버 주소를 추가 대조하며 준비 결과/ACK/sourceEligible와 새 요청/START는 미완료다.

**실제09:17 KST — 주소 교정 승인 대기:** 보완 읽기에서 assignment hash/hostname/mqtts8883은 보존됐고 Mac/Pi/container/ExtraHosts의 해당 별칭1개씩이 모두 현재 Mac LAN IP와 다름을 확인했다. 동일440 container running/재시작0·읽기만 수행했다. 현행 client TCP/auth는 미확인이며 정상 UI 준비 요청은0이다. hostname/신뢰/배정/ID/밝기/image/state를 유지하는 주소 교정과 필요 시 container 재구성·제어 중단의 새 정확 승인을 요청한다. 기존 broker 재읽기 승인만으로 Gateway를 재시작/교체하지 않는다.

**10월12일 후속 진행:** 사용자가 조회/프로파일/카탈로그 완료 안내 뒤 `진행해줘`로 정식 센서 설정·정책/규칙 활성화 후속을 요청했다. 실제 등록/전달 완료 증거는 위 최신 체크리스트를 따른다. operator 경계 확인 후 해당 현장 관리자 정상 로그인 완료를 받았고 테스트현장1 설정 UI를 확인했다. 사용자가 시험용60초 대응/담당자 비활성화·연결 점검과 A→B100%/유지60초 뒤10초 변경을 승인했다. 정상 UI 정책 ON 저장 성공을 확인했다. 최신 exact catalog ACK 뒤 A=B1-L001의 새 준비 작업을 실행한다. 규칙 ON·센서 SET·새 현장 시험 START는 아직 미실행이다.

**실제 후속:** catalog5의 승인 profile r1/현재 정책·담당자·60초·조치 및 exact 적용 ACK, strictready·기존 등록/설정밝기 보존·활성 규칙0·위험 pending0을 확인했다. 이후 정상 UI로 A의 ensure_sensor를 단1회 접수했다. 기존 요청 GET는 pending이라 실제 SET 여부/준비 완료는 미확인이다. 중복 요청 없이 해당 전달/결과 경계만 진단하고 규칙 ON/새 START는 하지 않는다.

**후속 진단/승인 대기:** 실제 단1회 준비 요청은 timed_out·발행 완료false/attempts40·결과/ACK없음이며 현재 catalog5/배정/canonical node/현장 담당자 귀속은 유효하다. 현재 준비/직접모드 pending0이다. 변경 후 exact hash의 mounted ACL source에 API 준비 command WRITE/result READ/result ACK WRITE3개가 모두 빠져 있다. 추가3권한+SIGHUP1회는 기존 카탈로그2권한 승인에 포함시키지 않고 사용자 추가 승인 후에만 수행한다. 실제 SET 성공/장비 결함을 단정하지 않는다. B의 보호된 실제 역할은 B1-L004로 결속했으며 새 시험은 미시작이다.

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
