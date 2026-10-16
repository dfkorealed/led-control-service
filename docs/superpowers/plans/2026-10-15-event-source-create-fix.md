# 이벤트 기준 조명 및 추가 실패 수리 Implementation Plan

> **For agentic workers:** 담당 역할을 나눠 직접 실행한다. 총괄은 조사 결과와 이 체크리스트/상태판을 통합하고, Web·Gateway 담당은 독립 소유 파일만 수정한다.

**Goal:** B1-L004 기준/B1-L006 실행 구성의 자격 차단 원인을 밝히고, 기준 외 센서의 이벤트 적용·유지 연장을 거부하는지 검증하며 추가 실패의 구체 안내와 기존 정상 복구 동선을 보완한다.
**Architecture:** 기존 source identity/준비·권한 검사를 유지한다. 등록 상태 미완료는 기존 장비 재확인→검증 결과 적용→BIO 분류·센서 준비 경로를 사용하며 임의 DB 상태 변경/재등록으로 대체하지 않는다.
**Tech Stack:** React/React Query, 기존 registration/automation HTTP 계약, Gateway Vitest product harness, 격리 Chromium fixture.
**Spec:** 사용자 2026-10-15 요청(기준 B1-L004/실행 B1-L006, 무관 감지 반응 및 일반 실패 안내), 기존 docs/menus/control.md·settings.md의 기준/등록 복구 계약.

## Global Constraints

- base c3f11789f6d4c6832aa28458f64a248e2b3fc034, branch codex/event-source-create-fix-20261015. MAIN의 사용자 AGENTS/상태판 dirty 및 다른 자기 감지 제어 브랜치는 보존한다.
- 공유 DTO/DB schema·migration/Gateway 제품 동작은 변경하지 않는다. 기존 RF/등록/프로필·기한·권한 검사를 완화하지 않는다.
- 운영 자료는 localhost READ ONLY의 해당 site/두 조명 범위만 조회한다. 실장비 RF 조회·설정·운영 데이터 적용·배포/재시작은 소프트웨어 보완과 구분하고 구체 승인 경계를 기록한다.
- 소프트웨어 fixture/최종 SET 의도는 실제 장비 광출력/HIL 증거가 아니다. 일반 온라인 표시를 센서 sourceEligible의 대체 증거로 사용하지 않는다.

## Review Focus

- 정상 등록된 무관 C 센서는 A→B의 시작뿐 아니라 유지시간 연장도 만들지 않는다.
- L004의 discovered/legacy protocol 상태를 주소/UUID 불일치나 센서 고장으로 오인하지 않는다.
- source candidate·준비 가능성과 sourceEligible를 구분하고 최종 준비 전 기준 선택/저장을 허용하지 않는다.
- prepare 실패와 rule POST 실패를 구분해 알려진 원인만 설명한다. 모르는 오류를 성공/설정 복구로 표시하지 않는다.
- 설정 이동/재조회 및 비동기 응답에서 site/principal 변경·중복 요청·실패 잠금을 유지한다.

### Task1: 실제 원인 조사

- [x] API/Web/Gateway source 및 현재 UI를 독립 읽기 조사한다.
- [x] localhost BEGIN READ ONLY로 L004/L006 등록 귀속·준비 상태와 현재 규칙/적용 snapshot 증거를 확인한다.
- [x] L004의 UUID/address/gateway/site/session/원 등록 command·ACK 귀속은 일치하나 Discovery.status=discovered, vehicleSensorProtocol=bluez_stateful임을 확인한다.
- [x] 현재 서버 규칙0/최근7일 이벤트 실행0, applied39와 정확 hash가 일치하는 V3 payload의 event0을 확인한다. Pi의 현재 메모리/디스크까지 확인한 것으로 확대하지 않는다.

### Task2: Web 추가 실패 안내 및 정상 복구 동선

- [x] Web 담당이 기존 설정의 등록 연결 확인/준비가 L004 형태에 도달 가능함을 확인하고 기존 설정 링크/카드 anchor만 연결한다.
- [x] 구체 오류·복구 동선의 실패 회귀(신규 9 FAIL)를 먼저 확인하고 기존 공통 UI/API로 최소 수리한다. 최종 covering 및 독립 검토는 다음 단계다.
- [x] 직접 관련 6파일167/167·자기 fixture Chromium PC/모바일2/2·Web typecheck/build/UI policy exit0, control/settings 메뉴를 갱신했다. 전체 Web/무관 audit는 실행하지 않았다. 원실패·정확명령은 `.local/event-source-create-fix-20261015/web/report.md`에 보존한다.

### Task3: 기준 외 센서 거부의 product 회귀

- [x] Gateway 담당이 기존 bio-sensor-common-path.integration.test.ts의 완전 fixture로 정상 C가 B SET/시작/A hold 연장을 만들지 않는지 검증한다.
- [x] A의 정상 적용·연장·원 기한 복귀를 함께 확인한다. 제품 RF 성공으로 기록하지 않는다. 최종 3/3·Gateway typecheck/diff exit0이며 독립 검토 I1의 C 권한 실제 null 단언 보완 후 재검토 ADDRESSED·새 C/I/M0·Ready YES다.

### Task4: 독립 검토·소프트웨어 통합 및 운영 복구 경계

- [x] 독립 담당이 소유 diff/회귀·원 증거·자격 우회 여부를 검토했다. Web/Gateway 모두 Ready YES·새 C/I/M0, Gateway I1은 실제 null 단언으로 해소했다.
- [x] 소유 16파일만 `3f62905b`로 커밋하고 `codex/mvp1-cloud-web`에 로컬 ff-only 병합했다. MAIN 기존 AGENTS/상태판 사용자 내용 SHA와 index empty를 검증해 보존했다. push/배포/서비스 재시작은 하지 않았다.
- [x] 실제 L004 복구의 query→receipt→apply→classification 및 필요 센서 준비 효과를 확인했다. 기존 ID/기본 밝기는 유지하며 센서 준비는 장비 모드를 설정할 수 있다. 운영 RF/등록 apply/SET은 미실행이다. 저장소 AGENTS.md의 운영 환경 변경 승인 관문에 따라 구체 승인 뒤 기존 정상 UI로 수행할 후속 단계로 남긴다. 소프트웨어 보완만으로 등록/장비 상태 복구를 주장하지 않는다.

## 현재 한계

장비 조회/등록 복구/센서 모드 SET은 아직 실행하지 않았다. L006 자체 sensor 동작·감지 범위 중첩·장비 내부 연동 또는 Pi의 현재 상태는 확인되지 않아 무관 감지 현상을 코드 필터 결함으로 확정하지 않는다. B를 임의 강제 OFF하거나 원 설정을 바꾸지 않는다.

## 최종 소프트웨어 결과

검증된 제품 Web13파일 및 Gateway 테스트1파일 SHA는 병합 후에도 동일하다. 직접 Web167·Gateway3·격리 Chromium2와 타입/build/UI 정책을 통과했고 양쪽 독립 검토 Ready YES다. 이 결과는 이벤트 추가 원인 안내·기존 정상 복구 접근 및 기준 필터 회귀에 대한 것이다. 실제 L004 등록 복구·센서 준비·이벤트 생성/활성화와 무관 센서에 대한 물리 현상 검증은 운영 승인 후속으로 남아 있다. 원 결과/검토/보존 병합 증거는 이 worktree와 MAIN `.local/event-source-create-fix-20261015`에 유지한다.

## 2026-10-16 전체 등록 조명 복구 및 공통 지원 후속

사용자가 실제 복구·센서 준비 진행을 승인했고 모든 조명에 적용 가능해야 함을 요구했다. 기존 전용 브랜치를 MAIN `70b76d93`까지 ff 동기화했다. 기존/신규 조명 모두 ID·이름으로 분기하지 않는 공통 경로를 확인하며 UI는 불필요하게 변경하지 않는다. 등록·센서 준비 모드 설정 승인은 받았지만 임의 규칙 활성화, 다른 담당자 작업 병합, 보안 관문 완화, 장비 재등록·직접 DB 수정은 포함하지 않는다.

- [x] 현재 등록된 전체6개 조명의 서버·등록·준비 상태와 활성 규칙/충돌을 읽기로 확인했다. 실제 복구·장비 준비 완료와는 구분한다.
- [x] 기존 전체 조명 공통 복구/준비 경로의 ID/이름/종류 비종속성을 확인하고, 확인된 Clock 한정 결함을 최소 수정·회귀했다. 실제 각 장비의 준비 성공은 아래 미완료 항목이다.
- [ ] 기존 UI로 등록 연결 재확인/검증 apply 및 준비를 대상별 순차 실행하고 실제 응답·잔여 차단 사유를 남긴다.
- [ ] 관련 검증·독립 검토·제어/설정 현황 및 상태판을 갱신하고 기존 사용자 변경을 보존해 로컬 병합한다.

시작 관측: 기존 설정 탭은 오래된 정보를 표시한 뒤 현재 서비스 연결 불가 화면으로 전환되었다. 이 시점에는 새 RF/등록 적용/준비 요청을 전송하지 않았다. 서비스 실행 상태와 실제 대상 상태를 먼저 확인한다.

10/16 중간 확인: Web 담당은 전체 dashboard 조명을 필터 없이 공통 목록/복구·준비 패널에 전달하며 ID/이름/종류/기존·신규 분기가 없음을 확인했다. 추가 UI 수리 근거가 없어 UI를 변경하지 않는다. 현재 API4000/Web5173 프로세스 부재, PostgreSQL5432 정상 리스너를 확인했다. 기존 최신 supervisor와 동일 SHA의 복사본을 MAIN `.local/event-source-create-fix-20261016-runtime`에서 시작했다. 기존 .env/인증/ACL 변경·migration0 조건을 유지하며 readiness 확인 전 장비 요청을 보내지 않는다.

### 10/16 공통 선행 결함의 한정 수리

- [x] API/Web/MQTT 재기동 뒤 readiness5개 모두 up, env·인증·ACL 정적 해시 불변을 확인했다. migration0이다. 전체6개를 실제 공통 설정 목록에서 선택해 현재 사유를 확인했다.
- [x] Gateway의 기존 MQTT/API hosts(.17)와 현재 Mac(.2) 불일치, 고정 USB001/004와 실제CH341001/005 불일치를 strict SSH 읽기로 확인했다. snapshot39의 활성 이벤트/스케줄0을 확인했다. 초기 lease 요약은 V10의 잘못된 키를 읽은 것으로 정정했고 실제 fixtureLeases/전환/결과 outbox/pendinghandoff는 복구 helper에서 다시 검사한다.
- [ ] Gateway 담당이 exact image/config/3개 영속root·인증을 보존하는 주소·USB 한정 복구 helper와 안전한 백업/기동 검증을 준비하고 독립 검토한다. 실제 시작은 resync RF GET을 수반하므로 RF0으로 기록하지 않는다.
- [x] API 담당이 Apple launcher의 보호된 runtime symlink를 무조건 거절하는 installer 검증의 정확 실패를 TDD로 수리하고 독립 검토했다. semantic RED1→관련65PASS·diff0, 독립 C/I/M0·Ready YES이며 소유2파일을 f14e5ece로 커밋했다. 일반 protected 경로의 symlink 거절은 그대로 두며 runtime 해석에서 원/대상·중간 경로의 root소유/쓰기권한/ACL/type/cycle를 모두 확인한다. 변경은 installer와 직접 테스트뿐이고 공통 wire/DB/UI 변경은 없다.
- [ ] 관리자 권한이 필요한 기존 ClockAttestor 복구와 정확 primary binding 차이는 별도 운영 선행 조건으로 기록한다. 루트 보호/계정/시각 관문을 우회하지 않는다. sudo 비대화형 인증은 불가(password required)였다.

정정: ClockAttestor는 미설치로 단정할 수 없다. root보호 설치 파일/receipt/plist가 이미 있으나 현재 Apple runtime symlink 검증에서 거절되며 launchd label·소켓은 없다. 기존 파일 해시는 기존 receipt와 맞고 sourceCommit88ed392d이며 MAIN과는 다르다. primary의 pidfile ready 공백과 DB 시작 epoch3초 차이는 관측만 했고 임의 보정하지 않는다. 복구/준비 요청 및 RF SET은 아직 실행하지 않았다.

추가 외부 상태 변화: 본 작업의 OS 쓰기는0이지만 ClockAttestor receipt가88ed392d→34a72c68로 바뀌고 label/소켓이 존재하는 것을 후속 읽기로 확인했다. 기존/현재 OS 설치는 원래부터 postmaster PIDfile·OS process birth·SQL start의 서로 다른 경계를 검사하지만 MAIN installer의 private primary 검사는 다르다. 이 작업은 해당 차이를 임의 정규화하거나 외부 설치를 덮어쓰지 않는다. 실제 producer healthy/approved는 아직 미확인이다. 다른 작업의 설치와 이 소유2파일의 소프트웨어 검증은 구분한다.

소유 Clock2파일 `f14e5ece`의 MAIN 로컬 ff-only 병합을 완료했다. 병합 전후 MAIN의 사용자 AGENTS/상태판 바이트 및 제품2파일 SHA 불변·index empty를 대조했다. 운영 helper/실제 조명 준비는 별도 계속 단계다.

### 10/16 외부 장비 작업 경합 확인 및 실행 경계

- 기존 Gateway 복구 helper는 구문·offline7/7을 통과했다. 읽기 plan2회는 exact 원본이 이미 stopped인 것을 발견해 runtime_identity에서 거절했다. 원격 파일 쓰기·배포 lock 취득·stop/create/start는0이다. 새 실행체에 자동 재바인딩하지 않는다.
- 추가 bounded Docker event/inspect는 외부 작업이 같은 b2b1/eebe6533 image와3개 영속root로 `task3-connection-4c6dfc5c-b351-4966-ba57-7fb11b6c5fca`를 만들었고 healthy임을 확인했다. 본 작업의 조명 복구 성공으로 기록하지 않는다.
- API maintenance/guard는 scratch 준비를 중단했다. maintenance 모드를 켜거나 추가 API 재시작·새 APIguard·DB/RF/등록apply/센서SET을 실행하지 않았다. 기존 normal supervisor98954는 본 작업이 시작했고 정적env/인증/ACL·migration0을 유지했다.
- 전체 조명에 적용되는 공통 UI 경로와 Clock 호환 소프트웨어는 확인했지만, 실제6대의 등록 복구·센서 준비와 물리 동작 검증은 미완료다. 다른 장비 작업과 충돌을 피하기 위해 사용자에게 ‘제어 페이지 담당자’·‘프로젝트 총괄 책임자’ 채팅으로 현재 상태·범위만 공유해 순서를 조율할 허가를 요청했다. 허가 전 다른 채팅에 메시지를 보내지 않는다.

10/16 조율 승인: 사용자가 두 채팅과 조율을 명시 승인했다. ‘제어 페이지 담당자’에는 현재 동일 Gateway의 장비 제어 창과 설정 보존 범위를, ‘프로젝트 총괄 책임자’에는 현재 normal 서비스 실행체와 시각 서비스/API 연결 소유 범위를 전달했다. 기존 등록6개의 UI 복구·준비는 각 소유자의 작업 창 확인 뒤 진행하며 외부 OS/장비 설정을 중복 변경하지 않는다. 다른 작업의 broader history나 credentials는 전송하지 않았다.

10/16 총괄 조율 응답: 시각·공휴일·MQTT 권한·정본 소켓 API 연결은 ‘프로젝트 총괄 책임자’가 계속 소유한다. 설치본34a72c68 유지·두 번째 표본 sample_unavailable로 승인 미완료, 현재 API normal/ready5up이며 공동 재시작은 사용자 승인 대기임을 확인했다. 본 작업은 전체6개 등록 복구·준비를 담당하되 운영 변경 창과 겹치지 않게 한다. 사용자에게 기존 DB/환경/인증서를 유지하는 API·Web·MQTT 일시 중단/분리 기동과 시각 표본 승인 절차 진행 여부를 구체적으로 요청했다. 관리자 인증은 사용자가 직접 수행하며 Root는 비밀번호를 받지 않는다. 이 선행 단계 전 실제6개 준비 완료를 주장하지 않는다.

10/16 후속 승인: 사용자가 시각 표본 승인 절차와 동일 DB/환경/인증서를 유지하는 API·Web·MQTT 일시 중단/분리 기동을 명시 승인했다. 총괄 담당자에게 이 정확 범위를 전달했고, 본 작업은 운영 전환 완료와 장비 단독 창을 기다린다. 추가 PKI/권한 확대 승인을 전가하지 않았으며 조명 SET/등록apply는 아직0이다.
