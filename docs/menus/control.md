# 제어 메뉴 기능 현황

## 2026-09-27 종료 명령 상세 정리 helper

- 구현 완료: 종료 outcome과 terminal dispatch/result, hold 없음, 종료 override, settled outbox를 확인한 뒤 원본과 파생 상세를 같은 거래에서 제거하는 내부 helper 및 DB tombstone 제약을 추가했다. Command/dispatch/수동 parent ID·FK·alias는 보존하며 exact 수동 replay는 keyed 증명으로 검증해 DB 상세/ACK hash 재생성 없이 응답한다. 실패하면 전체 거래를 rollback한다.
- 미구현: 기본 OFF의 bounded worker 연결과 운영 중앙 DB migration/활성화. 물리 Command purge, 보호 cutover, 복구 POST와 새 자동 Set/Get은 이번 변경으로 켜지지 않는다.
- 부족하거나 개선이 필요한 기능: 연결할 수 없는 과거 ACK hash·고아 수동 실행·미완료 재위촉·증명/키 부족은 이유와 함께 보류된다. 일회성 ACK 발행 실패는 Gateway의 기존 보고 재전송에 의존하며 실제 broker/Gateway/RF HIL은 별도다.
- 관련 파일: `apps/api/src/retention/command-detail-redaction.ts`, `apps/api/src/automation/redacted-manual-execution-replay.ts`, `apps/api/src/mqtt/mqtt.service.ts`, `apps/api/prisma/migrations/20260927160000_command_derived_content_redaction/migration.sql`.
- 갱신 규칙: software DB/transport 회귀와 실제 운영·하드웨어 검증을 구분하고, 사본 검증 실패를 정리 성공으로 기록하지 않는다.

## 2026-09-27 발행 세대와 보관 worker 안전 통합

- 구현 완료: 일회용 PostgreSQL의 제한 worker는 전체 member ACK, 시도별 absolute expiry, 같은 primary의 내구적 시각 연속성, 전체 broker/Gateway 증명과 독립 단조 대기를 통과해야 서명된 정확 cutoff로 원본을 삭제한다. 증명 누락·위조·다른 boot/세대는 삭제 0이다. Set quiesce와 독립인 원본 없는 Get publisher를 등록하고 MQTT 종료 전에 해당 Get도 drain한다.
- 미구현: 운영 물리 purge와 recovery POST 활성화, 운영 DB-host attestor, 되돌릴 수 없는 broker admission/인증서 원장, 전체 현장 Gateway census 및 Raspberry Pi/BlueZ/BIO 물리 RF HIL 인증.
- 부족하거나 개선이 필요한 기능: 소프트웨어 queue/submitted/unconfirmed 0과 재시작만으로 RF 완료를 인정하지 않는다. Gateway 버전 문자열 일치만으로도 허용하지 않으며 독립 release 인증의 clock proof·매 submit 만료 재검사·보수적 RF 계수 capability와 별도 물리 HIL이 모두 필요하다. 기본 인증 목록과 운영 adapter는 없다. broker digest에 worker identity→인증서 소유 증명이 없어 member ACK 하나라도 없으면 backlog로 남긴다. CLI는 별도 장벽 입력이 없는 경우 삭제 0이며 운영 스케줄러가 아니다. 제한 worker의 SQL 직접 호출도 정확한 hold 대상·밝기·Gateway와 late Set wire HMAC을 재검증하며 TS 사전 검사만으로 삭제를 허용하지 않는다.
- 관련 파일: `apps/api/src/commands/command-purge-barrier.service.ts`, `command-retention-worker.ts`, `apps/api/src/mqtt/gateway-command-drain.service.ts`, `recovery-outbox-publisher.service.ts`, `apps/api/prisma/cutovers/command-retention-protected-delete.sql`.
- 갱신 규칙: 운영 gate는 disposable 테스트와 별도로 기록하고 실제 broker/clock/HIL 증거 없이 완료 또는 purge ON으로 바꾸지 않는다. 기존 unknown/partial hold·늦은 ACK·Get 전용 복구와 자동 Set 재시도 금지 경계를 유지한다.

기준일: 2026-09-24

## 구현 완료

- 2026-09-27 상세 내용 제거 상태(Task 2): `Command.contentRedactedAt`이 있는 행은 플래그 상태와 무관하게 일반 목록에서 제외하며, 인가된 상세와 기존 상태 확인은 내용 없는 `410 command_expired`를 반환한다. 동일 키 재제어와 사용자 삭제로 요청자를 알 수 없는 현장 내 기존 키 재사용은 `409 command_request_expired`로 차단하며 Set/Get/outbox를 생성하지 않는다. 기존 상태 확인의 기간 제한도 `COMMAND_HISTORY_RETENTION_ENABLED=1`에서 중앙 DB UTC transaction 시각의 3 calendar months를 사용하고 정확 경계는 유지한다. 생성 응답은 내부 요청자·요청 키·fingerprint를 숨기며, 늦은 ACK는 제거한 상세를 복원하지 않는다. 일회용 PostgreSQL과 API 소프트웨어 검증 범위이며 비식별 worker와 운영 migration은 아직 활성화하지 않았다.

- 2026-09-25 Final Atlas 자동화 목록 API(Task 7): 스케줄·차량 이벤트의 현장 전체 목록에서 이름의 trim된 리터럴 부분 검색(한글·`%`·`_` 포함), 활성 상태, Gateway 구성 동기화 상태 필터와 `limit=1..100`을 지원한다. 기존 `items,total,nextCursor`와 무필터 v1 cursor는 유지하고, 조건에 맞는 전체 `filteredTotal` 및 필터 없는 현장 전체 규칙 수·상태별 규칙 수 `siteSummary`를 같은 RepeatableRead 조회에서 반환한다. 설정이 없는 Gateway의 규칙은 `PENDING`이며 수치를 Gateway 대수나 현재 로드된 페이지 수로 해석하지 않는다. 필터 cursor v2는 인증 사용자·현장·규칙 종류·정규화된 조건에 묶고, 현장 `read` 권한을 cursor 해석 전에 확인한다. 집중 단위·일회용 PostgreSQL E2E 검증 범위이며 실제 현장 규모의 브라우저 조작과 장비 HIL 증거는 아니다.
- 2026-09-27 Gateway 중앙 Set 물리 전송 경계(Task 6): 명령별 cached permit을 실제 BlueZ D-Bus `Send`와 BIO native write 직전에 동기 재검사한다. 주소/queue/D-Bus interface 조회 지연 및 BIO brightness→force-on 사이의 proof 손실은 후속 Set을 차단한다. 현재 프로세스에서 write 0이 확인된 경우만 내구적 refusal/수동 pending abort로 끝내며, 첫 전송 이후 veto·USB/D-Bus 오류는 unknown/partial을 보존한다. 기존 로컬 일정·센서 자동화 및 Get(이미 보낸 Set의 read-back 포함)은 DB proof veto 대상이 아니다. scoped nonce/epoch drain 요청은 boot ID·Gateway 버전과 queued/submitted/unconfirmed 수를 응답하지만 제출 콜백·관측 성공을 물리 RF 종료로 인증하지 않는다.
- 2026-09-26 Final Atlas 수동 이력 시각 보완: 지도·밝기 실행 아래 최근 이력을 PC에서는 한 줄, 390/320px 모바일에서는 읽을 수 있는 두 줄의 compact bar로 표시한다. 최근 명령의 현장 시각·조명 수·밝기·상태를 요약하고, 요약을 누르면 기존 명령 상세로 진입한다. 전체 3개월 이력·검색·필터·보관 시작 시각은 기존 drawer에 유지하며 확인 필요 명령 진입과 안전 잠금은 변경하지 않았다. Mock API 기반 Vitest 및 Chromium 1440/390/320px 검증이며 실제 Gateway/조명 HIL은 별도다.
- 2026-09-25 Final Atlas 명령 이력·확인 필요 case Web UI(Task 3): 수동 화면의 최근 명령 1건은 무필터 `limit=1`로 조회하고, 일반 이력은 공통 오른쪽 drawer에서 검색·상태 필터와 서버 opaque cursor 4건 단위 이전/다음으로 탐색한다. `GET /commands`가 돌려준 UTC `retainedFrom`만 현장 시간대로 표시하며 클라이언트가 3개월 하한이나 가상 전체 페이지 수를 계산하지 않는다. 메타데이터가 없으면 기간 확인 불가로 표시하고 `command_history_cursor_expired`(400)는 첫 페이지를 재조회한다. 오래된 cursor 응답은 사용자·현장·필터 세대가 바뀐 뒤 페이지를 넘기지 못하며 끝 페이지의 키보드 초점은 사용 가능한 이전/다음으로 이동한다. 일반 이력과 별도로 `requiring-verification` 목록/상세를 Site `read`로 열고, Site `control`의 전용 Get-only 상태 확인과 Site `manage`의 명시적 위험 승인(기본 미체크·확인 방법·500자 이내 사유)을 분리했다. 상태 확인 HTTP 응답 유실의 `clientRequestId`는 사용자·현장·case 범위로 세션 보존해 새로고침 뒤에도 동일 키만 재시도한다. 목록/상세/drawer/승인 폼 열기와 승인 자체는 기존 dimming Set을 보내지 않는다. 원본 상세 404/410과 안전 관련 409/410은 잠금을 유지하며 일반 충돌의 새 제어 요청 문구를 표시하지 않는다. 명시적인 안전 거절은 응답 유실과 구분해 같은 dimming 요청의 재전송을 새로고침 뒤에도 금지한다. 정확히 연결된 case의 권한 있는 위험 승인 성공만으로는 잠금을 풀지 않고, 그 사실을 세션에 보존한 뒤 서버의 원본 ID exact-filter 새 조회가 비어 있음을 확인할 때 거절된 로컬 요청만 해제한다. 조회가 지연·실패하거나 case가 남으면 잠금을 유지한다. 새 제어에는 사용자의 재적용과 새 요청 ID가 필요하다. 이미 관측된 원본 명령 case도 권한 있는 원본 ID exact-filter 재조회에서 사라진 경우에만 해당 브라우저의 case 잠금 표시를 해제한다. 처음부터 빈 case 목록·상세 404·조회 실패만으로는 해제하지 않는다. 동일 현장에서 배경 재조회가 401/403이면 캐시된 이력/case/승인 동작을 숨긴다. 해소된 case는 사용자·현장 범위의 최근 case ID로 다시 조회해 서버의 최소 결과(`적용됨`/`미적용`/`일부 적용`, 대상 수, 확인 시각)만 보여주며, case 부재를 적용 성공으로 추정하거나 미적용·일부 적용을 자동 재전송하지 않는다. Web mock Vitest·Chromium software 검증 범위이며 실제 Gateway/조명 동작 증거는 아니다.
- 2026-09-25 게이트웨이 재위촉 차단 응답: 새 수동 Set이 HTTP 409 `gateway_recommission_in_progress`로 거절되면 서버가 기존 요청 ID 조회를 먼저 수행하고 새 Command를 생성하지 않았으므로, UI는 저장된 미전송 요청을 정리하고 별도 재위촉 안내를 표시한다. 같은 ID의 “동일 요청 확인” 버튼이나 미확정 명령 잠금을 남기지 않는다. 재위촉 완료 뒤 다시 제어하려면 사용자가 적용을 명시적으로 눌러 새 요청 ID를 발급해야 한다. 이 예외는 dimming POST에만 적용하며 알 수 없는 409·확인 필요 case의 안전 잠금은 유지한다. Web 단위 회귀 검증 범위이고 실제 재위촉 Gateway/조명 HIL은 별도다.
- 2026-09-25 Final Atlas 수동 제어 Task 1–2: 지도 툴바에 기존 구역 관리/조회 진입점을 한 번만 배치하고, 개별·층·구역 선택과 지도 이동·영역 선택, 조명 목록의 검색·상태/층 필터·100건씩 더 보기·제어 불가 사유를 유지한다. 조명 목록은 공통 오른쪽 drawer(최대 440px, 모바일 전체 폭)로 열고 닫기/완료 뒤 목록 opener로 포커스를 돌린다. 수동 화면에서만 지도 안의 중복 선택 요약을 숨기고, 실행 패널에 선택 수량 한 곳과 별도 차단 경고를 배치했다. PC는 지도와 약 350px 실행 패널, 모바일은 지도→실행→이력의 자연스러운 읽기 순서이며 `01/02` 중복 제목과 고정 하단 실행 시트를 제거했다. 명령 생성·멱등 ID·잠금·상태 조회·응답 불명/일부 적용/재확인 handler와 조명 1,000개·단일 Gateway 제한은 변경하지 않았다. focused Vitest는 통과했으며 실제 반응형 브라우저·Gateway HIL은 통합 검증이 남아 있다.
- 2026-09-25 Final Atlas 자동화 목록 UI: 스케줄·차량 이벤트 양쪽에서 공통 이름 검색(리터럴 부분 일치), 활성/Gateway 동기화 상태 필터, 10·20·50·100건 페이지 크기와 서버 cursor 이전/다음 이동을 제공한다. 조건·사용자·현장 전환 시 첫 페이지로 돌아가며, `filteredTotal`은 조건 전체 결과 수, `siteSummary.ruleCount`와 `syncRuleCounts`는 필터 없는 현장 전체 규칙·Gateway 상태별 규칙 수로 구분한다. 3초 갱신은 현재 보이는 cursor 페이지 하나만 조회하고 A→B→A 범위 전환에서 오래된 응답을 버린다. 구 API 응답에 새 필드가 없으면 전체 Gateway 수를 추정하지 않고 로드된 행 기준으로 명시한다. 기존 추가·수정·삭제·활성 전환과 권한·인증 차단은 유지하며, Chromium mock은 실제 Gateway/조명 HIL 증거가 아니다.
- 2026-09-24 제어 세션 상태는 사용자·현장 범위의 공통 상태 센터에 모인다. 스케줄·차량 이벤트 목록의 기존 페이지를 유지한 백그라운드 재조회 실패와 다음 페이지 실패는 본문을 막지 않는 별도 항목으로 표시하고, 각각 `상태 다시 조회`와 `다음 페이지 다시 시도`를 제공한다. 다음 페이지가 성공해도 이전 페이지의 재조회 실패는 실제 재조회 성공 전까지 남으며, 실패한 cursor가 갱신으로 사라지면 동작할 수 없는 재시도 항목도 해제한다. `마지막 성공`은 현재 사용자·현장 범위에서 실제 최초/전체 목록 조회가 성공한 시각을 현장 시간대로 표시한다. 다음 페이지 성공이나 수동 캐시 쓰기로 갱신하지 않으며, 사용자·현장 전환 또는 401 차단 뒤에는 새 전체 목록 조회가 성공하기 전까지 이전 시각을 표시하지 않는다.
- 활성화/비활성화 실패는 규칙별 독립 항목으로 이름과 함께 표시한다. 새 규칙 추가·다른 규칙 편집을 열거나 다른 규칙의 저장·토글·삭제가 성공해도 기존 실패는 남는다. 해당 규칙의 토글 또는 삭제가 현재 사용자·현장 범위에서 성공했을 때만 그 규칙의 실패를 해제하며, 삭제 실패 중에는 유지한다. 사용자·현장 범위 종료·401 차단에서도 해제한다. 같은 규칙의 같은 실패 toast는 재시도 중에도 반복 발행하지 않으며, 서로 다른 규칙의 같은 오류는 각각 유지한다. 성공은 짧은 toast로 알리고, 추가/수정·삭제 오류는 해당 dialog 문맥에 남긴다. viewer는 읽기 전용의 중립 badge만 보고 관리 동작은 사용할 수 없다. 최초 목록 조회 실패·인증 차단은 기존 본문 복구 표시를 유지하며, 캐시 목록에서 401이 나면 행과 열린 편집·삭제 dialog도 닫아 조작을 차단한다.
- 수동 명령의 전송·진행·상태 조회 실패, 응답 ID 불일치, `unknown`, 일부 적용 등 확인이 필요한 결과도 같은 상태 센터에 표시한다. 센터의 동작은 수동 제어 탭으로만 안전하게 돌아가며 명령 전송, 상태 확인 또는 재적용을 대신 실행하지 않는다. 실제 조회 재시도, 조명별 결과 확인 및 미적용 확인 후 재적용은 실행 패널의 `최근 결과`에서 수행한다. 현장·사용자 전환 뒤 이전 요청의 상태와 늦은 응답·toast는 새 범위에 넘어가지 않는다. 이 연계는 focused Vitest 소프트웨어 검증 범위이며 브라우저 E2E나 실제 Gateway/조명 HIL 통과로 간주하지 않는다.

- 2026-09-24 당시 수동 제어 화면은 `01 / 제어 대상 → 02 / 밝기 실행 → 03 / 최근 결과` 순서와 compact 고정 시트를 사용했다. 이 배치는 위 2026-09-25 Atlas 작업에서 지도→실행의 자연 흐름과 제목 없는 단일 실행 패널로 대체했다. 기술 전송 방식은 사용자 선택이나 실행 조건이 아니므로 고객 화면의 전면 문구에서 제거했고, 실제 명령의 전송 방식 결정과 기존 명령 잠금·멱등 요청·ACK·`unknown`·`verified_not_applied` 후속 조치 계약은 유지한다. 차량 이벤트 추가·수정도 `01 감지 센서 → 02 실행 조명 → 03 동작 설정`과 실행 요약으로 선택 순서를 명확히 하되 verified capability·동일 Gateway·감지 센서 변경 시 실행 대상 해제와 기존 payload를 유지한다. 760px 이하 스케줄·이벤트 규칙 목록은 가로 스크롤 표 대신 공통 카드로 표시한다. 스케줄 카드는 이름·활성·적용 기간·다음 실행·반복/시간·밝기·대상 수·Gateway 동기화·최근 결과를, 이벤트 카드는 이름·활성·감지 센서/제어 조명 수·밝기·유지 시간·Gateway 동기화·최근 감지를 표시하며 관리 권한의 기존 동작 버튼을 유지한다. PC는 기존 표, viewer는 읽기 전용을 유지한다. 당시 변경은 focused Vitest 범위였으며 390/320px 카드 조작·overflow와 PC 표를 확인하는 브라우저 E2E assertion은 작성만 하고 공유 checkout에서 실행하지 않았다. 실제 모바일 WebView·Gateway/조명 HIL 증거도 아니다.

- 2026-09-24 스케줄 추가·수정의 적용 시작일·종료일을 접힌 세부 설정에서 기본 `언제 켤까요?` 영역으로 옮겨, 반복 프리셋과 기간을 함께 확인할 수 있다. 새 스케줄은 기존처럼 현장 시간대의 오늘이 시작일과 종료일이며, 같은 날짜일 때 `오늘만 적용` 또는 선택한 날짜의 하루만 적용된다는 안내와 요약을 표시한다. 여러 날짜를 지정하면 요약에 양끝 날짜를 표시하고 종료일 이후에는 반복되지 않음을 안내한다. 날짜 검증·현장 시간대 ISO 변환·fixture snapshot·Gateway sync와 서버 payload는 바꾸지 않았다. focused Vitest 검증 범위이며 브라우저/실장비 HIL 검증은 총괄 통합 게이트와 별도 장비 절차를 기다린다.

- 2026-09-15 BIO 센서 shadow 캡처와 오프라인 분석은 opt-in 소프트웨어 경로로 구현했다. 기존 Gateway USB 소유자에서 허용된 비동기 패킷만 JSONL evidence로 기록하고 분석 결과도 production 활성화를 허용하지 않는다. 물리 센서 10회 HIL과 이벤트 제어 검증은 아직 실행하지 않았다. 운영 순서는 [BIO 센서 shadow 캡처 runbook](../runbooks/raspberry-pi-gateway-appliance.md#bio-센서-shadow-캡처)을 따른다.

- 2026-09-21 제어 대상 지도는 모니터링과 같은 공통 `FloorMapViewport`의 coalesced pointer camera를 사용한다. 핀치 중 React parent를 매 프레임 갱신하지 않으며 종료 시 한 번만 zoom을 동기화한다. 실제 모바일 WebView 성능 계측은 보류다.
- 제어 대상 CAD 지도도 새 raster가 준비되기 전 마지막 완성 raster를 유지하므로, 느린 타일 decode 또는 취소로 선택 대상 지도가 빈 상태가 되지 않는다.
- 2026-09-19 공통 맵 표면은 설정에서 적용한 네이티브 CAD를 읽기 전용 Pixi 타일로 합성하고 수동 도형·조명 선택 오버레이와 카메라를 동기화한다. 최대 32,768 논리 맵에서도 전체 논리 크기의 canvas를 할당하지 않는다. 기존 제어 권한, 대상 선택 및 MQTT/장비 명령 계약은 변경하지 않았으며 이번 CAD 검증은 실장비 제어 HIL을 대신하지 않는다.
- 2026-09-18 모니터링의 수동 읽기 전용 확인에서 fresh Gateway의 두 번 연속 검증된 조명 실패가 수신되면 `Fixture.lastUnreachableAt`과 운영 `offline/fixture_stale`을 저장해 기본 20분 stale 대기 없이 제어를 차단한다. Gateway/MQTT 자체 실패는 개별 조명의 unreachable 증거로 쓰지 않는다. 확인 작업은 밝기 제어 Command/이력을 만들거나 밝기·전원·BIO mode를 바꾸지 않는다.
- 2026-09-27 제어 API 읽기 계약: `GET /commands/requiring-verification`와 `GET /commands/requiring-verification/:caseId`는 현장 read 권한으로 확인 필요 case의 최소 정보만 제공한다. 목록 cursor는 사용자·현장·원본 명령 필터에 묶이고, 상세의 대상 ID는 권한 확인 후에만 제공한다. 원본 명령이 없고 접근 가능한 미해결 hold가 있으면 내용 없는 410, 외부 현장·없는 원본은 같은 404다. 이는 임시 PostgreSQL·단위 테스트의 소프트웨어 검증이며 case 상태 확인/위험 승인 POST를 등록하거나 Gateway Get/Set을 발행하지 않는다. 일반 명령 이력의 UTC 3 calendar months 조회 제한은 `COMMAND_HISTORY_RETENTION_ENABLED=1`만으로 동작하되 기본 OFF이고 운영 Compose preflight는 DB readiness 증거 연결 전 ON을 거부한다. 운영 purge·복구 POST·실장비 HIL은 미완료다.
- 일반 명령 이력 GET은 현장 read 인가 후 같은 짧은 DB 트랜잭션의 `transaction_timestamp() AT TIME ZONE 'UTC'`와 UTC 3 calendar months cutoff를 목록/상세·cursor 400·`generatedAt`/`retainedFrom`에 공통 사용한다. 정확한 cutoff는 포함하고 이전 행만 숨긴다. 오래된 기존 `clientRequestId`의 Set 재시도도 같은 DB cutoff로 내용 없는 409를 반환하며 새 Set/outbox를 만들지 않는다. 미해결 원본 한 건 때문에 현장 전체가 legacy 목록으로 되돌아가지 않는다. 별도 읽기 전용 preflight가 cutoff 이전의 hold 없는 pending/unknown을 검사하고, 양수·DB 오류면 활성화를 거부한다. 플래그 OFF에서는 기존 조회와 추가 DB-clock 질의 0건을 유지한다. 일회용 PostgreSQL에서 host ±60초 및 UTC·Seoul·New York 세션을 검증했으나 운영 Compose의 flag는 기본 OFF/활성화 거부이며 운영 DB, 원본 삭제, 복구 POST, Gateway HIL은 적용하지 않았다.
- 2026-09-27 제어 명령 API 캐시 보완: 인증된 일반 명령 이력·상세와 확인 필요 case 목록·상세의 GET HTTP 응답에 `Cache-Control: private, no-store`를 지정한다. 이력 만료 410도 같은 헤더를 반환한다. 실제 Nest HTTP 회귀 테스트로 확인했으며 서버 권한, 복구 POST 미등록 및 보관 기능 OFF 상태는 바꾸지 않았다.
- 수동 unreachable보다 더 최신의 수락 presence/state가 도착하면 `lastUnreachableAt`을 해제하고 freshness 차단을 복구한다. 늦은 이전 실패는 더 최신 성공 관측을 덮지 않는다. 생존 presence만으로 실제 Health fault·`command_failed`·등록 대기를 지우지 않으며 BIO sensor 설정 밝기를 실제 출력으로 추정하지 않는다.
- BlueZ D-Bus Send timeout은 Gateway 전송 실패이므로 조명 unreachable이나 제어 차단을 만들지 않는다. 요청 보존기간 뒤 요청/batch 모두 삭제된 correlated 결과는 상태 변경 없이 폐기 ACK만 반환하며, 오래된 재전송으로 밝기·전원·에너지나 제어 가능성을 바꾸지 않는다. 이후 정상 비연관 presence/state는 기존 수집·복구 규칙을 따른다.

- 2026-09-17 최종 지도 선택 보완: 스케줄·이벤트의 지도 단계와 구역 편집은 명시적인 반응형 너비와 제한된 높이를 공유하며, 데스크톱 지도 행이 남은 높이를 사용한다. 스케줄·이벤트는 빈 선택·잘못된 선택에서도 `설정으로 돌아가기`로 초안을 보존하고 원래 선택 버튼에 포커스를 돌려준다. 대시보드 갱신으로 없어진 직접 선택은 `선택 비우기`로 복구할 수 있다. 스케줄은 최종 저장에서도 최신 직접 fixture 스냅샷의 제어 가능 여부·단일 Gateway를 재검증하고 대상 필드로 오류/포커스를 돌린다. 기존 구역 편집과 빈 구역의 경계 변경은 해당 층 도면으로 이동하며 구역 이름 입력은 16px이다.
- 저장 구역 편집기는 390×660·320×740 compact 화면에서도 지도 선택 영역을 최소 높이로 유지하고 dialog 내부 폼이 스크롤을 소유한다. 기존 100개 구성원을 모두 제거하는 경우 추가·제거 예정 목록은 별도 제한 높이 영역에서 스크롤하므로 지도·toolbar를 0px로 축소하거나 가리지 않는다. compact 신규 구역의 실제 marker 선택과 데스크톱 100개 변경 목록·재선택을 Chromium 회귀로 검증한다.
- compact 수동 제어는 접힌 상태에서도 선택 수·상태·16px 밝기 수치 입력·적용 버튼을 하단 내비게이션 위에 유지한다. 펼친 밝기 프리셋·슬라이더·진행/복구 상세만 제한된 높이 안에서 스크롤한다. 본문은 실제 시트 높이와 셸 위치를 반영한 별도 스크롤 영역을 사용해 지도·목록 버튼이 고정 시트 아래에 가려지지 않게 한다. 선택 수는 한 곳의 polite live region으로 알리고, 선택 불가 후보의 정적 사유에는 alert를 쓰지 않는다. 층·구역의 구성원 목록은 읽기 전용으로 표시하며 직접 선택 전환 방법을 안내한다. Gateway·감지 capability·구역 경계 제한은 지도와 목록에서 같은 정책 사유를 제공한다.
- 공통 pinch는 시작 시 지도 좌표를 현재 두 손가락 중점 아래에 유지하므로 비대칭 확대와 두 손가락 이동을 함께 지원한다. 48px coarse marker의 중심은 도면 가장자리에서 반지름만큼 안쪽으로 제한해 실제 44px 이상 터치 영역을 보존한다. 이 보완은 실제 viewport 좌표·pointer buttons를 사용하는 Chromium 및 단위 회귀 범위이며 native WebView·물리 조명 HIL 증거가 아니다.

- 2026-09-17 제어 대상 선택은 수동 명령, 스케줄, 차량 감지 이벤트, 저장 구역 관리에서 공통 `SpatialTargetSelector`/`FixtureGroupMapEditor`의 지도 우선 흐름으로 통합했다. 지도에 배치되지 않았거나 도면을 읽을 수 없는 조명은 보조 목록 drawer로 선택할 수 있다. 지도는 이동·개별 선택·영역 선택 모든 모드에서 두 손가락 pinch를 우선 처리하고, wheel 확대·내부 pan/scroll은 viewport 안에 한정한다. marker는 시각 dot과 독립된 44px coarse hit target을 쓰며, pointer capture는 지도 밖 drag를 유지하되 marker button의 native click은 단일 선택으로 그대로 전달한다. 수동 개별 선택은 첫 조명의 단일 Gateway 및 최대 1,000개를, 저장 구역 멤버십은 단일 floor/Gateway·1~100개를 강제한다. compact 화면은 선택 요약을 펼쳐 밝기·실행·진행/복구를 한 흐름에서 제공하고, drawer·지도 detail·실행/이력은 모두 bounded internal scroll을 사용한다. compact 수치 입력은 16px, preset/action은 44px 이상(현재 preset 52px)이다.

- 2026-09-17 지도 제어 브라우저 검증에서 compact 밝기 수치 입력을 16px로, 프리셋 버튼을 높이 52px로 보완했다. 둥근 모서리를 제외해도 44×44px 터치 영역을 확보한다. 조명 목록 drawer는 PC에서도 높이를 제한하고 목록 자체를 스크롤하며, 내부 native checkbox 입력의 위치 기준을 목록으로 고정해 마지막 행 선택 시 overlay가 화면 밖으로 밀리지 않게 했다. 1024px의 100→121개 목록 확장·마지막 행 선택, 1440/1024px의 실제 지도·이력·구역 내부 휠 스크롤, 390/320px의 펼친 실행 영역·drawer 터치 영역과 입력 글꼴을 Chromium으로 검증한다. 이는 브라우저 회귀 범위이며 실제 WebView 터치·하드웨어 HIL 검증은 아니다.

- 2026-09-17 저장 구역 생성·수정의 조명 멤버십 편집을 지도 우선 `FixtureGroupMapEditor`로 교체했다. 첫 조명 선택은 같은 floor·Gateway 경계를 잠그며, 모두 제거해도 기존 구역의 경계는 자동으로 이동하지 않고 명시적인 경계 선택으로만 바뀐다. 지도 marker와 보조 목록 drawer는 같은 `SpatialTargetSelector` 상태를 공유하므로 미배치 조명도 목록에서 선택할 수 있다. 저장은 기존 생성/수정 mutation에 1~100개 unique fixture의 전체 교체 set만 전달하며, 편집 중 추가·제거 예정 멤버를 텍스트로 표시한다. 저장 전에는 `저장 후 Mesh 설정 중`을 안내하고 저장 응답의 `configuring` 상태는 `Mesh 설정 중`으로 표시한다. 경계 polygon은 저장하거나 렌더링하지 않는다. 카드·삭제 확인·재동기화·viewer 읽기 전용·cache/focus 계약은 유지했고, 모바일 44px marker/action, 16px field 및 내부 overflow는 공통 selector 정책을 따른다. 이는 Vitest UI 회귀 증거이며 실제 Mesh/조명 HIL 완료를 뜻하지 않는다.

- 2026-09-17 차량 감지 이벤트 추가·수정은 감지 센서와 실행 조명을 각각 지도 우선 `SpatialTargetSelector` 단계에서 선택한다. 감지 센서는 capability가 검증된 fixture 직접 선택만 허용하고, 지원하지 않는 센서는 지도에 `선택 불가`로 보인다. 새 이벤트에서는 적격 감지 센서의 단일 Gateway가 정해지기 전 실행 조명 선택 action을 비활성화하고 이유를 안내한다. 실행 조명은 감지 센서의 단일 Gateway로 제한한 개별·층·저장 구역 선택을 제공하며, 층·구역은 완료 시 정렬된 fixture ID 스냅샷으로 기존 이벤트 payload에 저장한다. 이후 멤버십 변경은 저장된 이벤트를 바꾸지 않고 API 재편집은 직접 fixture 스냅샷으로 시작한다. 감지 Gateway를 바꾸면 호환되지 않는 실행 대상은 비워 저장을 차단한다. 기존 validation/server error focus, 권한·pending lock, 밝기/디밍/유지 시간과 `VehicleEventRuleSnapshotV1` 계약은 유지한다. 지도 view와 목록 drawer는 compact bounded overflow, 44px action/marker, 16px field 정책을 따른다. Vitest 지도 선택·form·presenter·panel 41개는 Web UI 회귀 증거이며 실제 Mesh/조명 HIL은 아니다.

- 2026-09-17 스케줄 추가·수정의 전용 대상 선택 view를 지도 우선 `SpatialTargetSelector`로 교체했다. 개별 marker·목록 drawer·층 전체·저장 구역은 공통 단일 gateway/Mesh readiness 정책을 그대로 따르며, 층·구역을 고르면 그 시점의 fixture ID를 스케줄 payload에 스냅샷으로 저장한다. 따라서 뒤의 그룹 멤버십 변경은 기존 스케줄을 바꾸지 않고, API에서 다시 불러온 스케줄은 직접 fixture 스냅샷으로 표시한다. 대상 검증 focus, schedule overlap·고급 반복·현장 시간대, 권한/submit lock과 API schema는 유지한다. compact 대상 view와 보조 목록 drawer는 bounded full-screen content, 44px action과 16px field 계약을 따른다. 관련 Vitest schedule/contract 55개를 통과했으며 이는 브라우저 회귀 증거로 실제 Mesh/조명 HIL은 아니다.

- 2026-09-17 수동 제어는 지도 우선 `SpatialTargetSelector`로 개별·다중·층·저장 구역을 선택하고, 목록은 보조 drawer로 연다. 선택은 최대 1,000개 및 첫 개별 조명의 단일 gateway 조건을 유지하며, 실행 payload·명령 잠금·재시도·상태 확인 계약은 변경하지 않았다. PC는 지도/실행/이력 영역을 각각 bounded overflow로 유지하고, compact 화면에서는 대상 요약을 펼쳐 consumer-owned 밝기·적용 실행·명령 진행·후속 조치·동일 요청 재시도·상태 다시 조회 UI를 확인한 뒤 접힌 명령 이력으로 이동한다. 불가한 층·구역과 drawer 조명은 Mesh/Health 차단 사유를 보이며 viewer와 명령 잠금 상태에서는 marker·목록·밝기 입력을 모두 비활성화한다.

- 2026-09-16 Tailwind Task 12에서 공통 primitive와 수동·스케줄·이벤트 제어 화면의 legacy class/CSS adapter를 제거하고 의미 토큰·utility 및 `data-*` 테스트 계약으로 수렴했다. `Button`의 공개 `data-variant` 계약으로 제어 E2E가 시각 variant를 class 이름에 결합하지 않게 했고 정책 baseline은 빈 violation map을 사용한다. Fresh Web **1,224/1,224**, UI policy **53/53**, 전체 Chromium 직렬 **257 passed·5 환경 의존 skip·실패 0**, 별도 opt-in RealBackendLab 설치·제어 흐름 **3/3**을 통과했다. 실제 iOS/Android WebView와 MQTT/Gateway/Raspberry Pi/ESP32-H2 HIL은 실행하지 않았다.

- 2026-09-16 공통 셸·인증 UI 이전에서 제어 진입 셸의 내비게이션, 현장 배지, 로딩·복구 상태와 로그아웃을 Tailwind 의미 토큰 및 공통 `Heading`/`Text`/`FeedbackState`/`ConfirmDialog`로 통합했다. 로그아웃 중에는 기존 active-command 차단을 유지하고, 저장하지 않은 맵 편집 내용의 폐기 승인이 끝나기 전에는 session을 종료하지 않는다. 관련 Vitest 157개와 320/390/1024/1440px Chromium 셸·인증·복구 시나리오 19개로 검증했으며, 이는 mock API 기반 browser 회귀로 실제 Gateway 명령·BLE Mesh·조명 실장비 HIL 완료를 뜻하지 않는다.
- 수동·스케줄·이벤트 제어의 폼과 dialog를 공통 디자인 시스템으로 통일했다. 검색·선택·체크박스·밝기 입력·날짜·시간·확인 dialog는 공통 컴포넌트를 사용하고, 기존 API payload와 숫자 문자열 변환·검증 계약은 유지한다. 수동 제어는 PC 셸의 남은 높이 안에서 조명 목록·명령 이력·실행 body·결과 feedback 영역이 각각 내부 스크롤하며 선택 피드백이 추가돼도 대상·실행 UI가 겹치거나 밀리지 않는다. 공통 Modal의 focus trap·Escape·중첩 확인 dialog·호출 버튼 focus 복귀를 적용했고, Chromium에서 실제 사용자가 보는 체크박스 라벨을 클릭하는 경로까지 검증했다.

- 기존 published 수동 payload를 재처리할 때 `deliveryGeneration`, `deliveryGeneratedAt`, `deliveryWindowMs`, `expiresAt`을 보존하고 구 수동 종료·requester 필드만 영속적으로 제거한다. PUBACK 유실·재시작으로 배달 기한이 늘어나지 않는다. Gateway는 하드웨어 성공 시점의 활성 schedule occurrence·차량 activation 식별자를 terminal journal에 함께 저장해 UTC rollback 직후 crash에서도 현재 source 억제를 복구한다. 다음 occurrence·새 activation은 정확한 식별자 비교로 재개하며, 문맥이 없는 구 journal은 기존 UTC 기반 복구를 유지한다. 이 보완은 software 회귀 범위이며 실장비 HIL 증거는 아니다.

- 수동 기본 밝기 software E2E는 2026-09-15 RealBackendLab **1/1 passed (59.2초, body 32.1초)**, 실패·skip 0으로 확인했다. 현재 schedule/event 억제, 새 event와 다음 daily occurrence의 재개 및 각각 60% 복귀, 삭제·재연결·API 재시작을 검증했고 production execution/ACK/DB 각 19건·telemetry outbox 0/gap false가 일치했다. Lab support 14/14와 Web typecheck도 통과했다. 기본 포트 충돌 첫 실행은 시나리오 미실행이며 격리 포트 재실행 결과와 구분한다. 이번 기본 밝기 release의 사용자 DB 적용·운영 배포·Pi/BIO/BlueZ/ESP32-H2 HIL은 미실행이다.

- BIO direct-USB 제어를 Gateway의 실제 adapter로 연결했다. `GATEWAY_ADAPTER=bio-usb`는 제조사 앱·휴대전화·BlueZ 없이 USB 동글을 직접 열고, 확정된 BIO UUID↔주소 mapping만 개별 제어에 사용한다. 밝기/모드 SET 뒤 UUID·주소가 일치하는 GET report를 다시 확인해야 성공으로 판정하며, mode가 없거나 `sensor`이거나 table 밖 raw 값이면 요청값을 실제 상태로 추정하지 않는다. 프로세스 종료 시에는 MQTT 입력을 먼저 막고 runtime drain, USB polling 중지, interface release, 필요 시 kernel driver 재연결을 순서대로 기다린다. 전용 BIO 컨테이너는 UID 999, capability 0, exact USB 하나만 사용하고 D-Bus/HCI/BlueZ 권한을 받지 않는다. 2026-09-14 admin4 단일 장치 HIL에서 약 2초 점등과 sensor 복귀, 동일 장치 주소 `0x5fe4 → 0x0100` 1회 변경, 새 주소 재발견과 confirmed mapping, 서비스 수동 밝기 제어를 확인했다. 등록 직후 BIO Fixture를 해당 hardware-confirmed terminal 근거로 online 처리하되 센서 모드 밝기·전원은 추정하지 않는 API 보완도 유지한다.
- BIO 스케줄 엔진은 일반 Gateway와 같은 clock-trust 계약을 사용한다. BIO 전용 Compose는 호스트 `/run/systemd/timesync` 디렉터리만 동일 경로에 read-only bind하고 전체 `/run/systemd`는 노출하지 않는다. 이 mount가 없거나 `synchronized` 표식이 없으면 현재 시간이 맞아 보여도 새 스케줄 시작을 fail-closed하는 것이 정상이다. 2026-09-14 스케줄 미실행 원인은 BIO Compose의 해당 mount 누락으로 확인해 회귀 테스트와 설정을 보완했다. Raspberry Pi에 commit `03071d55` 기반 ARM64 image를 배포한 뒤 23:10~23:11 Asia/Seoul 경계 HIL에서 revision 5 스케줄의 70% 시작과 기존 0% 복귀를 모두 BIO SET/GET read-back `succeeded`로 확인했고, API에는 `schedule_started → action_result(70%) → schedule_ended → action_result(0%)` 네 실행 이벤트가 저장됐다. 이는 구 timed manual release의 기록이다. 현재 기본 밝기 release의 Pi/BIO HIL은 별도 미실행이며, 수동 성공 당시 occurrence만 억제되고 다음 새 occurrence는 재개한다.
- BIO 층·구역 제어는 native BLE Mesh group subscription 대신 Gateway의 local virtual membership과 최대 4개 bounded unicast를 사용한다. API의 MeshNode ID와 BIO 등록 mapping의 Fixture ID는 서로 다른 ID 공간이므로 같다고 비교하지 않는다. 양쪽이 공통으로 가진 confirmed logical address로 API member를 Fixture ID로 변환하고, 실제 제어 직전 요청 Fixture가 virtual membership에 포함되는지 다시 확인한다. 따라서 미확정 주소와 다른 Fixture 요청은 RF 전송 전에 실패하며 별도 ID alias 테이블이나 DB migration은 필요 없다. 실제 ID가 다른 회귀 테스트를 포함한 BIO adapter 48개 software test를 통과했고 Raspberry Pi 층·구역 HIL은 진행 중이다.
- BIO의 read-only presence가 fresh해지면 freshness 때문에 생긴 offline/stale 차단만 해소할 수 있다. health fault, `command_failed`, `provisioning_waiting_state` 등 실제 fault·명령 실패·등록 대기 차단이 남아 있으면 제어 가능 상태로 복원하지 않는다. presence는 설정값/통신 생존 증거일 뿐이므로 제어 명령의 GET read-back은 계속 실제 `fixture-state`만 발행한다.

- P0/P1 상태 조회 기반 계약을 연결했다. `Command.outcome`은 과거 행을 `NULL`로 보존하고 `CommandDispatch.kind`로 dimming과 status-check를 구분한다. Status-check wire는 dispatch당 대상 1~64개이며, 원 명령의 65~1,000개 대상은 하나의 논리 시도 안에서 정렬된 여러 dispatch로 나눈다. 최대 횟수는 dispatch 수가 아니라 논리 시도 3회다. 첫 chunk만 HTTP `clientRequestId`를 소유하고 동일 ID 재요청은 해당 시도의 전체 dispatch ID를 반환한다. 사용자 DB에는 `20260912090000_command_outcome_status_check` migration을 적용하지 않았다.
- 최종 리뷰에서 BlueZ의 Lightness Status 유실을 `timed_out`으로 보정하고 API가 기존 `failed + STATUS_TIMEOUT` wire도 원문 aggregate 검증 뒤 `unknown`으로 수렴하도록 했다. Publisher는 MQTT 호출 직전 `deliveryAttemptedAt`을 commit하여 PUBACK 유실 뒤 expiry/dead-letter와 pending timeout을 `unknown`으로 닫는다. 검증 단계의 발행 전 거절만 `not_applied`이며, 늦은 확정 ACK는 보존하고 불확실 명령의 Get 허용·겹치는 Set 차단을 유지한다.
- 최종 보정 검증은 API focused 209/209·전체 1,176 passed/272 environment-gated skipped, Gateway focused 77/77·전체 625/625, Shared 200/200 및 API/Gateway typecheck/build·Prisma validate다. Web 715/715와 Chromium 21/21은 `465984c` 시점의 이전 증거이며 이번 서버/Gateway 보정에서는 재실행하지 않았다.
- API timeout worker는 예약 batch를 single-flight로 실행해 느린 DB 작업과 다음 tick이 겹치지 않게 하고, 종료 시 interval을 해제한 뒤 진행 중 batch를 drain한다. 직접 호출하는 `closeExpired()`는 오류를 호출자에게 전달하고 예약 wrapper만 정제된 Prisma code 또는 `UNEXPECTED_ERROR`를 기록한다. 발행 전 delivery timeout은 `not_applied`, 발행 뒤 acceptance/status 유실은 `unknown`이며 status-check 자체 timeout은 원 명령의 `unknown`을 덮어쓰지 않는다.
- Gateway status-check는 durable command journal에 acceptance receipt를 먼저 저장한 뒤 Generic OnOff/Lightness Get을 실행한다. 같은 MQTT 명령의 live duplicate는 진행 중 Get과 receipt를 공유하고, 완료 duplicate는 journal 결과를 재사용한다. acceptance-only 재시작 복구는 Set이나 Get을 자동 재실행하지 않고 indeterminate 결과로 닫는다. API는 device-status ACK의 `eventId`와 canonical payload hash를 `ProcessedGatewayEvent`에 함께 기록해 exact duplicate를 무시하고 identity/hash 충돌 payload로 상태를 다시 바꾸지 않는다.
- 수동 제어의 `CommandHistoryPanel`은 사용자·현장 범위의 최근 명령, 300ms 검색, 단계 필터와 cursor 더 보기를 제공한다. 명령 행은 서버에서 상세를 새로 읽어 열고 닫은 뒤 다시 열 수 있다. 오래된 캐시의 미적용 결과로 재적용 버튼이 먼저 나타나지 않도록 상세를 재조회한다. PC에서는 대상 선택·실행 패널의 고정 배치를 유지하고 이력 목록과 상세 피드백 안에서 스크롤한다.
- `CommandOutcomeActions`는 불확정 결과에 경고·원인·시도 횟수와 “실제 상태 확인”만 제공한다. 상태 확인 중에는 제어 입력과 이력 선택을 잠그며 세 번 소진 시 현장 확인을 안내한다. HTTP 응답 유실은 동일 Get 요청 ID로 조회하고, 일반 제어 응답 유실은 “동일 요청 확인(새 제어 아님)”으로 저장된 원 요청을 재사용한다. `verified_not_applied`에서만 새 요청 ID로 원래 확정 조명 목록·밝기를 재적용하며, 층·구역의 현재 멤버나 편집 중인 선택을 재사용하지 않는다. 적용 완료는 설명만, 부분 적용은 마지막 확인의 대상별 현재값과 새 제어 안내를 제공한다. 세션 무효화·사용자/현장 전환의 요청 중단과 늦은 응답 무시는 유지한다.
- 저장된 명령 ID 복원은 과거 상세 캐시를 먼저 제거하고 새 서버 상세를 확인한 뒤 잠금을 해제한다. 상태 확인 POST의 응답·dispatch ID를 아직 받지 못했으면 상세가 이전 unknown이어도 조회를 유지한다. 로그아웃이 상태 확인 요청을 중단한 뒤 실패하면 같은 요청 ID로 복구할 수 있으며, 세 번째 시도도 새 시도를 만들지 않고 조회한다. 중단된 요청의 늦은 응답·정리 콜백은 재개한 HTTP 요청의 잠금을 해제하지 않는다.
- 차량 센서 capability는 node별 최신 revision과 event ID/hash를 영속 watermark에 보존한다. raw 원장 삭제 후 같은 revision을 다른 event로 바꾸면 mutation 없이 rejected ACK를 저장하고, exact replay는 기존 durable ACK를 재사용한다. 서로 다른 node의 같은 revision은 독립적으로 유지하며 임시 PostgreSQL에서 검증했다.
- 플랫폼 Task 4 최종 소프트웨어 검증은 root lint/typecheck/build exit 0, root script 58/58·Shared 203·Automation 28·Mobile 1·Web 64 files 712/712·API 120 suites 1,138 통과/289 환경 의존 제외·Gateway 64 files 608/608(총 2,748 통과/289 제외)다. 전체 Chromium은 194개 중 189 통과/5 opt-in 제외(188개 mock/브라우저 회귀 + 실제 disposable automation journey 1개), main 319.19 kB/gzip 99.21 kB다. Production 계약 18/18, 전체 audit의 MQTT 설정 2/2·Gateway container 24/24·required MQTT 2/2와 새 smoke `led-production-smoke-a9dac54a523c9484dbc4b9eade7b9d5e`의 당시 브랜치 빈 DB 57/57 migrations, TLS/mTLS·CRL·장애 복구·exact cleanup을 통과했다. Dependency 820개 중 기존 승인 예외 High 2/Moderate 1, unexpected 0이며 무취약 판정이 아니다. 운영 배포·사용자 DB·실제 외부 Vault/MQTT/Object Storage·native WebView·HIL·외부 관측 연결은 미검증이다. [운영 runbook](../runbooks/production-api-web-deployment.md)에 절차와 한계를 기록했다. 최종 독립 검토는 Critical/Important/Minor 0, PASS로 승인됐다.

- 플랫폼 Task 3에서 공통 앱 셸 복구를 구현했다. 초기 인증 401은 기존 로그인, 403과 그 밖의 비일시 오류는 권한·재로그인 안내로 분기한다. 브라우저가 부팅부터 offline이면 요청 없이 서비스 복구 화면을 표시하고 online 복귀 시 인증을 재개한다. 네트워크·전송 timeout·5xx는 자동 최대 2회 재시도하고 실패하면 `다시 시도`로 연결을 복구한다. `AppRoot`의 boundary는 App 자체의 hook/render와 Router/lazy shell 실패를 단일 main·alert·포커스 heading으로 표시한다. 인증 실패·재로그인·principal 전환 시 새 QueryClient를 먼저 활성화해 늦은 이전 mutation callback을 폐기된 client에 격리한다. 재로그인은 앱 active-command namespace와 tenant/auth 캐시·초안을 정리하고 최대 5초 logout 종료 뒤 로그인으로 수렴한다. 무관한 저장값과 최초 정상 부팅의 제어 복구 기록은 유지하며 원시 오류/응답/stack은 표시하지 않는다. Task 3 Web 64 files·712/712 unit, 관련 auth/shell Chromium 23/23(신규 복구 10개 포함), typecheck/build와 main `319.19 kB`/gzip `99.21 kB` bundle audit를 통과했다.

- Route 기능 코드 SHA `34261b6`에서 로그인·최초 비밀번호 변경은 초기 main에 유지하고 고객/운영자 shell과 제어 화면을 dynamic chunk로 분리했다. 역할 shell 전체 화면과 shell 내부 route는 공통 `RouteLoadingState`의 `role="status"`·`aria-live="polite"` 로딩 상태를 사용한다. 별도 Web route bundle 작업 당시 Task 4 Web 검증은 60 files·686/686 unit, 2,437 modules production build와 main `314.83 kB`/gzip `97.58 kB`(예산 `1,070.00 kB`/`325.00 kB`)를 통과했고, 14개 계획 route chunk와 main의 Konva·Recharts 격리를 audit으로 확인했다. 같은 별도 작업 당시 Task 3 Chromium 64/64는 1440/1024/760/390/320px에서 제어를 포함한 대표 route 전환을, disposable RealBackendLab 2/2는 실제 API/DB 기반 고객 여정을 검증했다.
- 공통 고객 셸 상단은 현재 메뉴 제목과 실제 현장명 배지만 표시한다. 기존 층명 기반 `B2 주차장` 표기와 동작 없는 Gateway 정상·오프라인·미등록 상태 배지는 제거하되 설정의 `Gateway 상태` 상세 카드는 유지한다. 로그아웃 위치와 인증·dirty editor 확인 로직은 유지하고, 고객·운영자 셸의 로그아웃은 공통 `IconTooltipButton`으로 아이콘만 표시한다. `로그아웃` 도움말은 hover와 키보드 focus에서 열리고 도움말 위로 포인터를 옮겨도 유지되며 `Escape`로 닫힌다. 모바일 버튼은 52px 실제 터치 영역을 사용한다.
- 수동·스케줄·이벤트 제어 탭을 통계 상단 메뉴와 같은 밑줄형 공통 `UnderlineNavigation`으로 통일했다. 탭 아이콘은 공통 label의 선택 옵션으로 제공해 제어의 기존 아이콘은 유지하고, 활성 밑줄·색상·44px 높이·가로 스크롤 동작은 통계와 공유한다. 기존 `mode` query, 권한별 탭 노출, `tablist`/`tab` ARIA 연결과 방향키·Home·End roving focus는 변경하지 않았다. 390·320·760px Chromium에서 세 모드 모두 탭과 panel 사이 16px 간격, overflow 내부 focus ring과 document 가로 overflow 부재를 확인했다.
- 현장 capability를 시스템 role과 분리했다. `read` 일반 유저는 제어 메뉴와 `/control` 직접 진입이 차단되고 수동 제어 API도 `403`이다. `control` 일반 유저는 모니터링·통계와 수동 제어만 사용할 수 있으며 `mode=schedule|event` 직접 URL은 `manual`로 replace된다. admin은 수동·스케줄·이벤트 전체를 사용한다. mock Chromium E2E에서 세 권한의 메뉴·직접 route와 수동 명령 API 허용/거절을 검증했으며, 이는 실제 Gateway/BLE Mesh HIL 증거가 아니다.

- 수동 밝기 제어의 오른쪽 실행 영역은 공통 `SidePanel`과 `ui-side-panel-layout`을 사용한다. 데스크톱에서는 280~340px 범위의 안전한 패널 폭을 확보하고 긴 대상명과 상태 문구를 패널 안에서 줄바꿈하며, 높이가 제한되면 패널 내부만 세로 스크롤한다. 1120px 이하에서는 대상 선택 다음 한 열로 쌓아 화면 밖 잘림을 막는다.

- 에디터의 식별 명령은 일반 밝기 제어와 별도 Health Attention 경로로 처리한다. 10초 식별 중에도 일반 수동·스케줄·이벤트 목표는 유지하고 종료 시 최신 목표로 복귀하도록 펌웨어를 보강했다. 실제 LED 복귀 검증은 후속이며 기존 제어 명령 성공/실패나 전력 상태를 식별 응답으로 덮어쓰지 않는다.

- 에디터 배치 상태와 제어 대상을 분리했다. 조명을 미배치로 바꿔도 Fixture/Mesh ID, 그룹 멤버와 스케줄·이벤트 대상은 유지한다. 배치 해제는 실제 소등/장비 삭제 명령을 보내지 않는다. 격리 DB 관계 보존 회귀와 두 층 브라우저 E2E의 배치 해제 후 70% 명령·MQTT 결과 확인을 통과했다. RF 경계는 테스트 simulator이므로 실장비 검증으로 확대하지 않는다.

- 실장비 provisioning 직후 Gateway가 발행하는 차량 센서 capability의 `meshNodeId`는 Gateway가 알고 있는 등록 후보/Fixture 식별자일 수 있다. API는 claimed Site/Gateway 범위 안에서 실제 `MeshNode.id` 또는 연결된 `Fixture.id`를 정확히 한 건으로 해석하고, 처리 원장과 capability metadata에는 canonical `MeshNode.id`를 저장한다. 0건 또는 중복 매핑은 fail-closed하며 ACK에는 Gateway가 보낸 식별자를 그대로 반환해 durable journal correlation을 유지한다. 2026-09-03 Raspberry Pi/ESP32-H2 HIL에서 capability revision 1, Sensor Server/vendor model binding, ACK outbox 발행을 확인했다.
- Web 응답 유실 복구 저장소는 shared canonical 스키마로 target+brightness 요청 fingerprint를 검증한다. 2026-09-02에 보존하던 legacy `overrideUntil`은 현재 복구 경계에서 제거하며 수동 종료 의미를 되살리지 않는다.
- Gateway dimming command topic의 MQTT QoS 1 `PUBACK`은 command journal 수락이 완료된 뒤에만 전송한다. API도 acceptance/device-status를 포함한 non-fixture QoS 1 메시지를 Site/Gateway별 bounded queue에서 DB 반영한 뒤 `PUBACK`하며, DB 실패 시 transport를 닫아 broker persistent session의 재전달을 보존한다.
- patched BlueZ 5.82의 로컬 AppKey 생성은 provisioner keyring과 로컬 node storage/runtime을 함께 갱신한다. exact source patch dry-run, 컨테이너 계약과 ARM64 `bluetooth-meshd` compile을 통과했다. 2026-09-03 Raspberry Pi 컨테이너 cold restart 뒤 `generic:hci0` raw-HCI에서 ESP32-H2 상태 resync와 90%·20%·60% 제어/상태 응답을 실 RF로 확인했다. 40% 명령은 ESP에 적용됐지만 단일 Status 응답이 유실돼 `STATUS_TIMEOUT`으로 끝났으므로 재시도 내구성은 후속 보완 대상이다.
- 수동 명령·저장 구역의 transport 오류는 공통 표시 전용 mapper를 사용해 `Gateway ACK timeout`을 `게이트웨이 장비 응답 시간 초과`로 표시하고, 원시 command/group API 값과 protocol identifier는 유지한다. 화면 결과에는 `Gateway`/`ACK`/`timeout`이 섞인 문구를 남기지 않는다.
- 스케줄, 차량 이벤트, 저장 구역 dialog의 취소·저장 액션은 공통 `Button`을 사용한다. 기존 submit/cancel event, disabled/loading 문구, Escape·focus 복귀와 기존 CSS class 계약은 유지한다.
- 스케줄과 차량 이벤트 dialog를 `빠른 설정 + 고급 설정` 구조로 단순화했다. 스케줄은 `언제 → 제어 대상 → 밝기`, 이벤트는 `감지 센서 → 실행할 조명 → 밝기·유지 시간` 순서로 읽히며, 긴 `ControlTargetPicker` 목록은 기본 화면에서 제거하고 같은 dialog의 전용 선택 view에서만 표시한다. 매일·평일·주말·한 번, 밝기, 유지 시간 프리셋과 실시간 요약 문장을 제공한다. 스케줄 적용 시작·종료일은 기본 `언제` 영역에 항상 표시하고, 월간/연간/사용자 지정 반복·이름·디밍 사용 여부는 접힌 고급 설정에 유지한다. 기존 advanced 규칙 수정 또는 해당 validation 오류에서는 필요한 영역을 자동으로 연다. 선택 카드 설명은 한 줄 말줄임으로 제한해 capability나 상태 문구가 늘어나도 footer와 주변 UI를 밀지 않는다. Dashboard에서 삭제된 조명과 capability가 해제된 차량 센서는 `확인 필요`로 표시하고 저장 전에 재선택을 요구한다. 1024×768의 121개 조명 picker는 dialog 남은 높이 안에서 목록만 스크롤하며 `더 보기`와 마지막 행까지 도달하고, 390px/320px 기본 화면의 프리셋·선택 버튼·밝기 range는 44px touch target을 유지한다.
- PC 2열 제어 화면은 셸의 남은 높이 안에서 고정되고 조명 목록과 자동화 panel만 내부 스크롤한다. 1440×900과 1121×900 Chromium에서 조명 80개를 표시해도 document 세로 스크롤 없이 조명 목록만 스크롤함을 검증했다. 761px 이상에서는 남는 높이를 탭 행에 분배하지 않으며 1440×900, 1024×768, 761×900에서 모드 전환 뒤 탭 크기를 유지한다. 760px 이하 가로 스크롤·44px touch target 계약도 유지한다. RealBackendLab은 미배치 조명을 수동 제어 목록에서 찾아 schedule 40%·event 80%·수동 기본값 60%의 현재 source 억제와 새 실행 재개, 삭제·재연결을 검증한다. 실행 결과는 아래 기록을 따르며 software Gateway 검증을 실제 HIL로 확대하지 않는다.
- PC 수동 제어의 우측 카드는 대상명·상태 배지를 고정 헤더로 유지하고, 핵심 입력과 상태 피드백을 서로 독립된 내부 스크롤 영역으로 분리한다. 긴 한글 대상명은 `minmax(0, 1fr)` 열 안에서 말줄임한다. 1440×900, 1121×900, 1366×768 Chromium에서 정상·장애 조명을 전환해 밝기·프리셋·적용 버튼 좌표와 카드 경계, document-level 세로 overflow 부재를 검증한다. 종료 입력을 제거한 레이아웃이 현재 계약이다.
- 1440×900, 1024×768, 390×844, 320×740 Chromium route fixture에서 대상 선택·밝기 실행 패널의 1120px 스택과 document-level horizontal overflow 부재를 검증한다. 390px/320px의 공통 helper는 disabled/hidden 및 숨긴 조상을 제외하고 viewport·overflow clip과 교차하는 target의 연속 44×44px hit 영역을 검사한다. 부분·완전 occlusion은 실패하며 checkbox/radio는 associated label과 input fallback 중 유효한 후보를 사용한다. Fixed containing block을 만드는 조상이 있을 때만 fixed target에 ancestor clip을 적용하고 scrollable control/dialog는 각 target을 viewport 중앙으로 옮겨 검사한다. 현재 대상은 검색·상태/층 filter·밝기 range·프리셋·적용 버튼이며 수동 종료 입력은 없다. 스케줄·이벤트 empty list와 add dialog의 시간·요약·고급 조건·target picker, 공통 focus ring과 reduced-motion 계약을 유지한다.
- 스케줄 제어와 차량 감지 이벤트 제어 설계를 확정했다. 상세 계약은 `docs/superpowers/specs/2026-08-29-schedule-vehicle-event-control-design.md`를 따른다.
- 클라우드는 규칙 관리·배포 상태의 정본, Raspberry Pi Gateway는 무중단 hot reload와 offline 현장 실행의 정본, ESP32-H2는 3.3V Active High 마이크로웨이브 센서의 GPIO 상태 이벤트와 밝기 적용을 담당한다. High 동안 이벤트를 유지하고 Low 이후 규칙별 유지시간을 계산한다.
- shared 반복 일정 계약과 production DB schema에 이어 Task 7에서 schedule API, Task 8에서 차량 이벤트 규칙 API CRUD, exact Fixture snapshot과 full-snapshot outbox 저장을 구현했다.
- schedule/차량 이벤트 API CRUD, production API MQTT 동기화, Gateway snapshot 원자 저장/hot reload, offline scheduler·priority arbiter·재시작 복구, durable execution telemetry, Gateway BLE Mesh Sensor Client, ESP32-H2 GPIO driver와 Sensor Server/reliable vendor event model을 완료했다. Task 17~19의 Web CRUD와 software E2E에 이어 2026-09-04 단일 Raspberry Pi 4·ESP32-H2 실장비 HIL에서 admin UI 생성·수정·비활성화·삭제, config revision `1~7`의 exact `APPLIED`, schedule 시작 `70% -> 35%`와 종료 복귀 `35% -> 70%`, 차량 High `70% -> 85%`, Low 후 5초 복귀, 수정된 규칙의 High `70% -> 80%`, Low 후 6초 복귀를 확인했다. 16개 execution event와 6개 fixture action result가 모두 성공했고 Gateway config ACK·telemetry outbox는 비었다.
- Bluetooth SIG Company ID 발급 전 실장비 검증을 위해 Gateway와 ESP32-H2에 명시적 `lab-hil` 프로파일을 추가했다. 실기에서 `0xFFFF`가 BlueZ SIG 모델 내부 표식과 vendor model ID를 중복시키는 원인을 확인해 Lab 전용 비양산 RFU 값을 `0xFFFE`로 교체했다. Gateway 확인값, firmware Lab manifest와 전용 flash wrapper가 모두 맞을 때만 RF에 사용하며 production 시작·flash 경로는 계속 거부한다. 단일 ESP32-H2의 검색·provisioning·등록·재시작 복구·개별 밝기·schedule/event sensor 제어는 실 RF로 통과했으며 다중 노드, Mesh Group, packet loss와 동시 전원 차단 HIL은 남아 있다.
- Scenes 17~21의 Calm Operations 자동화 표면은 공통 `StatusBadge`와 `FeedbackState`로 목록의 활성·Gateway sync·최근 실행/감지 상태와 loading/empty/error/stale polling을 구분한다. schedule/차량 이벤트의 PC 표는 각각 접근 가능한 이름을 유지하고, 760px 이하에서는 동일 데이터와 관리 동작을 공통 카드 목록으로 표시한다. admin empty state의 추가 action, 삭제 확인, 오류별 실제 retry, viewer read-only를 유지하며 query key, bounded pagination, polling, mutation auth/cache callback과 scope generation은 변경하지 않았다. 빠른 설정 editor는 기본 화면에 프리셋·선택 요약 카드·결과 요약만 노출하고, 조건별 입력과 긴 목록은 고급 설정 및 전용 picker view로 분리하면서 기존 controlled input·검증·focus trap/return을 보존한다. 기존 `calm-operations-automation.spec.ts`의 1440×900, 1024×768, 390×844, 320×740 route fixture 검증 기록은 당시 가로 스크롤 표와 editor 흐름에 대한 증거다. 2026-09-24 카드 전환 후 390/320px 카드 정보·관리 동작·가로 overflow 부재 및 PC 표 유지 assertion은 추가했지만 이번 공유 checkout에서 실행하지 않았다. empty/error/retry action variant는 React Query retry 시간을 제한하기 위해 별도 390×844 fixture에서 실행한다. 과거 route fixture 결과와 신규 assertion 모두 UI software 범위이며 Gateway/BlueZ/Raspberry Pi/ESP32-H2 HIL을 대체하지 않는다.

### 확정 구현 범위

- 사용자가 명령을 적용하면 실제 BLE Mesh 상태 기반 terminal 결과가 나올 때까지 현재 제어 입력을 잠그는 사용자 관점의 동기 제어를 구현한다. HTTP 연결을 장시간 유지하지 않고 기존 Command/Outbox/MQTT 상태를 1초 polling으로 조회한다.
- 개별 조명, 임의 다중 선택, 층 전체, 저장 구역 단위 밝기 제어를 제공한다.
- 개별 조명은 unicast, 임의 다중 선택은 제한된 병렬 unicast를 사용한다.
- 층 전체와 저장 구역은 사전 구성된 BLE Mesh Group Address에 단일 전송한다.
- 임의 선택이 기존 층 또는 구역 구성과 정확히 같으면 Group Address 경로를 사용한다.
- 장비별 BLE Mesh Health Current의 현재 fault만 수집해 제어 가능 여부와 결과에 반영한다.
- gateway별 영속 `MeshControlGroup`/`MeshControlGroupMember` 저장 구조와 `0xC000~0xFEFF` group address allocator를 둔다. group은 `configurationVersion`, `operationPlanVersion`, `fullReconciliationRequired`를 분리하고, 버전별 `MeshControlGroupExpectedOperation`과 실제 pair snapshot인 `MeshControlGroupAppliedMember`를 영속 저장한다.
- API는 `configuring` group의 전체 desired member set과 `retiring` group의 빈 desired set, cloud가 발급한 expected operation 전체 set, `incremental | full_state` reconciliation mode를 10초 주기로 gateway-scoped MQTT subscription sync command로 재발행한다.
- gateway는 cloud operation ID를 보존해 Light Lightness Server `0x1300`의 Config Model Subscription Add/Delete를 수행한다. incremental 재전송에서 이미 만족된 operation은 동일 ID의 `ready`로 재보고하고, state-loss `full_state` plan은 로컬 membership snapshot과 무관하게 모든 Add/Delete를 Config Client에 멱등 재적용한다.
- API는 `siteId`, `gatewayId`, `groupId`, group address, version이 현재 group과 일치할 때만 subscription result를 처리한다. 현재 version의 영속 expected set과 ACK의 `operationId/action/meshNodeId/meshAddress`를 mutation 전에 exact-set으로 대조하며, 빈·부분·중복·외부 node·잘못된 action/address/operation ID를 fail-closed한다. 동일 node address 교체의 delete-old와 add-new 두 operation을 각각 반영하고 successful operation만 applied snapshot에 멱등 반영한다.

상세 계약은 `docs/superpowers/specs/2026-08-26-monitoring-control-statistics-completion-design.md`를 따른다.

### 명시적 보류 범위

- 다중 gateway command 최종 집계 고도화
- ACK 계약 전면 개편과 API MQTT 소비 내구성 재설계
- 자동 Set 재시도, 취소, rollback과 수동 제어 패널 외 독립 명령 이력 페이지
- 스케줄 제어와 차량 감지 이벤트 제어 외의 센서·장면 자동제어
- RSSI, hop count와 제품별 상세 diagnostics
- 자동 HIL 판정. 실제 하드웨어 검증은 단일 gateway 기준으로 수동 수행한다.
- ESP32-H2 vendor sensor model과 Raspberry Pi BlueZ RF의 packet loss, 반복 재부팅, sudden power-loss HIL. 정상 High/Low와 5초·6초 hold 실 RF는 통과했지만 손실·전원 장애 시험은 별도다.

### 구현 항목

- Calm Operations 제어 화면은 h1 `제어` 아래 h2 `조명 제어`와 공통 밑줄형 수동·스케줄·이벤트 탭을 표시한다. 내부 제목은 공통 `PageHeader` h3의 24px·0 margin·1.22 line-height를 사용한다. 수동 모드는 `제어 대상 선택`과 `밝기 실행`을 읽기 순서대로 배치하며 선택 수·0~100 슬라이더·프리셋·적용 액션과 단일 polite `명령 진행 상태` live region을 제공한다. Assertive 명령 오류는 형제 alert로 분리한다. 종료 입력 제거 뒤에도 URL mode query, command lock/recovery, polling/retry/timeout, viewer 제한과 Mesh readiness를 유지한다.
- Scenes 13~16 수동 제어는 `명령 접수 → Gateway 전송 → 장비 응답 → 조명 적용` 진행 목록을 표시한다. `ACK`는 원문 protocol/terminal/retry 판단에 유지하고 화면 설명만 `장비 응답`으로 바꾼다. 저장 구역 dialog의 CRUD·재동기화·삭제 확인·viewer 읽기 전용·focus trap/return focus를 유지하며 삭제 pending 중 Escape/backdrop/close로 후보를 지우지 않는다. Chromium route fixture는 종료 필드가 없는 밝기 payload, nonterminal 입력 잠금, configuring/failed Mesh 차단, 네 viewport overflow·모바일 44px target을 검증한다. 이는 Raspberry Pi/BIO/BlueZ/ESP32-H2 HIL 증거가 아니다.
- 수동 전송 가능 여부, 자동화 활성 여부, Gateway 동기화와 최근 실행·감지 상태는 WCAG AA 4.5:1 이상 text contrast를 검증한 공통 icon+text `StatusBadge`로 표시한다. 공통 tone뿐 아니라 더 높은 specificity의 monitoring 화면 override까지 실제 CSS cascade 결과로 대비 계약을 검증한다. Gateway sync 문구는 `적용됨 | 적용 대기 | 적용 실패`로 통일하며 색상만으로 상태를 구분하지 않는다. 스케줄·이벤트 목록은 16px bordered surface와 최소 56px 행을 사용하고 구역 관리/add/edit/retry/delete는 ref 전달을 지원하는 공통 `Button` variant를 사용하되 기존 accessible name과 mutation·pagination·`401`·validation·scope side effect 계약을 유지한다. 760px 이하에서는 제어 PageHeader와 action 영역을 세로·전체 폭으로 전환해 320px/390px 화면에서도 추가 버튼 문구가 비정상적으로 접히지 않는다.
- 제어 페이지에 `수동 제어 | 스케줄 제어 | 이벤트 제어` 탭을 추가했다. 선택 상태는 `mode=manual|schedule|event` URL query로 유지하고 누락되거나 잘못된 값은 기존 `siteId`를 보존한 채 `manual`로 정규화한다. 선택 탭만 일반 Tab 순서에 두고 좌우 방향키 순환, Home/End에서 focus·선택·URL을 함께 갱신하며 browser back/forward 뒤에도 roving focus 상태를 복원한다. Site 또는 사용자 scope가 바뀌면 열린 스케줄 dialog와 mutation 표시 상태를 새 scope로 넘기지 않는다. Schedule panel은 schedule mode에서 lazy-load하고 loading 동안 연결된 `tabpanel` 상태를 유지한다.
- schedule 목록은 서버 `schedules.service.ts`의 실제 응답 형태를 사용해 이름, 활성 상태, 현장 시간대의 다음 실행, 반복·시간, 밝기, 대상 수, Gateway `PENDING|APPLIED|REJECTED` 상태와 최근 실행 결과를 표시한다. 최근 `action_result`는 `@led-control/shared/automation-contracts`의 narrow production schema로 검증한 뒤 fixture별 성공·실패·시간 초과를 집계하고 legacy/unknown payload는 상세 확인 불가로 표시한다. subpath의 `browser`와 generic `import`는 shared build가 생성한 executable `dist/esm` artifact를 사용하고 CommonJS `require`는 기존 CJS artifact를 유지하며, shared root CommonJS runtime은 Web production graph에 포함하지 않는다. Shared build cleanup은 manifest 소유 파일만 제거하고 `dist` root/parent/target symlink와 non-directory를 fail-closed하며 unrelated 파일을 보존한다. Artifact logical path는 POSIX 상대 경로만 허용하고 colon/backslash, drive-relative, ADS, UNC/device와 terminal dot/space를 host OS와 무관하게 mutation 전에 거부한다. 목록은 기본 10건(선택 가능 10·20·50·100건) bounded cursor page로 조회하며 3초 polling한다. 첫 페이지, 다음 페이지, background 상태 갱신 오류를 구분하고 기존 행을 유지한 비차단 경고와 오류 종류에 맞는 재시도를 제공한다.
- admin은 schedule 추가·수정·삭제·활성화/비활성화를 수행할 수 있고 viewer는 같은 목록과 상태만 조회한다. mutation 성공 시 중앙 schedule query key와 dashboard query를 invalidate한다. `schedule_overlap`, `single_gateway_required`, 권한·입력 오류는 서버 원문을 노출하지 않는 한글 메시지로 표시한다.
- schedule dialog는 빠른 프리셋의 `매일`, `평일`, `주말`, `한 번`을 기존 daily/weekly/once 계약으로 변환하며 평일은 월~금, 주말은 토~일 exact day set을 사용한다. 적용 날짜 기간과 하나의 자정 통과 가능 시간 구간은 기본 화면에 표시하고, 고급 설정은 1회·매일·매주·매월·매년 전체 반복과 디밍 ON 밝기 0~100·디밍 OFF 100%를 유지한다. 개별/다중·층·구역 target도 유지한다. 날짜는 Site IANA timezone의 달력 날짜를 ISO instant로 변환하며 브라우저 local timezone과 분리한다. 직접 선택은 최대 1,000개이고 월 29~31일 및 매년 2월 29일의 건너뛰기 의미를 안내한다. 매월 29~31일은 허용하지만 매년 4월 31일·2월 30일처럼 Gregorian 달력에 영구히 존재하지 않는 조합은 저장 전에 거부한다.
- schedule list/poll/mutation의 `401`은 로그인 세션 만료로 안내하고 중앙 `auth/me` query를 현재 사용자·Site 세대당 한 번만 invalidate한다. scope가 바뀌었다가 같은 값으로 돌아온 경우에도 과거 세대의 지연된 `401`이 새 principal을 만료시키지 않으며 `403` 권한 오류와 network 오류는 별도 문구를 유지한다.
- 이벤트 탭은 lazy-load한 차량 이벤트 규칙 panel로 admin CRUD·활성화/비활성화와 viewer read-only 목록을 제공한다. 목록은 활성 상태, source·target 수, 밝기, hold, Gateway sync 상태와 최근 감지를 표시한다. 초기 목록·다음 cursor·background polling의 `401`은 모두 세션 만료로 안내하고 중앙 `auth/me` query를 invalidate한다. mutation의 auth/cache side effect는 mutation-level callback에서 수행해 panel unmount 뒤에도 보장하며, dialog/message 같은 UI state만 scope 세대로 제한한다.
- 스케줄·이벤트 목록 조회와 보이는 페이지 polling에서 `401` 세션 만료 또는 `403`/`404` 현장 조회 권한 상실이 확인되면 캐시된 행·관리 버튼·열린 수정/삭제 대화상자뿐 아니라 조건별 집계·페이지 이동도 즉시 차단한다. 앞선 일시적 polling `503`보다 새 목록 접근 오류를 우선 표시하고, `401`만 `auth/me`를 무효화한다. `403`/`404` 뒤에는 실제 목록 재조회 성공 시에만 관리를 다시 제공한다. 이는 Web mock 기반 차단 검증이며 실장비 동작 검증은 아니다.
- 이벤트 dialog는 감지 센서와 실행할 조명의 요약 카드를 원인→결과 순서로 배치하고, 밝기 50/70/80/100%와 유지 시간 30초/1분/5분 프리셋을 제공한다. 프리셋 밖의 5~1,800초는 직접 입력으로 유지한다. source picker는 전용 선택 view에서 Dashboard fixture의 Gateway 등록, `supported` vehicle sensor capability 및 canonical ISO verified timestamp가 모두 확인된 fixture만 노출한다. timestamp 누락·`null`·비정상 값은 fail-closed한다. target은 direct fixture selection만 지원하며 API의 단일 Gateway 제약을 그대로 적용한다. submit validation 오류는 stable error id로 해당 input/control group과 연결하고, 필요한 고급 설정 또는 picker view를 연 뒤 첫 invalid group 또는 input으로 focus를 이동한다.
- 수동 제어는 종료 시각 입력 없이 대상과 밝기를 전송한다. 성공한 조명별 밝기는 영속 기본값으로 저장하고 `조명 적용 완료 · 기본 밝기로 저장됨`으로 안내한다. 실패·시간 초과 조명은 기존 기본값을 유지한다. 응답 유실 복구는 target+brightness로 동일 요청을 재전송하며 유효한 legacy 저장 요청의 `overrideUntil`은 복구 시 제거한다.
- Gateway production runtime은 snapshot activation을 실제 offline scheduler와 priority arbiter에 연결한다. 수동 성공 시점에 활성인 exact schedule `(scheduleId, occurrenceKey)`와 vehicle `(ruleId, startedAt)`만 억제한다. 다음 occurrence/activation부터 `억제되지 않은 차량 event 중 최대 brightness > schedule > 기본 밝기` 순으로 동작하고 자동 실행 종료 후 수동 기본 밝기로 돌아온다. 진행 중 event의 Low hold 연장·재감지는 같은 activation이며 종료 후 새 감지부터 재개한다.
- Gateway automation state schema V6는 `pendingManualControls`, `manualAutomationSuppressions`, `baseBrightnessByFixture`, 확인된 desired와 차량 센서 bounded inbox를 저장한다. V1~V5 입력을 migration하며 확인된 V5 성공 manual만 기본값으로 승격하고 남은 종료 시간은 폐기한다. Pending/실패/불명확 값은 성공으로 추정하지 않는다. Lifecycle/terminal, telemetry handoff와 `(sourceUnicast,bootId,sequence)` receipt는 같은 atomic mutation으로 유지하며 restart pending/unverified fixture는 lighting observation까지 RF를 보류한다.
- Automation fixture observation은 Health Current telemetry와 분리된 OnOff/Lightness callback으로 수집한다. Health timeout이어도 밝기 recovery는 완료된다. Full resync는 MQTT/heartbeat/ACK/manual control startup 뒤 모든 confirmed fixture를 bounded-concurrency worker로 순회하고 fixture 실패를 격리한다. Error 또는 `timedOut`/`failed`가 있는 full report는 250ms~30초 capped exponential backoff로 자동 rerun하며, restart pending source도 observation listener 설치 뒤 targeted worker에 즉시 seed한다. Full/targeted worker는 fixture 경계, 관측 대기, busy retry에 `AbortSignal`을 전달하고 production shutdown은 timer를 취소한 뒤 기본 5초 상한으로 drain한다. Readiness는 full resync의 `mesh_resync_pending|mesh_resync_failed` blocker로 노출한다.
- Schedule recurrence는 wall clock, 현재 process의 vehicle Low hold는 monotonic clock을 사용한다. 수동 기본값에는 만료 시간이 없다. `deliveryGeneration`, `deliveryGeneratedAt`, `deliveryWindowMs`와 broker remaining TTL로 10초 command delivery와 RF 직전 deadline을 계속 검증한다. Legacy 종료 필드는 compatibility parser에서 읽되 기본값 유지 시간에 사용하지 않는다. Clock trust와 resync recovery fence는 새 schedule과 미확인 출력의 안전한 재개를 위해 유지한다.
- Manual command는 pending 제어와 transition을 RF 전에 저장한다. Startup은 snapshot 활성화 뒤 old/new journal pending handoff를 실제 `ScheduleRuntime`에 재생한다. Accepted manual/pending handoff는 완료 전까지 TTL과 일반 record eviction에서 보호하며 별도 10,000건 상한은 초과 intake를 capacity error로 차단한다. Live terminal은 실제 성공 시점의 source를 억제하며 복구 handoff는 그 뒤 시작된 새 source를 억제하지 않는다.
- BIO USB Gateway는 등록 직후 `sensor` mode여서 순간 밝기를 증명할 수 없는 경우에도 첫 수동 제어를 허용한다. 이 예외는 `adapterKind=bio-usb`에만 적용하며 일반 BlueZ의 `automation_current_state_unavailable` fail-closed는 유지한다. V6 pending 제어의 provisional `preBrightness`는 관측/current/base로 승격하지 않는다. `SET ACK → high-brightness GET → control-mode GET` 뒤 UUID·native UUID·논리 주소·밝기와 exact `force-on|force-off` mode가 일치한 성공 terminal만 current/lastDesired/base를 확정한다. USB 또는 read-back 실패 시 미관측 밝기를 성공으로 남기지 않는다.
- 성공한 manual은 자동 source 활성 여부와 관계없이 해당 fixture의 기본값을 갱신한다. 예를 들어 schedule 40%·event 80% 실행 중 수동 60%가 성공하면 현재 source가 끝나도 60%이며, 새 event는 80%로 재개 후 60%, 다음 daily schedule은 40%로 재개 후 60%로 복귀한다.
- 자동 RF는 terminal telemetry capacity reservation 밖에서 실행한다. Fixture-state enqueue가 전부 또는 일부 실패해도 로컬 제어 결과를 유지하고 누락 범위를 stable handoff identity와 `fixture_state_outbox` provenance가 있는 automation state `telemetryGap`에 합친다. 최초 gap 후보는 state write 전에 identity/count를 확정한다. Definite state `ENOSPC`이면 같은 후보를 preallocated fixed journal에 `fsync`하고, state와 journal이 모두 실패하면 하나의 cumulative retained source와 degraded health로 합쳐 RF를 계속하면서 bounded retry한다. Outbox `recordGap`은 cumulative snapshot을 idempotent하게 수락하고 fixed journal reimport는 durable accepted baseline 이후의 aggregate delta만 반영한다.
- Gateway는 `detected|cleared|current-state` 차량 입력을 규칙별 OR source set으로 정규화한다. High는 software timeout으로 해제하지 않고 마지막 Low에서 monotonic hold를 시작하며 retrigger가 deadline을 취소한다. Clock-untrusted restart는 trust 회복 뒤 persisted UTC hold를 현재 boot monotonic deadline으로 변환한다. 억제되지 않은 event는 최대 밝기를 사용하고 마지막 event 종료는 억제되지 않은 현재 schedule 또는 기본 밝기로 복귀한다.
- Gateway production runtime은 표준 Sensor Client와 제품 vendor client model을 BlueZ application composition에 등록한다. Confirmed node의 Sensor Server와 vendor event server를 AppKey에 bind하고 provisioner publication을 exact Config Status로 확인한다. Startup, reconnect와 automation hot reload에서 enabled 차량 규칙의 source에 Presence Sensor Get을 보내며 Presence/Motion Status를 `current-state`로 반영한다.
- Vendor event는 version, `bootId`, `sequence`, `eventKind`, `level`의 exact length와 값 조합을 검증한다. Source별 current boot와 최근 8개 boot high-water를 V6 automation state inbox에 영속 저장한다. 처음 보는 boot만 새 session으로 적용하고 이미 recent에 있는 이전 boot는 ACK만 재전송한다. Presence는 `0|1` strict boolean, Motion Sensed Percentage 8은 `0..100`에서 `>0`을 active로 정규화한다.
- Node별 capability journal은 model binding 결과가 실제로 달라질 때만 revision과 event ID를 새로 만든다. Startup/reconnect는 전체 pending ID를 한 번 저장하고 Config 결과를 직렬 수집한 뒤 성공 binding과 pending 완료를 한 번에 저장하므로 journal rewrite는 source 수와 무관하게 최대 2회이고 총 write bytes는 O(N)이다. Partial Config failure는 실패 node만 pending에 남기며 성공 node의 unchanged binding은 revision/event ID를 유지한다. 두 batch의 commit uncertainty는 target이 previous면 이전 identity 유지, next면 같은 revision/eventId/hash 채택, unknown이면 journal을 fence한다.
- Provisioning completed terminal은 QoS1 callback을 먼저 보장한다. 최초 refresh journal write가 definite failure여도 controller가 최대 10,000개 volatile pending ID를 보존하고 1초~30초 capped backoff로 같은 serial batch를 재시도하며 health를 degraded로 유지한다. Shutdown은 retry timer를 취소하고 이미 시작한 enqueue/Config batch를 drain한다. Volatile set은 process crash를 넘지 않으며, 재시작 시 confirmed/configured source 전체 startup refresh가 source of truth로 복구한다. Broker PUBACK 뒤에도 capability report를 유지하고 exact application ACK만 terminal로 만든다.
- Production Gateway와 Task 16 firmware는 Bluetooth SIG 자사 할당 Company Identifier를 각각 `GATEWAY_BLUETOOTH_COMPANY_ID`, `CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID`로 같은 값에 설정해야 한다. 누락·미할당·Espressif `0x02E5`·테스트 예약값은 fail-closed하며 저장소에는 양산 기본값을 두지 않는다.
- ESP32-H2 차량 센서 driver는 interrupt-disabled boot sample을 32개 static queue에 먼저 넣고 critical enable/reconcile 뒤 양 edge를 수집한다. Sensor task는 handle publish 전 notification gate에서 대기한다. ISR은 IRAM/ROM audit된 level/time/enqueue 호출과 queue-full atomic dropped/resync flag만 수행한다. 일반 task는 queue drain 뒤 timestamp-before-level sample과 ISR generation 전후 비교로 stable GPIO resync만 publish하고 동일 level만 제거한다. Pull-down과 hardware hysteresis만 사용하며 software debounce, timing filter와 High timeout은 없다. GPIO allowlist와 PWM/factory-reset/strapping/flash/package/USB, 기본 UART0 GPIO23/24 및 custom console GPIO 충돌은 compile/runtime에서 fail-closed한다.
- Task 16 model worker와 static queue는 최초 start에서 한 번만 생성하고 stop 때 generation별 parked ack를 공개한 뒤 같은 task를 재사용한다. Sensor Status와 vendor event는 shared publication buffer 대신 pinned ESP-IDF v5.5.1의 repository-patched server-send 경로를 사용한다. `SERVER_MODEL_SEND` payload/context는 API thread에서 all-or-nothing snapshot하고 allocation/envelope/queue-post 실패는 handler 실행 없이 동기 오류와 exact cleanup, queue 수락은 기존 handler deep-free 1회를 보장한다. 따라서 back-to-back/16-slot same-deadline retry payload가 보존되고 failed event는 pending에서 재시도된다. NetKey `0`과 현재 publication의 AppKey/address/TTL/credential/SZMIC를 전송 context에 반영하고 period/retransmit가 `0`이 아니면 fail-closed한다. Token 없는 model send/publish completion은 advisory no-op이며 Sensor는 동기 API 수락/거부, vendor는 동기 API 결과와 exact ACK/retry exhaustion만 Health와 liveness에 반영한다. Client send는 기존 ESP-IDF deep-copy 동작을 유지한다. Sensor/vendor send fault active 조건은 분리되며 restart는 내부 zero Health source를 외부 current/registered 배열에도 exact 반영한다. Registered history Clear와 permanent sequence exhaustion current 의미는 유지한다.
- Firmware production trust anchor/fingerprint는 caller env가 아닌 고정 repository/CI policy에서만 읽으며 현재 `unprovisioned`라 production build는 의도적으로 실패한다. 향후 v2 approval은 CID/source commit/sdkconfig/partition digest를 서명하고 production artifact attestation v2는 approval identity와 app/bootloader/partition-table/otadata hash 및 ESP-IDF version/commit/patch/patched-source/identity digest를 release key로 서명한다. Build/flash wrapper는 exact source를 외부 build-only component overlay에만 patch하고 사용자 global IDF checkout은 수정하지 않으며, wrong revision/hash와 overlay 변조를 overwrite 없이 거부한다. Flash wrapper는 exact signature/hash를 재검증한다. Test `0xFFFF` image는 app 첫 분기에서 fail-stop해 raw flash 우회에도 NVS/Bluetooth/sensor를 시작하지 않는다.
- Gateway execution telemetry `appendBatch`는 handoff 전체를 한 atomic rewrite로 수락하거나 실제 dropped record set 전부를 반환해 prefix success를 만들지 않는다. Grouped `action_result` 한 payload의 여러 fixture result는 dropped count 1이다. Pretty JSON metadata를 포함한 regular outbox는 strict 64 MiB다. Automation state와 outbox는 startup에 한 번 실제 할당한 공용 64 MiB headroom을 사용하며 정상 commit은 reserve I/O를 만들지 않는다. 실제 `ENOSPC`에서만 reserve를 한 번 release/retry하고 verified free space 뒤 background로 복원한다. State mutation은 `durable|memory_only` outcome을 반환하고 schedule/vehicle/manual local transition만 memory-only fallback을 사용한다. Handoff/gap clear는 durable-required라 실패 시 memory/disk pending과 outbox receipt를 그대로 두고 coordinator batch를 중단해 1초~30초 bounded backoff로 같은 handoff를 재시도한다. Fixed journal은 마지막 일반 source와 cumulative source receipt 외에 outbox accepted aggregate baseline과 acceptance identity/hash를 고정 필드로 유지한다. Aggregate identity는 clear까지 유지하고 reimport는 `aggregate - acceptedBaseline`만 처리한다. Baseline에 이미 흡수되고 state/journal에서 재생 불가능한 general source receipt는 같은 outbox import commit에서 제거하되 현재 state pending handoff/gap, current journal source, cumulative source, aggregate와 active baseline identity는 보호하므로 clear 장기 실패와 restart에서도 recovery metadata가 O(1)이다. Cleanup commit의 definite failure와 previous·next uncertainty도 기존 visible target reconciliation으로 동일 event ID/sequence/final hash와 정확한 count에 수렴한다. 두 4 KiB block과 inode allocation은 고정이며 clear tombstone generation 뒤 기록한 새 source도 restart에서 보존한다. Durable clear 뒤에만 source receipt를 release하고, retry에서 처음 outbox work가 생기면 publisher를 깨우며, 미게시 `event_extended`는 latest record로 교체하고 MQTT application ACK exact match 전 record를 유지한다.
- Raspberry Pi Gateway production runtime은 `AutomationSnapshotV1` config topic을 MQTT QoS 1로 구독한다. Snapshot은 strict schema, assigned Site/Gateway scope, Task 9와 같은 canonical SHA-256를 검증하고 단일 automation serial queue에서 처리한다. 높은 revision은 temp write, file fsync, rename, parent directory fsync를 거치며 rename 뒤 fsync fault는 exact disk read-back과 parent 재-fsync로 commit 여부를 확정한다. 재-fsync까지 실패하면 이전 visible snapshot을 복구하고 non-acknowledgeable `snapshot_commit_uncertain`으로 전파해 durable rejected ACK와 inbound PUBACK을 만들지 않으며 broker redelivery/restart가 이전 durable revision 또는 같은 revision/hash applied 상태로 수렴하게 한다. 저장 뒤 desired state 재계산/적용 실패 시 active file과 memory를 직전 revision으로 원자 복구한다. 같은 revision/hash는 저장·재계산 없이 idempotent applied 처리하며 낮은 revision과 같은 revision의 다른 유효 hash는 기존 snapshot을 유지한 채 각각 `snapshot_old_revision`, `snapshot_revision_conflict`로 거부한다.
- Gateway는 재시작 시 마지막 원자 교체 snapshot을 복구하고 중단된 temp 파일을 제거한다. Config `applied|rejected` ACK는 local Gateway ID와 수신한 exact revision/hash를 포함해 별도 `0600` file outbox에 publish 전에 저장하며 MQTT.js `handleMessage` backpressure가 이 fsync와 hot reload 완료 전 broker PUBACK을 막는다. ACK publish 실패는 같은 payload를 지수 backoff로 재시도하고 reconnect/process restart 뒤에도 재발행한다. reconnect는 이전 generation drain이 남아도 새 exact ACK drain을 즉시 시작하며 ACK connect/retry는 health, provisioning, state, mesh resync 실패와 분리된다. Production-like handler 검증은 valid, invalid, old, conflict, store/recompute failure 전후 current revision, durable ACK, MQTT/heartbeat/BLE Mesh 무중단을 함께 확인한다.
- Gateway는 관련 subscription 준비가 끝난 모든 MQTT connect/reconnect에서 strict `AutomationCurrentConfigRequestV1`을 발행하고 1초부터 최대 30초의 bounded backoff/jitter로 응답 snapshot을 기다린다. API는 topic/payload Site·Gateway와 active claimed Gateway MQTT certificate ledger를 transaction lock으로 확인한 뒤, `APPLIED` 상태라도 exact latest desired revision/hash의 기존 full snapshot outbox를 revive한다. 최신 snapshot이 empty/deleted 규칙 집합이어도 그대로 재발행하므로 세션이 없던 최초 연결과 세션 소멸 뒤 재연결이 MQTT retained/session 보존에 의존하지 않는다.
- Config applied ACK file outbox는 v2 delivery envelope의 `acknowledgementId`, Site, Gateway, revision, payload hash와 ACK 본문을 보존하며 broker PUBACK으로 record를 삭제하지 않는다. API가 exact immutable snapshot을 확인하고 최초 ingest 또는 exact idempotent replay를 DB transaction으로 반영하면서 만든 strict `AutomationConfigAppliedReceiptV1`을 받은 경우에만 전체 identity가 같은 record를 삭제한다. Altered/conflict ACK에는 receipt를 만들지 않고, wrong Site/Gateway·old ID·본문 불일치 receipt는 현재 record를 변경하지 않는다. Publish와 receipt 유실은 reconnect 및 1초~30초 bounded retry로 복구한다.
- `POST /commands/dimming`의 canonical 요청·응답과 새 MQTT payload에는 종료 필드가 없다. 유효한 legacy `overrideUntil`은 입력 호환 경계에서 제거하고 잘못된 날짜는 거부한다. Command, `ManualOverride`, `ManualOverrideFixture`, dispatch, outbox는 advisory lock과 Site 재인가가 있는 하나의 transaction에 저장한다. `ManualOverride.overrideUntil`은 nullable legacy 감사 필드이며 새 row는 null이다. Publisher는 durable 10초 delivery generation과 exact retry payload를 유지하고 delivery 만료만 `COMMAND_DELIVERY_EXPIRED`로 처리한다. 배포는 **V5 state 백업 → Gateway → DB/API → Web**, rollback은 이전 Gateway release와 대응 V5 state backup을 함께 복원한다. Control freeze·publisher drain·broker TTL 10초 대기와 DB nullable 이력 호환성은 [Pi runbook](../runbooks/raspberry-pi-gateway-appliance.md#수동-기본-밝기-v6-rolloutrollback)을 따른다. 사용자 DB 적용·운영 배포는 이번 software 작업에서 실행하지 않는다.
- `GET/POST/PATCH/DELETE /sites/:siteId/automation/vehicle-event-rules`를 제공한다. viewer는 assigned Site 목록을 조회하고 assigned active customer admin만 생성·수정·삭제할 수 있으며 operator와 다른 Site의 규칙은 `404`로 숨긴다. 목록 query는 Site 읽기 인가 뒤 파싱한다.
- 차량 이벤트 규칙은 distinct source와 target Fixture를 각각 한 개 이상 요구하고 등록 완료 Fixture만 저장 시점의 exact ID set으로 고정한다. source는 MeshNode capability가 `supported`이고 검증 시각이 있는 Fixture만 허용하며 unknown/unsupported/다른 tenant 식별자는 일반화된 validation 오류로 거부한다. target capability 검증은 하지 않는다. source와 target 전체가 같은 Site와 한 Gateway에 속해야 하며 다중 Gateway는 stable `single_gateway_required`로 거부한다.
- hold는 기본 60초, 5~1800 정수 범위이고 밝기는 0~100 정수다. `dimmingEnabled=false`는 입력 밝기를 저장하지 않고 DB/API/Gateway snapshot 모두 100%로 정규화한다.
- 차량 이벤트 parent/source/target과 Gateway `desiredRevision`, 전체 automation snapshot `MqttOutbox`를 하나의 transaction에 저장한다. write transaction은 공통 automation advisory lock을 먼저 획득한 뒤 Site row `FOR UPDATE` 재인가를 수행하며 Gateway 이동은 이전 제거 snapshot과 새 추가 snapshot을 함께 생성한다.
- 차량 이벤트 목록은 schedule과 같은 기본 25개·최대 100개 versioned keyset cursor와 `REPEATABLE READ` total/page snapshot을 사용한다. source/target 수, desired/applied revision, sync status, 최신 `vehicle_detected`와 최신 실행을 제공한다. 최신 전체 실행은 일반 ordered index, 최신 감지는 `kind='vehicle_detected'` partial ordered index를 사용한다.
- MeshNode 차량 센서 capability와 source-only CRUD 검증에 더해 direct SQL source 삽입, Fixture node 변경, enabled rule re-enable, capability downgrade DB guard를 구현했다. source 삽입과 downgrade는 공통 automation statement lock으로 직렬화되고, migration은 기존 invalid source를 rule/node 단위 remediation 오류로 중단한다.
- strict `VehicleSensorCapabilityReportV1`에 positive safe integer `capabilityRevision`과 complete-report canonical SHA-256를 적용했다. `VehicleSensorCapabilityService.applyReport`는 전역 `eventId`와 node-local Gateway/MeshNode/revision/eventType 원장을 함께 확인해 duplicate/stale/conflict/out-of-order report를 mutation 전에 분류하고, 높은 revision만 적용한다. 같은 Gateway의 두 node는 같은 revision을 순차·동시에 각각 저장할 수 있고 같은 node 충돌은 거부한다. supported는 metadata만 갱신하고 unsupported는 해당 node를 쓰는 모든 enabled rule을 원자 disable한 뒤 변경이 있을 때만 complete Gateway snapshot/outbox revision을 정확히 하나 만든다.
- capability report topic은 `sites/{siteId}/gateways/{gatewayId}/events/automation/vehicle-sensor-capability`, strict ACK topic은 `sites/{siteId}/gateways/{gatewayId}/acks/automation/vehicle-sensor-capability-ingested`다. ACK는 report identity/revision, `applied|stale|duplicate|rejected`, nullable error code와 ingestion 시각을 담는다. Service는 분류 transaction 안에서 deterministic `applicationAckKey`의 ACK `MqttOutbox`를 저장하고 정상 재전달에는 최초 payload/ingestion 시각을 재사용한다. Capability ACK row는 integer `revision`을 쓰지 않아 safe integer 최대 capability revision도 보존한다. MeshNode는 revision, 두 model-binding flag, status/verifiedAt coherence를 DB CHECK로 보존하고 legacy `ProcessedGatewayEvent`는 nullable hash로 호환한다.
- `MqttService`는 config applied, execution, vehicle capability의 세 Gateway-scoped automation event filter를 MQTT QoS 1로 구독한다. `AutomationMqttConsumerService`는 exact topic에서 Site/Gateway를 추출하고 strict payload ID, 현재 Gateway Site assignment, active claim과 active MQTT certificate를 함께 잠가 검증한다. 알 수 없거나 재배정·비활성·topic spoof인 identity는 상태와 ACK를 만들지 않는다. Broker mTLS ACL은 publisher 인증을 담당하고 API는 이 topic/payload/DB identity 결합을 추가로 강제한다.
- Config applied/rejected ACK는 해당 Gateway에 저장된 config outbox의 exact revision/hash/full snapshot과 일치할 때만 반영한다. Applied revision은 감소하지 않고 desired보다 낮은 성공은 `PENDING`, exact desired 성공은 `APPLIED`가 된다. Exact desired reject만 정제된 code로 `REJECTED`가 되며 이후 lower applied ACK는 applied revision과 적용 시각만 전진시키고 current rejection/code를 보존한다. 오래된 reject나 future/hash mismatch ACK는 현재 상태를 덮지 않는다.
- Execution ingest는 strict event와 source tenant/rule/Fixture snapshot을 검증하고 `(gatewayId,eventId,sequence)` 및 canonical payload hash로 exact replay와 conflicting replay를 구분한다. Source/target authorization은 mutable current rule이 아니라 `event.revision`에 해당하는 stored config outbox의 strict full snapshot과 canonical hash를 사용한다. Current rule이 변경·이동·삭제돼도 old revision의 정상 report는 raw `ruleId`와 nullable live relation을 보존해 수집한다. DB trigger도 execution의 `revision` 또는 action payload `sourceType`/`sourceId`만 변경하는 UPDATE에 같은 snapshot/source 검증을 다시 적용한다. 실행 원장, terminal fixture 결과와 `AutomationExecutionIngestedAckV1` durable outbox를 같은 transaction에 저장하며 exact replay는 최초 ACK payload/hash/`ingestedAt`을 보존해 delivery 상태만 되살린다.
- `AutomationOutboxPublisherService`는 command publisher와 분리된 config/application-ACK claim SQL, `FOR UPDATE SKIP LOCKED` 30초 lease, publish 전 renewal/ownership fence와 10초 MQTT QoS 1 timeout을 사용한다. 저장 payload는 command expiry 없이 그대로 발행한다. Config는 최신 desired full snapshot만 남기고 이전 미발행 revision을 retained superseded로 전환한다. Config와 application ACK 모두 1~60초 backoff 뒤 10회 또는 생성 후 15분에 stored topic/payload/hash를 보존한 retained deadletter로 전환되며 exact report 재전달은 application ACK를 되살릴 수 있다. 종료 coordinator는 active automation batch를 bounded drain한 뒤 MQTT를 닫는다.
- `GET/POST/PATCH/DELETE /sites/:siteId/automation/schedules`를 제공한다. assigned active customer admin만 생성·수정·삭제할 수 있고 viewer는 목록만 조회하며 operator와 다른 Site 요청은 `404`로 숨긴다.
- schedule mutation은 같은 transaction의 첫 statement에서 공통 automation advisory lock을 획득한 뒤 Site row를 잠그고 assigned admin을 다시 인가한다. fixture·fixture set·floor·active group 선택은 저장 시점의 등록 완료 Fixture ID 전체 set으로 고정하고 한 Gateway 대상만 허용한다.
- enabled schedule은 공통 automation engine의 실제 recurrence occurrence와 Fixture 교집합으로 충돌을 검사한다. disabled schedule은 충돌에서 제외하고 enable 시 다시 검사하며, 같은 Site에서 동시에 쓰는 서로 충돌하는 enabled schedule만 Site lock 아래 하나가 성공한다. 종료와 시작 경계가 맞닿지만 겹치지 않는 schedule은 함께 허용한다.
- schedule parent, deferred cardinality를 만족하는 child snapshot, Gateway `desiredRevision`, 전체 automation snapshot `MqttOutbox`를 원자 저장한다. Gateway 이동 update는 이전 Gateway의 제거 snapshot과 새 Gateway의 추가 snapshot을 함께 만들고 새 Gateway의 `appliedRevision`은 0으로 초기화한다.
- `dimmingEnabled=false` action은 DB와 Gateway snapshot 모두 `brightnessPercent=100`으로 정규화한다. 같은 local start/end는 full-day로 해석하지 않고 거부한다. 목록은 기본 25개·최대 100개이며 Site/생성 시각/ID를 담은 versioned base64url keyset cursor를 사용한다. Site 인가, 전체 수, page는 하나의 `REPEATABLE READ` snapshot에서 읽고 다음 occurrence, desired/applied revision, sync status와 최근 실행을 page row에만 결합한다.
- pending assigned admin이 제어 직접 URL로 들어오면 CustomerShell이 제어 화면을 계속 열지 않고 selected/default `siteId`를 보존한 최초 설치 설정으로 replace한다. 설치 완료 전에는 제어 mutation UI가 노출되지 않는다.
- dashboard의 fixture, 층, 저장 구역 목록을 기반으로 `개별/다중`, `층`, `구역` 제어 대상을 선택할 수 있다.
- 개별/다중 조명 목록은 이름 검색, 상태·층 필터, checkbox 선택을 제공하고 선택 개수와 제어 불가 개수를 표시한다.
- 개별/다중 조명은 최대 1,000개까지 선택할 수 있으며, 목록은 최초 100개를 렌더링하고 `더 보기`로 100개씩 추가해 대규모 현장의 브라우저 부하를 제한한다.
- 선택 조명의 현재 밝기를 슬라이더에 반영한다.
- 0%, 30%, 70%, 100% 프리셋 버튼으로 밝기 값을 바꿀 수 있다.
- `POST /commands/dimming`으로 선택한 개별·다중 조명, 층 또는 구역의 밝기 명령을 전송한다.
- 웹은 1개 조명에 `fixture`, 2개 이상에 `fixtures`, 층에 `floor`, 구역에 `group` 구조의 신규 `target` payload를 사용한다. 명령 API는 실제 현장 DB 관계를 같은 transaction 안에서 다시 조회해 확정된 `targetFixtureIds` snapshot을 저장한다.
- 단일 조명은 `unicast`, 임의 다중 선택은 `parallel_unicast`, 준비 완료된 층/저장 구역은 `mesh_group` delivery mode로 저장한다. 임의 선택이 준비 완료된 층 또는 구역 구성과 정확히 같으면 층 우선, 같은 종류 ID 정렬 순으로 Group Address 경로를 선택한다.
- 하나의 논리 target이 여러 gateway에 걸치면 `현재 여러 게이트웨이에 걸친 대상은 지원하지 않습니다`로 전체 거부하며, 준비되지 않은 floor/group은 unicast로 fallback하지 않는다.
- 명령 생성 응답은 `selectedTargetCount`, `transmissionCount`, `deliveryMode`, `terminalStatusUrl`을 제공하고 상태 응답은 nullable `targetId`, 확정 fixture snapshot과 dispatch의 delivery metadata를 반환한다. Mesh group dispatch에는 선택 당시 `meshControlGroupId`, `meshControlGroupVersion`, Group Address가 함께 보존된다.
- 명령 생성 응답은 command ID와 gateway dispatch 수를 반환하고, `GET /commands/:commandId`는 command의 현장 read 권한이 있는 사용자에게만 조회를 허용한다. 존재하지 않는 command와 접근할 수 없는 command는 같은 `command not found` 404 응답으로 처리한다.
- 제어 화면은 최근 명령을 1초 polling하며 접수, MQTT 발행, gateway 수신, 조명 적용 완료, 일부 실패, 실패, timeout 단계를 표시하고 종료 상태에서 polling을 중단한다.
- 제어 화면은 POST 전에 인증 사용자·현장별 `sessionStorage`에 canonical 요청을 저장하고, 명령 생성 직후 active command ID를 함께 보존해 새로고침 후 같은 사용자와 현장의 진행 명령만 복구한다. 로그아웃은 현재 사용자의 모든 복구 레코드만 제거하며 다른 사용자의 레코드는 건드리지 않는다. 저장소 helper는 접근 불가·손상 데이터·잘못된 UUID를 안전하게 무시한다.
- `completed`, `partial_failed`, `failed`, `timed_out` terminal 상태를 확인하기 전까지 대상 선택, 검색·필터, 밝기 slider, preset, `밝기 적용` 버튼을 잠근다. 상태 응답의 command ID가 현재 추적 ID와 일치할 때만 terminal 결과로 반영하고 잠금을 해제한다. ID가 불일치하면 terminal로 처리하지 않고 1초 polling과 `명령 상태 다시 조회`를 유지한다.
- terminal 결과는 화면에 유지하며, 네트워크 오류와 5xx는 명령 실패로 확정하지 않고 command ID를 보존해 `명령 상태 다시 조회`로 재조회한다. cached nonterminal 상태가 남아 있어도 최신 조회에서 인증된 404로 명령이 더 이상 존재하지 않음이 확인되면 저장된 active command를 CAS 방식으로 제거하고 잠금을 해제한다.
- active command 저장·삭제는 RFC 4122 UUID 검증과 `(authenticated userId, siteId)` key 격리를 사용한다. terminal command 삭제는 기대 command ID, 확정 거부 요청 삭제는 기대 client request ID를 다시 비교해 오래된 비동기 결과가 새 저장값을 지우지 못하게 한다.
- Playwright deterministic route fixture는 실제 Health snapshot 표시, 개별·다중 조명 명령 생성, 다중 unicast 전송 수, terminal 전 모든 제어 입력 잠금, `partial_failed`의 성공·timeout 조명별 결과, 동일 탭 새로고침 후 active command 복구와 terminal 완료 추적을 검증한다. 이는 브라우저와 API 계약 회귀이며 실제 BLE Mesh 전송 검증이 아니다.
- 최근 명령의 전체/처리 조명 수와 조명별 실패 또는 timeout 사유를 표시한다.
- 대상 picker의 `개별/다중`, `층`, `구역` 버튼으로 제어 모드를 전환하고 각 모드에서 실제 전송 대상을 선택한다.
- 백엔드는 SiteAccess `manage` 권한이 있는 assigned customer admin만 해당 현장의 fixture 또는 group을 제어 대상으로 허용하며, 미배정 또는 다른 고객사 현장은 `404`로 숨긴다. operator는 customer shell과 고객 Site capability를 갖지 않는다.
- `viewer` 권한 사용자는 배정 현장을 조회할 수 있지만 조명 제어 명령 생성은 `403`으로 거부한다.
- 사용자 역할은 service-provider `operator`, customer `admin`, 조회 전용 `viewer` 세 가지다. customer control은 assigned admin의 SiteAccess `manage` 범위로 한정되고, viewer는 화면 비활성화와 API `403` 양쪽에서 변경이 차단된다. operator는 전용 shell로 customer control을 mount하지 않는다.
- `GET /sites/:siteId/fixture-groups`, `POST /sites/:siteId/fixture-groups`, `PATCH /sites/:siteId/fixture-groups/:groupId`, `DELETE /sites/:siteId/fixture-groups/:groupId`, `POST /sites/:siteId/fixture-groups/:groupId/resync`를 제공한다. 목록은 read 권한의 viewer도 볼 수 있고, 생성·수정·삭제·재동기화는 assigned admin만 수행한다.
- 제어 화면의 `구역 관리` dialog에서 assigned admin은 같은 층·gateway의 조명 1~100개를 선택해 저장 구역을 생성·수정하고, 확인 후 삭제하거나 실패한 Mesh 설정을 재동기화할 수 있다. viewer는 동일 dialog에서 lifecycle과 Mesh 상태만 조회한다.
- 대상 picker는 층과 저장 구역의 `Mesh 설정 중`, `Mesh 설정 실패`, `제어 준비 완료` 상태를 표시한다. 층은 포함 조명의 모든 gateway별 Mesh group metadata가 존재하고 `ready`일 때만 선택할 수 있으며, 하나라도 누락되거나 준비되지 않으면 fail-closed한다.
- 저장 구역 생성·수정은 이름, 한 floor, 한 gateway와 1~100개의 unique fixture 전체 set을 입력으로 받는다. transaction은 기존 group, floor, gateway, fixture ID 순으로 잠가 같은 조명의 active/retiring 사용자 구역 15개 한도를 직렬화하고, mesh node가 없거나 선택 경계를 벗어난 fixture를 거부한다.
- 저장 구역 변경은 `GroupFixture`와 `MeshControlGroupMember.desired`를 전체 교체하고 configuration version을 증가시켜 `configuring`으로 전환한다. provisioning 중 configuring group에 새 desired member가 실제 삽입되는 경우도 version을 증가시켜 이미 발행된 이전 ACK를 stale로 무시하고 새 expected operation set으로 자동 수렴한다. 중복 member attach는 version을 바꾸지 않는다.
- foundation migration에서 active로 판정됐지만 MeshControlGroup이 없던 legacy 구역은 update/delete/resync transaction이 group을 생성해 복구한다. resync는 기존 `GroupFixture`의 controllable node를 새 desired set으로 복원한 뒤 version을 증가시킨다.
- PATCH에서 gateway 변경은 전체 replacement로 정의한다. 이전 gateway의 MeshControlGroup은 version을 증가시킨 빈 desired set과 `retiring` 상태로 남겨 subscription cleanup을 계속하고, 새 gateway에는 별도 MeshControlGroup과 전체 desired set을 구성한다. 이전 cleanup ACK는 active FixtureGroup을 retired로 바꾸지 않으며 과거 dispatch 참조도 보존한다.
- 삭제는 과거 `CommandDispatch`의 MeshControlGroup 참조를 보존하는 soft delete다. FixtureGroup은 `retiring`, member desired set은 빈 배열, MeshControlGroup은 `retiring`이 되며, 기대한 모든 Delete operation의 exact ACK가 성공할 때만 두 group 모두 `retired`가 된다. publish 실패, gateway 재시작 또는 ACK 실패에는 같은 version/set을 계속 재발행하며 resync는 version만 증가시킨다.
- gateway reconnect resync는 `configuring/ready/failed`를 새 `configuring` version으로 재발행하고 `retiring`은 `retiring`을 유지한다. member의 이전 `operationId/operation`과 version 진행 상태를 초기화하고 새 version plan에 fresh operation ID를 발급한다. `first_run/state_missing/state_corrupt`는 영속 full-state reconciliation을 설정해 active/configuring은 모든 desired pair를 Add로 재확인하고 retiring은 cloud applied snapshot의 모든 pair를 Delete한다. exact ACK가 현재 version을 수렴시킨 뒤에만 full-state flag를 해제하며, 일반 `startup` resync는 미완료 flag를 지우지 않는다. `retired`는 조회·version 증가·member reset에서 제외해 다시 활성화하지 않는다.
- gateway A에서 B로 이동한 뒤 B 삭제가 진행 중이어도 지연된 A cleanup ACK는 FixtureGroup의 현재 gateway ownership과 다르므로 lifecycle을 `retired`로 바꾸지 못한다. 현재 owning gateway의 MeshControlGroup이 빈 applied set으로 수렴한 ACK만 soft delete를 완료한다.
- legacy `invalid`와 `retiring`/`retired` 저장 구역은 일반 명령 target과 exact-set mesh group 승격에서 제외한다. invalid/retired는 읽기 전용이며, 아직 retiring인 구역은 subscription 정리 완료 전 제어할 수 없다.
- dashboard는 active 저장 구역에 lifecycle, floor/gateway, fixture count, MeshControlGroup status/version/error를 제공하고 층에도 gateway별 MeshControlGroup 상태를 제공한다. Web은 `ready`가 아닌 층·저장 구역을 제어 picker에서 비활성화하며 retired/invalid 구역은 dashboard 제어 target에 포함되지 않는다.
- 비접근 site의 저장 구역 요청은 query/body 형식 검증보다 SiteAccess를 먼저 수행해 malformed 입력이어도 일관된 `404` 경계를 유지한다.
- 저장 구역 생성·수정·삭제의 에너지 차원 이력은 필수 `EnergyDimensionHistoryService` 의존성으로 같은 transaction 안에서 기록한다. PostgreSQL `pg_advisory_xact_lock()`은 반환값이 필요 없는 `$executeRaw`로 실행해 `void` 결과를 Prisma가 역직렬화하며 발생하던 구역 생성 HTTP 500을 제거했다. API DTO와 Prisma schema/migration은 변경하지 않았다.
- 테스트 데이터 조명도 공통 energy 서비스의 bulk identity/current dimension 보충을 거쳐 구역에 사용할 수 있다. 1,000개 신규·반복은 energy DB 호출 5회·3회이며 동일 version을 중복 생성하지 않는다. cleanup은 fixture 잠금 뒤 분석·membership 의존성을 확인한다. 잠금 대기 중 analytics 발생 시 `409`를 transaction ordering 회귀로 검증했으며 실제 PostgreSQL 동시 실행은 미검증이다.
- API command/scan outbox worker는 initial·interval batch의 transient DB 실패를 scheduler 경계에서 격리해 API process를 유지하고 다음 tick에서 회복한다. 각 batch와 Mesh group sync는 single-flight이며 종료가 시작되면 다음 record/group publish를 시작하지 않는다. `MqttShutdownCoordinator` 하나가 command/scan outbox와 `MeshGroupSyncWorker`의 멱등 `stopAndDrain()`, inbound MQTT listener 분리와 진행 중 handler drain을 모두 완료한 뒤에만 MQTT client close를 시작한다. Mesh subscription sync와 inbound application ACK는 PUBACK이 없으면 10초에 해당 packet ID를 취소하므로 drain이 무기한 대기하지 않으며, timeout rejection은 payload·topic·오류 상세를 남기지 않는 최상위 오류 경계에서 격리한다. 이후 close는 MQTT.js graceful `end` callback을 await하고 5초 안에 완료되지 않으면 force close callback을 추가 1초간 기다린 뒤 종료를 계속한다.
- 제어 생성은 `(siteId, requestedBy, clientRequestId)`와 안정 정렬한 target·brightness fingerprint로 멱등 처리한다. 동일 요청은 기존 command를 반환하고 다른 payload는 `409 client_request_id_payload_conflict`로 거부하며, 동시 unique 충돌은 새 transaction 재조회로 수렴한다. Web은 네트워크 오류·5xx·응답 유실에서만 같은 요청의 재전송을 제공하고, 4xx 확정 거부는 pending 요청을 제거해 UI를 즉시 잠금 해제한다. 전송 중 사용자·현장 전환 시 기존 요청을 abort하고 generation/scope가 다른 지연 성공·실패 결과를 현재 화면에 반영하지 않는다.
- `viewer`가 제어 화면에 진입하면 읽기 전용 안내를 표시하고 밝기 슬라이더, 프리셋, 대상 선택과 `밝기 적용` 버튼을 모두 비활성화한다. 이 경우 브라우저는 `POST /commands/dimming`을 보내지 않으며 권한 오류를 장비 장애로 오인하지 않는다.
- Task 9 격리 실백엔드 Chromium E2E는 assigned admin이 개별, 임의 다중, 층, 저장 구역 밝기 명령을 production command API로 전송하고 test-support software simulator가 MQTT acceptance/device-status ACK와 fixture-state를 반환해 각 명령이 terminal 상태로 수렴하는 것을 검증했다. simulator는 lab CA의 `CN=Gateway.id` client certificate와 own-gateway topic ACL을 사용하지만, production Gateway 인증서 발급·bootstrap·배포 ACL 또는 실제 BlueZ/RF 전송을 검증한 것은 아니다. operator는 customer route를 mount하지 않고 viewer는 읽기 전용이다.
- RealBackendLab Chromium E2E는 매 실행마다 격리 PostgreSQL·Redis·mTLS Mosquitto와 production Web/API/Gateway를 시작한다. Admin UI로 schedule 40%, vehicle event 80%, manual 60%를 전송하고 현재 event와 schedule의 억제, 다음 event 80%→60%, 다음 daily occurrence 40%→60%를 검증한다. `createSchedule`의 caller-supplied Date와 Asia/Seoul private clock이 같은 경계를 사용한다. Production Gateway execution을 독립 canonical hash·API exact ACK·DB row·producer PID·source FK로 결속하고 durable telemetry outbox records 0/gap false까지 확인한다. Baseline 복귀 telemetry는 종료된 rule/occurrence를 원인으로 보존한다. Sensor edge와 clock은 token 검증 private IPC만 사용하며 public simulator endpoint나 직접 자동화 state 변경은 없다. 실행 결과는 [수동 기본 밝기 계획](../superpowers/plans/2026-09-14-manual-baseline-control.md#task-6-실행-증거)에 기록한다.
- Task 19 simulator는 `NODE_ENV=test`와 `AUTOMATION_E2E_SIMULATOR=1`이 동시에 있을 때만 생성된다. production에서 활성화를 요청하면 정확히 `software automation simulator is forbidden in production`으로 즉시 실패하고, 일반 `scripts/dev.mjs`도 simulator 환경을 거부한다. E2E도 production identity store 검증과 certificate rotation startup을 유지해 실제 mTLS certificate로 연결하지만, 유효한 사전 발급 certificate를 사용하므로 bootstrap 재발급/rotation 갱신과 실제 BlueZ/RF는 검증하지 않는다. Production 기본 adapter 경로는 계속 BlueZ를 사용하며 software E2E를 Raspberry Pi/ESP32-H2 HIL 완료로 간주하지 않는다.
- 백엔드는 조명의 gateway 매핑, gateway 90초 heartbeat, fixture online/fault 상태를 명령 생성 전에 검증하며 하나라도 제어할 수 없는 그룹 전체를 거부한다.
- 제어 화면은 서버의 `controllable`, `controlBlockReason`에 따라 대상 선택과 `밝기 적용`을 차단하고 미매핑, gateway offline, fixture offline/fault 사유를 한국어로 표시한다.
- 초기 데이터가 없으면 loading 또는 empty state를 구분해 표시한다. 기존 캐시가 있는 상태에서 dashboard 백그라운드 갱신이 실패해도 제어 화면과 캐시 데이터를 유지한다.
- 그룹 제어 명령은 MQTT payload에 `targetFixtureIds`를 포함해 게이트웨이가 실제 대상 조명 목록을 바로 처리할 수 있게 한다.
- MQTT `command-ack` 이벤트가 command 상태를 갱신한다.
- Raspberry Pi gateway 앱 골격이 `sites/{siteId}/commands/dimming` MQTT 명령을 수신하고 ACK, fixture state, heartbeat를 발행한다.
- ESP32-H2 펌웨어는 PlatformIO 대신 ESP-IDF 구조로 작성하며, LEDC PWM 기반 밝기 적용 골격을 제공한다.
- ESP-IDF `v5.5.1` + `esp32h2` 환경을 로컬에 구성했고 `scripts/esp32-h2-build.sh`로 실제 펌웨어 빌드를 통과했다.
- 게이트웨이 smoke test 스크립트(`pnpm gateway:smoke`)는 mTLS와 gateway-scoped v2 명령, acceptance/device-status ACK 흐름만 검증한다.
- ESP32-H2 실제 보드 플래시 절차와 라즈베리파이 게이트웨이 로컬 실행 절차를 문서화했다.
- ESP32-H2 펌웨어는 Health Server, Generic OnOff Server, Light Lightness Server를 제공한다. provisioning 및 gateway startup 보정 시 세 Server model에 AppKey bind와 provisioner 주소 60초 publication을 응답으로 확인한다. ESP-IDF publication update callback은 OnOff/Lightness publication buffer만 실제 상태로 갱신하고, 전송은 Mesh stack 자동 publication에 맡겨 중복 송신하지 않는다.
- ESP32-H2 펌웨어는 BLE Mesh Health Attention 이벤트를 250ms identify 점멸로 처리하고 종료 시 원래 밝기로 복원한다. Health fault test/clear와 watchdog fault 기록도 펌웨어 경계에서 구현했다.
- ESP32-H2 펌웨어는 active-low GPIO를 8초간 누르면 앱 NVS와 BLE Mesh credential을 지우고 재부팅하는 물리 factory reset을 수행한다.
- Gateway adapter 계약을 fixture별 장비 리포트 기반으로 확장해 일부 노드 실패 시 command ACK와 fixture state가 함께 동기화되도록 했다.
- Raspberry Pi gateway는 BlueZ 5.82 D-Bus application, network 생성/attach, fixture-unicast 영속 mapping, acknowledged Light Lightness Set/Status adapter를 양산 경로로 사용한다.
- 실제 조명 Status 수신 전에는 제어 성공으로 처리하지 않으며 mapping 없음, status 불일치, timeout을 fixture별 실패 코드로 반환한다.
- ESP32-H2 등록 후 AppKey 0 추가, Health Server `0x0002`, Generic OnOff Server `0x1000`, Light Lightness Server `0x1300` bind와 provisioner 주소 60초 publication을 설정한다.
- Docker appliance는 Raspberry Pi 실제 HCI에서 mesh network 생성과 token 재시작 attach를 통과했다.
- API와 gateway의 legacy MQTT v1 dimming, fixture-state, command-ack, heartbeat 경로를 제거하고 gateway-scoped MQTT v2만 사용한다.
- 양산 gateway에 mock, stub, shell command adapter를 포함하지 않는다. 자동 테스트 adapter는 `apps/gateway/test`에만 둔다.
- 수동 명령은 현재 단일 gateway `CommandDispatch`로 만들고 gateway 독립 sequence와 idempotency key를 발급한다. 여러 gateway에 걸친 논리 target은 후속 fan-out 설계 전까지 생성하지 않는다.
- Command, gateway별 dispatch, 조명별 pending 결과, MQTT outbox를 하나의 DB transaction에 저장한다.
- MQTT outbox publisher가 PostgreSQL `FOR UPDATE SKIP LOCKED`와 30초 worker lease로 다중 API 인스턴스의 중복 발행을 차단한다.
- Publisher는 strict draft/full 저장 payload를 모두 처리하되 full payload의 과거 `expiresAt`만 제거한다. Mesh snapshot 검증 직후 fresh clock으로 현재 worker의 유효 lease만 30초 연장하고 payload는 아직 수정하지 않는다. Final ownership query가 반환된 뒤 fresh clock으로 준비 lease가 20초 MQTT timeout 전체를 엄격히 덮는지 확인한 다음 새 expiry를 만들고 즉시 발행한다. Full payload와 `publishedAt`은 MQTT 성공 transaction에서 함께 저장한다. Timeout 시 해당 message ID를 outgoing store에서 제거하며 backoff/dead-letter 시각도 실제 실패 시각을 사용한다.
- Pending timeout은 active lease를 조회 결과에서 추정하지 않고 transaction에서 미발행 outbox row를 먼저 dead-letter 선점한다. Outbox가 없거나 active lease가 있으면 fail-closed하고, 선점 뒤 Dispatch 경쟁을 잃으면 transaction을 rollback한다. Published/accepted timeout은 outbox 선점 없이 기존 조건부 종료를 유지한다.
- Mesh group outbox는 발행 직전 현재 group의 ID, gateway, 주소, 구성 버전, `ready` 상태가 명령 생성 snapshot과 같은지 다시 검증한다. 같은 버전의 `configuring`은 재시도하고 삭제·실패·버전/주소/gateway 불일치는 MQTT로 보내지 않고 `MESH_GROUP_STALE`로 즉시 실패 처리한다.
- broker 전송 실패에는 지수 backoff와 jitter를 적용하며 최대 10회 또는 15분을 넘으면 outbox를 dead-letter 처리하고 dispatch, 조명별 결과, 상위 명령을 실패로 종료한다.
- API timeout worker는 미발행 명령 15분, MQTT 발행 후 acceptance 10초, acceptance 후 장비 상태 30초 deadline을 적용하고 종료되지 않은 명령을 `timed_out`으로 확정한다.
- gateway는 v2 dimming command를 로컬 `0600` journal에 먼저 기록한 뒤 acceptance ACK를 보내고, BLE Mesh adapter 결과 후 fixture별 device-status ACK를 보낸다.
- 동일 idempotency key의 최종 결과가 journal에 있으면 실제 조명을 다시 제어하지 않고 기존 ACK를 재발행한다.
- Broker가 명령을 받은 직후 API 프로세스가 종료되면 outbox에는 기존 draft/full payload와 lease만 남아 재시도될 수 있다. 이 at-least-once 경계에서 Gateway journal이 동일 idempotency key의 BLE 재실행을 차단한다.
- API는 gateway/site/command/dispatch identity가 모두 일치하는 ACK만 반영한다. rejected acceptance는 같은 transaction에서 dispatch, 남은 조명별 결과, 상위 Command를 failed로 종료하며, acceptance 발행 뒤 만료된 rejection도 `accepted` dispatch를 같은 terminal 상태로 닫는다. terminal dispatch의 늦은 ACK는 무시한다.
- API는 `device-status ACK` 처리 transaction에서 active dispatch와 해당 `CommandFixtureResult` 전체를 먼저 잠근다. ACK의 fixture ID 집합은 dispatch snapshot과 개수까지 정확히 같아야 하며 누락·중복·외부 fixture는 `ack_fixture_set_mismatch`로 전체 dispatch와 fixture 결과를 실패 처리한다. 개별 결과에서 유도한 상태는 모두 성공 `succeeded`, 모두 timeout `timed_out`, 성공이 포함된 혼합 `partially_succeeded`, 성공 없이 실패가 포함된 결과 `failed`이며 ACK status가 다르면 `ack_status_mismatch`로 fail-closed한다. 검증이 끝나기 전에는 개별 결과를 부분 반영하지 않는다.
- BLE Mesh fixture status는 기본 8초 timeout을 적용하고 adapter가 반환하지 않아도 fixture별 `timed_out` 결과로 명령을 종료한다.
- Gateway 재시작 후 accepted-only 명령은 실제 조명을 다시 제어하지 않고 `indeterminate after gateway restart` timeout 결과로 닫는다.
- Gateway journal은 idempotency 결과를 24시간·최대 10,000건만 유지한다. restart resync는 journal 추정값을 상태로 발행하지 않고 확인된 node에 OnOff/Lightness/Health Get을 보내 실제 응답만 fixture-state로 반영한다.
- Gateway startup state는 OnOff, Lightness, Health Current가 같은 관측 generation의 65초 window 안에 모두 확인될 때만 제어 화면과 API에 새 snapshot으로 반영한다. Health Current가 아직 오지 않았거나 한 model만 갱신된 경우에는 기존 상태를 보존한다.
- Health Current fault code는 MQTT v2 구조화 payload와 `Fixture` 최신 snapshot으로 저장된다. API는 fault가 하나라도 있는 조명을 `fixture_fault`로 제어 차단하고, 제어 목록은 각 조명을 `Health 정상`, `Health 장애`, `Health 확인 대기`로 표시한다. Health가 없는 명령 결과 이벤트는 확인된 최신 Health snapshot을 지우지 않는다.
- gateway health artifact는 startup resync의 `total/configured/observed/healthPending/timedOut/failed`를 `meshResync`로 기록한다. `observed`는 같은 generation의 OnOff/Lightness 실제 pair 기준이며, Health Current는 이후 publication까지 pending으로 보존한다. lighting pair 전체 실패만 unhealthy로 유지되어 제어 가능 상태를 heartbeat만으로 잘못 회복하지 않는다.
- Gateway는 assignment의 gateway ID 기반 MQTT 5 persistent session으로 QoS 1 command subscription을 유지한다. Outbox는 실제 MQTT publish 직전에 `expiresAt`을 API의 10초 acceptance deadline 기준으로 계산해 DB payload에 기록하고, 같은 기준의 10초 MQTT message expiry를 설정한다. Gateway는 `requestedAt`이 아니라 `expiresAt`을 사용하며, 최대 2초 느린 gateway clock도 deadline 이후 BLE를 실행하지 않도록 acceptance ACK 뒤 BLE 직전에 다시 만료를 검사한다. BLE 실행 또는 장비 상태 관측이 없었던 만료/불확정 결과는 fixture-state와 journal의 최신 실제 관측을 갱신하지 않아 기존 실제 상태를 보존한다. Production broker는 gateway별 최대 100개 또는 1 MiB QoS 1 queue를 유지하므로 이 한도를 넘는 offline 명령은 보장하지 않는다. API의 global event consumer는 deployment instance ID가 포함된 고유 client ID를 쓰되 clean session으로 연결한다.
- `MeshControlGroupService.ensureFloorGroup/ensureFixtureGroup`은 호출자 transaction 안에서 gateway row를 잠그고 기존 group을 재사용하며, 증가 전 `Gateway.nextMeshGroupAddress` 값을 실제 group address로 예약한다. 새 group은 `configurationVersion = 1`로 시작한다. 대상이 다른 site에 있으면 거부하고 `0xFF00` 이상이면 명시적 소진 오류를 반환한다.
- `RegistrationService.registerBatch`는 provisioning publish 전에 층 control group을 선확보하고, provisioning 완료 transaction은 floor group과 기존 `FixtureGroup` membership의 control group member를 idempotent하게 연결한다.
- 새 member가 실제로 추가되면 기존 group이 `configuring`, `ready`, `failed` 중 어느 상태여도 `configurationVersion`을 1 올리고 group을 `configuring`으로 전환하며, 해당 group의 전체 member를 `pending`, `statusVersion = 0`, `operationId/operation = null`, `lastError = null`로 초기화한다. `appliedVersion`은 마지막 성공 이력으로 보존한다.
- `MeshControlGroupService.getReadyDestination`은 floor/fixture-group과 gateway site 경계를 확인한 뒤 `ready` group의 ID, address, configuration version을 반환하고, 아직 준비되지 않은 target은 `mesh control group is not ready`로 거부한다.
- control group member 추가와 subscription ACK 반영은 둘 다 group row를 먼저 잠그는 같은 순서로 직렬화해 중복 member attach, version 이중 증가와 group/member 교착 경계를 줄인다.
- 기존 fixture가 다른 층에 이미 연결돼 있으면 provisioning 완료는 `fixture is already assigned to another floor` 오류로 실패시키고, 자동 재배치나 잘못된 floor group attach를 허용하지 않는다.
- Gateway는 `unicast`, 동시성 8의 `parallel_unicast`, `mesh_group` delivery mode를 실제 BlueZ BLE Mesh 경로로 분기한다. 병렬 unicast와 group 경로는 queue 획득 뒤, TID 할당 뒤, BlueZ 호출 직전에 중단 여부를 재확인해 timeout 이후 새로운 RF 전송이 시작되지 않게 한다.
- `mesh_group`은 group address에 Light Lightness Set Unacknowledged를 정확히 한 번 전송한 뒤, 명령 snapshot의 각 fixture primary unicast에서 오는 실제 Lightness Status를 집계한다. 주기 publication의 이전 상태를 최종 결과로 즉시 확정하지 않고 목표 Lightness와 일치하는 Status를 기다리며, 제한 시간까지 일치하지 않으면 마지막 실제 관측값을 `state_mismatch`, 응답이 없으면 `timed_out`으로 확정한다.
- Gateway 명령은 주소 조회, queue 대기, TID 저장, BlueZ 전송과 Status 수집 전 구간에 하나의 절대 deadline을 적용한다. 내부 Status 수집 종료 뒤에는 250ms 비상 grace만 허용해 확정된 `state_mismatch` 결과를 보존하고 deadline 이후 신규 RF 송신을 차단한다.
- Mesh TID는 목적지별 독립 순환을 보장하는 v2 형식으로 저장하며 기존 v1 파일은 자동 마이그레이션한다. 최대 1,000개 목적지의 다음 32개 TID 블록을 한 번의 원자 저장으로 예약하고, 저장 실패 시 TID를 발급하지 않으며 재시작 시 미사용 예약분을 건너뛴다.
- 명령 결과 뒤 fixture-state는 실제 ACK 또는 `state_mismatch` Status가 관측된 조명만 발행한다. 부분 timeout 또는 전송 실패 조명을 임의의 0%·꺼짐·fault 상태로 덮어쓰지 않는다.
- Gateway는 group ID/address/version별 `configuring | ready | failed` 상태를 임시 파일 저장, 파일 fsync, rename, 디렉터리 fsync 순으로 영속화한다. 첫 subscription 요청 전에 `configuring`을 저장하고 전체 member 결과가 정확히 일치한 경우에만 `ready`를 저장한다. 같은 group의 sync/control은 직렬화하고 다른 group은 병렬 실행한다.
- Gateway 재시작 시 정상적인 durable group state는 그대로 복원한다. state 파일이 없거나 state/manifest revision이 다르거나 손상됐을 때는 로컬 applied membership을 신뢰하지 않고 빈 상태로 fail-closed하며, 같은 `eventId`의 `first_run/state_missing/state_corrupt` resync 요청을 영속화한다. API는 resync DB transaction commit 뒤 inbound QoS 1 `PUBACK`을 먼저 반환하고, 같은 MQTT parser가 outbound QoS 1 callback을 처리할 수 있게 된 뒤 추적 중인 handler에서 애플리케이션 ACK를 발행한다. Gateway는 이 ACK의 `requestEventId`를 확인할 때까지 재시작·재연결·heartbeat에서도 요청을 재전송한다. API는 cloud applied snapshot을 삭제하지 않고 full-state Add와 retiring Delete 근거로 사용하며, gateway는 성공 결과를 새 durable membership snapshot으로 원자 저장한다. cloud에도 gateway에도 남지 않은 미확인 물리 subscription address는 자동 복구할 수 없으므로 HIL/운영 감사 위험으로 남긴다.
- MQTT command subscribe 실패는 현재 연결에서 최대 30초 backoff로 재시도한다. 직전 SUBACK가 실패했다면 persistent session 재연결의 `sessionPresent`와 관계없이 command 및 resync ACK topic을 강제 재구독한다. subscription 결과에 member 누락, 중복 또는 미등록 node가 있으면 group을 `failed`로 저장한다.
- ESP32-H2 primary element는 Presence Detected Sensor Server와 Task 14 공통 Company ID의 vendor event server를 제공하며, 지원하지 않는 Sensor Setup Server는 composition에서 제거했다. Descriptor/Get/Column/Series는 공식 Status 의미로 응답하고 Sensor Get/주기 Status는 매번 Task 15 driver current를 읽는다. Gateway가 stack period를 0으로 설정해 custom worker의 `60s + FNV-1a(primary unicast) % 5000ms`만 동작한다. Vendor payload는 version, per-boot random `bootId`, 1부터 증가하는 uint32 sequence, detected/cleared와 exact level의 11바이트 계약이다.
- 센서 event는 16개 static pending slot에서 event별 initial publish와 250ms, 500ms, 1s, 2s, 4s, 8s의 6회 retry마다 실제 transport API를 호출한다. Exact bootId/sequence ACK만 slot을 제거하고 duplicate/out-of-order ACK는 무시한다. Completion callback 유실·지연·중복은 pending, retry, fault에 영향을 주지 않는다. Queue full은 current GPIO recovery를 예약하며 dropped/retry exhausted/send/unconfigured/sequence exhausted를 Health fault에 기록한다. Driver callback은 BLE API와 log 없이 static model worker에만 nonblocking handoff한다.
- ESP32-H2는 group Light Lightness Set Unacknowledged를 PWM에 즉시 반영하고 primary unicast 기반 `64~5,179ms` 결정적 지터 뒤 실제 Lightness Status를 publication한다. `(source, destination, TID)` 6초 cache가 중복 적용과 publication 재예약을 막는다.
- 펌웨어의 모델별 group subscription 상한은 16개이며, 서비스 계약은 조명 한 대당 층 group 1개와 사용자 fixture group 최대 15개다. API도 provisioning member 연결 시 같은 사용자 group 상한을 검증한다.

- 2026-09-26 Gateway Set 수신 경계: `GATEWAY_COMMAND_EPOCH_CUTOVER=1`에서 현장/Gateway scope, publish epoch 및 DB 시각 증거를 수신·group queue dequeue·journal 수락 직전·fsync/accepted ACK 이후에 재검사한다. 유효한 동일 epoch 증거로 확인한 만료와 상대 receipt TTL 소진은 `COMMAND_EXPIRED`, scope/epoch/증거 거부는 `GATEWAY_CLOCK_UNTRUSTED`로 기록한다. 최초 거부를 journal의 첫 원자 저장부터 terminal로 보존하고 DUP에 같은 ACK를 재생한다. 24시간 journal 정리 뒤 DUP도 다시 검증해 RF를 차단하며 로컬 journal의 기존 보관기간은 바꾸지 않는다. `prepare` 전 거부는 RF·자동화 handoff·fixture-state 성공을 만들지 않고 legacy accepted-only 또는 RF 시작 가능 기록의 재시작은 기존 불확정 결과를 보존한다. cutover 전 legacy Set, Get/status-check, 로컬 자동화는 기존 정책을 유지한다. 어댑터의 각 native write 직전 차단과 보수적 배수 응답(Task 6)은 소프트웨어 구현·자동 검증을 완료했으며, 물리 RF 종료·취소 및 submit→RF 상한을 확인하는 Pi/BlueZ/BIO HIL, 운영 DB-host attestor와 운영 cutover는 별도 출시 관문으로 남아 있다. 따라서 cutover·운영 purge·복구 POST는 OFF를 유지하며, 중앙 보존 정책은 모든 현장에 최근 3 calendar months만 적용한다. 관련 구현은 `apps/gateway/src/index.ts`, `commands/gateway-command-handler.ts`, `commands/command-journal.ts`, `commands/db-clock-proof.ts`다.

- 2026-09-27 Gateway 수동 prepare 취소: cutover Set은 journal 수락에 `pre_rf`, adapter 호출 전에 `may_have_written`을 각각 fsync한다. RF 이전 거부는 terminal 결과와 abort intent를 원자 저장하고 `abortManualControl(sourceId, fixtureIds)`로 저장된 원본 source/fixture에 일치하는 pending 수동 제어·transition만 해제한 뒤 abort 완료를 저장하고 ACK를 반환한다. prepare·terminal 저장·abort·완료 기록 경계에서 재시작해도 재생은 멱등이며 다른 명령, 기존 기본 밝기, 관측 상태를 변경하지 않는다. `pre_rf` 재시작은 `GATEWAY_CLOCK_UNTRUSTED`로 거부하고 로컬 일정·센서 실행을 다시 허용하지만, RF 시작 가능 단계와 legacy accepted 기록은 미적용으로 단정하거나 abort하지 않는다. 변조된 DUP와 journal 수락 경합도 저장된 원본 대상으로 취소를 완료한 뒤 같은 terminal을 재생한다. 구현·재시작 테스트는 `apps/gateway/src/automation/schedule-runtime.ts`, `commands/gateway-command-handler.ts`, `commands/command-journal.ts`, `index.ts`와 대응 테스트에 있으며 실제 RF/HIL·운영 cutover는 아직 검증·활성화하지 않았다.

- 2026-09-26 Gateway Set DUP 순서 보완: 수신 시 시각/epoch 거부가 결정되어도 동일 그룹 queue를 통과한다. 원본 RF가 진행 중이면 기존 accepted 기록을 재시작 잔여 명령으로 오인해 `timed_out`이나 자동화 handoff를 먼저 만들지 않고, 원본 완료 뒤 같은 terminal 결과를 재생한다. RF 재실행은 없으며 수신 시 거부 판정도 queue 대기 중 새 증거로 해제하지 않는다. 2026-09-27에는 journal instance·idempotencyKey별 진행 중 Promise를 첫 비동기 저장 전에 등록해 unicast를 포함한 모든 delivery mode에 이 순서를 적용했다. 원본 prepare가 진행 중인 DUP는 완료를 기다린 뒤 durable 결과를 읽으며 다른 key 또는 다른 journal의 명령은 병렬 실행한다.

- 2026-09-27 수동 prepare 취소의 저장 실패 보완: abort는 일반 로컬 제어의 ENOSPC 메모리 대체 저장을 사용하지 않고 영속 저장을 요구한다. 저장 실패 시 journal abort intent를 유지하고 terminal ACK를 반환하지 않아 재시작 후 정확한 취소를 다시 수행한다. 별도로 관측되지 않은 desired 밝기가 0%여도 기존 observation fence를 유지한다. 실제 gap journal·headroom 설정의 ENOSPC 주입과 새 runtime/journal 복구로 검증했으며 운영 cutover·purge는 계속 OFF다.

- 2026-09-27 API clock 거부 ACK 귀속: `GATEWAY_CLOCK_UNTRUSTED`는 site/Gateway/Command/dispatch/key/sequence가 일치한 새 Set의 terminal 사전 RF 거부로만 반영한다. `accepted`와 동시에 온 clock 오류, Get/status-check에 온 Set 전용 clock 거부, 이미 `unknown`인 명령의 늦은 clock 거부는 명령·조명 상태를 확정하지 않는다. `COMMAND_EXPIRED`의 기존 terminal 처리는 유지한다. 최근 이력 요약은 원본 Set의 전체 대상이 실패하고 outcome이 `not_applied`인 정확한 clock 거부에만 선택적 `errorCode`를 제공하며, 상세 조회는 기존 dispatch 오류 코드를 보존한다. 원본 삭제 뒤 늦은 RF 불확정 Set ACK와 Get-only 복구 실패는 hold/status-check 경로에 남고 자동 Set 재발행이나 성공 fixture 관측을 만들지 않는다. 해당 terminal clock ACK는 미발행 Set outbox도 같은 DB transaction에서 닫고, 기본/세대별 Set publisher는 native enqueue 직전 live dispatch를 잠가 재확인한다. 임시 PostgreSQL 두 연결의 ACK↔발행 경쟁과 PUBACK 유실 재획득 0건을 검증했지만 실제 Gateway RF/HIL 완료나 운영 purge/cutover 승인은 아니다.

- 2026-09-27 제어 이력의 시각 불신 거부 설명: 서버 이력의 선택적 `GATEWAY_CLOCK_UNTRUSTED` 코드가 `failed`·`not_applied`와 함께 온 경우에만 최근 이력과 이력 drawer에 조명 RF 전 거부 및 자동 재실행 없음 안내를 표시한다. `unknown`·부분 적용은 기존 확인 필요 진입과 상태 확인 경로를 유지하며, `COMMAND_EXPIRED` 표시는 바꾸지 않았다. 이력 범위는 계속 서버가 정의한 UTC rolling 3 calendar months이고 1년 보관 선택은 제공하지 않는다. Web 단위 테스트는 UI 표시와 GET 전용 경로를 확인한 소프트웨어 증거이며 실제 Gateway/조명 RF 검증은 아니다.
- 2026-09-27 제어 안전 UI 재검토 보완: 확인 필요 case 상세의 배경 재조회 중이나 404/500 실패 뒤에는 캐시 상세로 Get-only 상태 확인·위험 승인을 실행하지 않는다. 열린 위험 승인 폼도 닫고, 새 상세 조회가 성공해야 동작을 다시 제공한다. 정확한 시각 불신·전체 미적용·terminal 실패의 명령 상세에서는 Gateway 수신 이후 장비 응답을 미도달로 표시하고 조명 적용을 오류로 둔다. 일반 실패와 `COMMAND_EXPIRED` 단계 표시는 유지한다. Vitest/Chromium mock 검증은 실제 Gateway RF·운영 안전 인증을 대신하지 않는다.

## 미구현

- 완료된 오래된 Command 원본·파생 사본을 실제로 비우는 비식별 worker는 후속 작업이다. Task 2는 DB 상태 제약과 소비자 차단만 추가하며 기존 미확정 잠금·수동 Set·최근 상태 확인을 유지한다.

- BIO 센서 `0x09`의 detected/cleared boolean mapping, source capability `supported` 승격 및 production event 실행은 미구현이다. `0x0c`는 생존 관측이며 이벤트 입력이 아니다.

- 수동 제어의 현재 선택을 그대로 넘기는 `이 선택을 구역으로 저장` 단축 동작은 미구현이다. 현재는 `구역 관리 → 새 구역`에서 지도·목록으로 멤버를 선택해야 한다. 후속 구현에서는 다층/100개 초과 선택 처리, 생성 권한·명령 잠금, 열린 dialog의 초안 초기화와 focus 복귀, 저장 후 기존 수동 선택 보존을 함께 검증해야 하므로 최종 오류 수정 범위에서는 보류했다.

- 인체 감지, 외부 이벤트, 장면과 복합 조건 rule builder
- 수동 제어 이력 패널 외 독립 명령 이력 페이지
- 자동 Set retry, rollback, cancel
- 조명 on/off 전용 토글
- 위험 명령 확인 dialog
- gateway의 원격 `identify-device` 명령을 실제 BlueZ adapter의 Health Attention Set으로 전달하는 연결
- ESP32-H2 제품/진단 정보 report의 gateway/API 연동
- ESP32-H2 실제 보드 플래시 검증
- 실제 마이크로웨이브 센서의 전기 출력과 LED converter를 함께 연결한 전압·타이밍 HIL. 2026-09-04 시험은 ESP32-H2 GPIO4의 내부 pull만 전환해 firmware·BLE Mesh·Gateway·API·Web 전체 논리 경로를 검증했으며 센서/컨버터 전기 적합성 증거는 아니다.

## 부족하거나 개선이 필요한 기능

- Set epoch 발행 경계는 활성 세대·등록 worker·동일 DB primary의 시각 증거를 claim/prepare/attempt/publish마다 재확인하고, MQTT 전 `CommandPublishAttempt`에 절대 만료를 기록한다. Quiesce의 member ACK는 로컬 중지만 뜻하며 응답 없는 member를 시간 경과로 안전 처리하지 않는다. 원본 Command의 UTC rolling 3개월 cutoff와 Set 전용 permit을 적용하며, legacy status-check Get은 quiesce와 분리한다.
- 운영 DB-host attestor와 세대별 durable primary/step 연속성 제공자는 아직 없다. 새 API 프로세스는 이 증거 없이 ON Set을 발행할 수 없으며, 재시작을 가로지르는 시각 연속성은 아직 증명되지 않았다. Broker 구세대 admission 반롤백·Gateway/RF drain 및 parent-free recovery publisher의 전체 통합은 후속 게이트다. 운영 cutover, purge, recovery POST는 계속 OFF다.
- 확인 필요 case의 미해결 Hold는 기간이 지나도 먼저 조회하고 유지한다. 해결된 최소 요약만 중앙 DB 시각의 최근 UTC 3 calendar months를 상세 GET에서 보여 주며, 정확한 경계 행은 남긴다. 요약의 물리 sweep은 독립된 `RESOLVED_COMMAND_RECOVERY_RETENTION_ENABLED` 기본 OFF·운영 ON 거부 상태로, 일회용 PG에서만 회당 최대 1,000행·남은 backlog 로그를 검증했다. 목록 `generatedAt`은 표시용 API 시각이며 보존 cutoff가 아니다. DB-host 시계/failover 운영 증거와 migration 적용은 아직 없어 실제 삭제가 활성화된 것은 아니다. 일반 Command 원본 purge·HISTORY/RECOVERY_ACTIONS·복구 POST는 계속 OFF다.

- Set 전용 세대 mTLS egress는 준비 구현이며 `COMMAND_SET_EGRESS_ENABLED=0` 기본값에서 기존 Set/Get 발행을 유지한다. 전환 모드는 active DB member, wire `publishEpoch`, 일치하는 세대 인증서와 broker ACL이 없으면 Set을 거부하며 구 `api-service`로 우회하지 않는다. 원본 만료 전 Get과 recovery Get은 공유 연결을 계속 사용한다. 세대별 durable DB 시각 연속성, 전체 broker 반롤백·Gateway RF drain 증거는 후속 검증 사항이며 운영 cutover·purge·recovery POST는 OFF다. 관련 파일: `apps/api/src/mqtt/command-set-mqtt.service.ts`, `apps/api/src/mqtt/outbox-publisher.service.ts`, `scripts/dev-runtime.mjs`, `docs/runbooks/production-api-web-deployment.md`.

- Task 6 drain 카운터는 프로세스 메모리의 보수적 작업 현황이다. API/retention worker는 0건 응답이나 프로세스 재시작으로 초기화된 카운터를 물리 RF 종료 증거로 추론하면 안 된다. 응답 계약에는 물리 완료 인증 필드가 없고, 실장비 submit→RF 상한 측정·boot 세대/전체 subscriber 확인·broker fence가 필수다. Raspberry Pi/BlueZ/BIO HIL 미실행 상태이므로 cutover·운영 purge·복구 POST는 계속 OFF다.
- 자동화 전역 목록의 실제 현장 규모 사용성, 갱신 중 cursor 변화와 모바일 WebView는 추가 검증이 필요하다. 서버 cursor는 이전/다음 탐색만 보장하며 실시간 변경 중 고정 총 페이지 수나 임의 페이지 점프를 약속하지 않는다. 구 API 과도기 응답의 로드된 행 기준 수치는 현장 전체 집계가 아니다.
- 제어 세션 상태 센터 연계는 focused Vitest와 Web typecheck로 확인했으며 브라우저 E2E·실제 모바일 WebView 시각/조작 검증은 아직 완료 증거가 없다. 소프트웨어의 상태·재시도 표시와 실제 Gateway/Mesh 명령 적용·장애 복구 HIL을 구분해 검증해야 한다.

- BIO 센서 자극/회복 10-cycle 물리 HIL과 packet 의미 검토를 완료한 뒤, 별도의 production 통합 계획을 작성해야 한다. 현재 shadow evidence의 `readyForProtocolReview=true`는 protocol 검토 가능 여부일 뿐 `productionActivationAllowed=false`를 바꾸지 않는다.

- 수동 확인에 따른 즉시 제어 차단·새 presence/state 복구는 소프트웨어 검증 범위다. 물리 USB 동글과 조명 2대의 전원 차단/복구 HIL은 이번 작업에서 미수행이며, 실제 장비에서 모니터링 숫자·마커와 제어 가능 여부가 함께 바뀌는지 확인해야 한다.

- 모바일 두 손가락 확대·축소는 Web PointerEvent와 synthetic Chromium으로 검증했다. 실제 iOS/Android WebView의 safe area, gesture arbitration과 장시간 현장 사용성은 실기기 확인이 필요하다.
- 저장 구역은 fixture membership만 보존하며 polygon 경계는 저장하지 않는다. 맵의 영역 rectangle은 선택 도구이고 저장 데이터가 아니다.
- 스케줄·이벤트의 구역 선택은 저장 시점 fixture snapshot이다. 구역 멤버 변경은 기존 규칙에 자동 반영되지 않는다.

- 이번 제어 디자인 시스템 전환은 Chromium 자동 검증 범위다. Safari/Firefox, 실제 iOS·Android WebView의 segmented Date/Time 입력, safe-area와 OS별 focus ring은 수동 시각 QA가 추가로 필요하다. 제어 payload·API·Gateway 프로토콜은 변경하지 않았으며 실장비 HIL 완료 증거로 간주하지 않는다.

- capability 원장은 생성 후 365일보다 오래되고 현재 node revision과 watermark가 모두 해당 revision보다 높은 superseded 기록만 자동 정리한다. 최신 capability 보고는 보존하며 전체 이벤트 정리는 sweep당 합산 최대 10,000개다. scope/hash가 없는 legacy 원장이나 현재 node·watermark 안전 조건을 증명할 수 없는 기록은 남긴다. watermark는 최신 identity를 보존하고 임의 과거 ID의 exact dedupe는 raw 원장이 남아 있는 기간에 의존한다. 같은 worker의 heartbeat 7일·fixture state 30일 정책과 세부 조건은 [DB 보존 문서](../database-schema.md#운영-데이터-보존과-복구-범위)를 따른다. 사용자/운영 DB migration 적용과 Raspberry Pi/ESP32-H2 replay HIL은 미실행이다.
- 플랫폼 운영 배포 절차는 [API·Web runbook](../runbooks/production-api-web-deployment.md)을 따른다. 단일 호스트 Compose, 외부 Vault·공개 MQTT/Object Storage 연결, 장비 mTLS 공개 SAN, CRL 갱신 후 수동 broker SIGHUP, API 교체 후 nginx upstream 재해석·재시작이 운영 조건이다. Process-local 지표만 제공하며 외부 metrics/dashboard/alert/log shipping은 구성하지 않았다. 운영 배포·사용자 DB 적용·실장비 HIL과 native WebView·수동 시각 QA는 이번 자동 검증에 포함하지 않는다.

- 1440/390/320px 결과는 Chromium 자동 브라우저 software 증거다. 실제 iOS/Android native WebView, 수동 in-app 시각 QA, WebView safe-area 실측 또는 Raspberry Pi/ESP32-H2 HIL을 수행한 결과가 아니다. Lazy chunk 실패의 복구 UI는 플랫폼 Task 3에서 구현했으며, prefetch/offline cache는 후속 범위다. Task 3 오류 주입은 Vite에서 실제 앱 셸의 동적 import 요청을 차단한 deterministic Chromium 결과이며, 운영 CDN/container 배포나 실제 backend 장애·HIL 검증을 의미하지 않는다.
- 공통 우측 패널의 반응형·overflow 계약은 Chromium 1440/1024/390/320px route fixture로 검증했으며 실제 모바일 WebView safe-area와 브라우저별 scrollbar 표현은 별도 실측이 필요하다.
- 현재 개별 밝기 제어는 acknowledged Light Lightness Set을 한 번 전송하고 Status를 기다린다. 2026-09-03 HIL 4회 중 3회는 1~2초 내 성공했고 1회는 장치 적용 후 Status 한 패킷 유실로 timeout 됐다. 자동 Set 재전송 없이 후속 Lightness Get으로 실제 적용 여부를 확인하는 API·Gateway·웹 경로는 소프트웨어 구현을 완료했다. 해당 응답 유실 및 복구 경로의 실제 Raspberry Pi/BlueZ/ESP32-H2 HIL이 남아 있다.
- API/Gateway의 DB·journal 이후 PUBACK 계약은 자동화됐지만, API 종료·Gateway 종료·broker 재연결과 ESP32-H2 cold boot를 동시에 포함한 acceptance/device-status 중복 재전달 및 AppKey 복원은 실장비 전원 차단 HIL로 확인해야 한다.
- Automation full snapshot의 production MQTT publish, Gateway 원자 저장/hot reload/exact durable config ACK, Task 12 offline scheduler·priority arbiter, Task 13 execution outbox/application ACK와 Task 14 Sensor Client/vendor ACK 입력은 연결됐다. Snapshot activation과 production shutdown은 필요한 BLE Mesh terminal state/handoff, execution/capability queue와 in-flight QoS 1 publish를 순서대로 drain한다.
- Capability ACK의 필수 `reportPayloadHash`와 identity `vehicle-sensor-capability:<gatewayId>:<meshNodeId>:<eventId>:<reportPayloadHash>`는 cross-node eventId 충돌과 same-node altered payload를 원본과 분리한다. Exact report 재전달은 최초 payload/hash/`ingestedAt`을 유지하고 published/deadletter/expired lease delivery 상태만 재큐잉하며 live lease를 보호한다. 2026-09-03~04 Lab HIL에서 실제 Gateway 인증서·broker ACL로 capability revision 1과 Sensor/vendor binding, application ACK 및 후속 event 수신을 확인했다. Packet loss와 ACK exhaustion은 아직 실기하지 않았다.
- Task 14 Gateway Sensor/vendor client, Task 15 GPIO driver와 Task 16 ESP32-H2 model은 native exact wire/retry, production-source host fake와 patched ESP-IDF fullclean target build로 검증했다. 2026-09-04 단일 노드 HIL은 실제 RF의 정상 High/Low 경로까지 추가로 확인했다. device heap/queue 장기 부하, cache-disabled ISR stress, 실제 센서 전기 신호, packet loss와 전원 차단은 아직 증명하지 않았다.
- pending redirect와 네 가지 제어 target의 production API/MQTT ACK/state 경로는 Task 9 격리 실백엔드 software E2E로 검증했다. 실제 Raspberry Pi에서는 단일 BIO fixture의 개별·schedule 제어에 이어 2026-09-14 vendor USB virtual Mesh group 기반 층·구역 제어도 통과했다. 2026-09-15에는 Lab Ethernet 망 변경 뒤 서버/Pi endpoint와 TLS SAN·assignment를 복구하고 같은 Web session의 70%·0%·100%·30% 명령이 모두 `acknowledged/applied`, dispatch `completed`, fixture `succeeded` 및 요청 밝기 read-back으로 끝나는 것을 확인했다. 다중 BIO fixture와 표준 BlueZ/ESP32-H2 다중·층·구역 Mesh Group HIL은 아직 실행하지 않았다.
- `clientRequestId`와 payload를 보존하는 응답 유실 복구는 자동 테스트와 실제 Chromium 재로딩 흐름을 통과했다. 실장비 terminal ACK 왕복은 Raspberry Pi/ESP32-H2 HIL에서 확인해야 한다.
- Schedule API·Web CRUD, Gateway offline 실행, 차량 이벤트 Web CRUD와 수동 기본 밝기 제어를 구현했다. 종료 시각 입력과 변환은 제거했으며 event 목록·권한·source/target·capability 검증, auth/cache·접근성·scope reset 계약은 유지한다. RealBackendLab은 production API/Gateway와 실제 격리 DB/MQTT, 독립 execution hash/ACK/DB/outbox oracle를 검증한다. 현재 실행 결과는 아래 소프트웨어 검증 기록과 실행 계획을 따르며 bootstrap certificate 재발급과 실제 Raspberry Pi/BIO/BlueZ/ESP32-H2 HIL은 별도 후속 범위다.
- Final review P1 통합 fix의 RealBackendLab Chromium 검증은 non-persistent mTLS Mosquitto를 실제 재시작해 최초 Gateway 연결 전 publish `desired/applied 1/0→1/1`, 세션 소멸 재연결 revision 2, cloud 삭제 revision `2→3`, API session 소멸·재시작 revision `3→4`를 확인했다. 삭제 snapshot 적용 뒤 통제 clock을 3시간 전진해도 삭제 rule execution count는 `7→7`로 유지됐고, API가 없는 동안 config ACK는 broker PUBACK 뒤에도 Gateway outbox 1건으로 남아 API의 exact receipt 후 0건이 됐다. 이는 production API/Gateway와 software BLE simulator 검증이며 실제 RF/HIL 완료 증거는 아니다.
- 최근·과거 명령 검색/상세 재열기와 불확정 상태 확인·미적용 확인 후 재적용은 소프트웨어로 구현했다. 실제 Raspberry Pi/BlueZ/ESP32-H2 다중 조명·그룹 및 장애 주입 HIL은 별도 검증으로 남는다.
- 이번 P0/P1 software 검증은 status Get, chunking, 3회 제한, timeout single-flight/drain, durable journal replay, ACK `eventId`/hash dedupe, 이력/안전 재적용 UI를 자동 테스트로 확인한 범위다. 실제 다중 fixture·층 전체·저장 구역·Mesh Group, Raspberry Pi/ESP32-H2 전원 차단, MQTT broker 단절, Gateway 프로세스 강제 종료를 조합한 HIL은 모두 미실행이며 자동 테스트 통과로 완료 처리하지 않는다.
- P0/P1은 구버전 혼합 배포가 안전하지 않다. 구버전 API/publisher를 stop-and-drain하고 migration을 적용한 뒤 신규 publisher·Gateway·API ACK consumer의 준비를 확인해야 status-check producer/API와 UI를 활성화할 수 있다. 자동 테스트는 실제 DB partial index·concurrent ACK 경합이나 RF/HIL의 증거가 아니며, 발행 시도 기록 직후 MQTT 호출 전 crash는 보수적으로 `unknown`을 남긴다.
- Health Current는 최신 snapshot만 사용하며 fault 이력과 제품별 code 설명은 아직 제공하지 않는다.
- 이력·상세는 조회 계약을 사용하고 후속 상태 확인·재적용 버튼은 현장의 control capability와 세션 잠금을 따른다. 읽기 전용 사용자의 제어 route 접근 제한은 기존 정책을 유지한다.
- Raspberry Pi Phase 0의 daemon/HCI/network/token 재연결은 통과했지만 ESP32-H2 provisioning과 0/25/50/100% 왕복, 2-node HIL은 아직 실기 검증이 필요하다.
- 자동 테스트 adapter는 `apps/gateway/test`에만 있고 양산 gateway runtime과 배포 진입점에는 포함되지 않는다.
- ESP32-H2 custom two-OTA partition은 각 slot `0x1f0000` 바이트다. Task 16 breaker fullclean test-build binary는 `0xefa30`(`981,552`) 바이트, free는 `0x1005d0`(`1,050,064`, 약 52%)다. Production release gate는 free가 slot 20%와 256 KiB 중 큰 값인 현재 `406,324` 바이트보다 작으면 build를 거부한다. 실제 production trust root는 미등록이라 production build는 IDF 실행 전에 정상적으로 fail-closed한다.
- gateway가 acceptance 기록 직후 재시작하면 자동 재제어하지 않고 불확정 결과를 보존한다. 운영자는 명령 이력에서 실제 상태를 확인하고 미적용이 확인된 경우에만 재적용할 수 있다. 재시작·상태 응답 유실의 실장비 검증은 미실행이다.
- API target 해석, 확정 fixture snapshot, delivery mode와 Mesh group ID/address/version 영속화, strict full retry 복구, fresh publisher fencing, outbox row 기반 pending timeout 직렬화, Gateway 병렬 unicast/group 단일 전송과 durable group state 수명주기, 신규 웹 target picker 연결까지 반영됐다.
- 자동 테스트와 ESP-IDF target build는 통과했지만 Raspberry Pi BlueZ, 실제 ESP32-H2 여러 대, 실제 MQTT broker를 연결한 group subscription, 단일 RF 전송, 지터 publication, timeout/패킷 손실 RF/HIL은 아직 수동 검증이 필요하다. 특히 조명 수 증가에 따른 Status 충돌률과 Gateway 8초 수집 timeout의 적정성은 현장 규모별로 측정해야 한다.
- `sessionStorage` 새로고침 복구와 ACK terminal 전 입력 잠금의 브라우저 계약 검증은 Task 7에서 완료했다. 격리 실백엔드 Chromium E2E에서 저장 구역 생성·수정·삭제와 개별·다중·층·구역 제어 4건의 terminal 결과를 검증했다. 2026-09-14 Raspberry Pi와 단일 BIO 조명의 vendor USB HIL은 개별·schedule·층·구역 제어까지 통과했다. BIO 다중 fixture와 표준 BlueZ/ESP32-H2 다중·층·구역 Mesh Group 실장비 검증은 남아 있다.
- 저장 구역 생성·수정·삭제·재동기화 Web dialog와 Chromium route fixture 검증은 완료됐다. 실제 Raspberry Pi와 BIO USB 동글을 연결한 단일 조명 zone 제어도 2026-09-14 실행해 통과했다. 표준 BlueZ/ESP32-H2 zone 제어와 Health Fault Clear callback 실기는 Gateway 프로세스 내부에서 BlueZ node owner 권한으로 전송할 API/IPC가 없어 `not_executed` 상태이며, 이 두 표준 Mesh 항목은 BIO HIL 통과로 완료 처리하지 않는다.
- advisory lock 회귀와 구역 에너지 이력 호출은 단위 테스트로 검증했다. 전체 suite에서는 세 opt-in DB URL이 없어 rollback 구역 생성 통합 회귀 1건이 skip됐지만, 이후 로컬 개발 PostgreSQL URL을 `ENERGY_DIMENSION_HISTORY_TEST_DATABASE_URL`로 명시한 별도 실행에서 구역·에너지 이력 생성과 rollback 1/1을 통과했다.
- Task 20 Fix Round 4에서 temp directory는 fixed lock의 owner/coordination 상태가 아닌 publish 후보로 유지하되, cleanup은 원본 temp를 같은 parent의 unique quarantine path로 먼저 atomic rename해 소유권을 확보한 뒤 quarantine 내부만 정리한다. quarantine 내부가 empty directory이거나 exact regular `.owner.<token>` marker 하나만 가진 경우에만 삭제하고, publisher가 먼저 temp를 fixed lock으로 rename하면 cleaner는 원본 temp `ENOENT`로 중단한다. cleaner가 먼저 quarantine하면 publisher는 `ENOENT` 후 같은 token으로 새 temp를 만들어 retry한다. fixed lock directory 자체는 quarantine하지 않는다. temp/quarantine symlink·non-directory·marker symlink·multi-entry·외부 sentinel은 따라가거나 삭제하지 않고 fixed lock 획득을 막지 않는다. fixed lock은 계속 token/PID/`ps` process-start identity를 exact marker로 확인해 active owner wait, stale/PID reuse takeover, unknown identity fail-closed, exact release, successor ABA 보호와 same-output 직렬화를 유지한다. production `scripts/esp32-h2-build.sh`는 Bluetooth SIG 자사 Company ID와 signed manufacturing approval이 없는 현재 `unprovisioned` policy에서 의도적으로 fail-closed한다. 이는 HIL 실패나 HIL 완료 증거가 아니다.

## 관련 파일

- `apps/api/prisma/migrations/20260927150000_command_content_redaction/migration.sql`, `apps/api/src/commands/command-redacted-state.spec.ts`, `apps/api/src/commands/command-redacted-state.integration.spec.ts`

- `apps/gateway/src/commands/command-rf-drain.ts`, `apps/gateway/src/commands/gateway-command-handler.ts`, `apps/gateway/src/mesh/bluez-transport.ts`, `apps/gateway/src/mesh/bluez-mesh-adapter.ts`, `apps/gateway/src/bio/bio-usb-transport.ts`, `apps/gateway/src/bio/bio-dongle-client.ts`, `apps/gateway/src/adapters/bio-usb-dongle-adapter.ts`, `apps/gateway/src/index.ts`
- `apps/gateway/src/bio/bio-command-codec.ts`
- `apps/gateway/src/bio/bio-sensor-shadow-capture.ts`
- `apps/gateway/scripts/bio-sensor-shadow-analyze.ts`
- `apps/gateway/src/adapters/adapter-factory.ts`
- `apps/gateway/compose.bio-runtime.yml`
- `docs/runbooks/raspberry-pi-gateway-appliance.md`

- `apps/api/src/monitoring-refresh/monitoring-refresh-ingestion.service.ts`
- `apps/api/src/fixtures/fixture-presence-ingestion.service.ts`
- `apps/api/src/energy/fixture-state-ingestion.service.ts`
- `apps/api/src/automation/dto/automation-list.dto.ts`, `apps/api/src/automation/automation-list-filters.ts`, `apps/api/src/automation/schedules.service.ts`, `apps/api/src/automation/vehicle-event-rules.service.ts`
- `apps/api/src/mqtt/mqtt.service.ts`, `apps/api/src/mqtt/outbox-publisher.service.ts`, `apps/api/src/commands/command-status.service.ts`, `apps/api/src/commands/command-late-set-ack.service.ts`, `apps/api/src/commands/command-recovery-ack.service.ts`, `apps/api/src/commands/command-legacy-get-ack.service.ts`
- `apps/api/src/monitoring-incidents/monitoring-conditions.ts`
- `infra/mosquitto.acl.example`
- `scripts/dev-runtime.mjs`

- `apps/web/src/features/control/ControlView.tsx`
- `apps/web/src/features/control/active-command-store.ts`
- `apps/web/src/api/commands.ts`
- `apps/web/src/features/control/CommandHistoryPanel.tsx`
- `apps/web/src/features/control/CommandVerificationCases.tsx`
- `apps/web/src/features/control/CommandRiskReconcileDialog.tsx`
- `apps/web/src/features/control/control-time.ts`
- `apps/web/src/components/ui/session-status/SessionStatusProvider.tsx`
- `apps/web/src/components/ui/session-status/SessionStatusCenter.tsx`
- `apps/web/src/components/ui/session-status/ToastRegion.tsx`
- `apps/web/src/features/control/FixtureGroupDialog.tsx`
- `apps/web/src/features/control/FixtureGroupDialog.test.tsx`
- `apps/web/src/features/control/target-selection/FixtureGroupMapEditor.tsx`
- `apps/web/src/features/control/target-selection/FixtureGroupMapEditor.test.tsx`
- `apps/web/src/features/control/target-selection/SpatialTargetSelector.tsx`
- `apps/web/src/features/floor-map/FloorMapViewport.tsx`
- `apps/web/src/features/floor-map/FloorScene.tsx`
- `apps/web/src/features/control/automation/ControlModeTabs.tsx`
- `apps/web/src/features/control/automation/ScheduleControlPanel.tsx`
- `apps/web/src/features/control/automation/ScheduleDialog.tsx`
- `apps/web/src/features/control/automation/VehicleEventControlPanel.tsx`
- `apps/web/src/features/control/automation/VehicleEventDialog.tsx`
- `apps/web/src/features/control/automation/components/AutomationRuleCard.tsx`
- `apps/web/src/features/control/automation/components/AutomationRuleControls.tsx`
- `apps/web/src/features/control/automation/components/AutomationWorkspaceSurface.tsx`
- `apps/web/src/features/control/automation/components/useAutomationListState.ts`
- `apps/web/src/features/control/automation/components/useAutomationVisiblePagePoll.ts`
- `apps/web/src/features/control/automation/components/AutomationQuickFields.tsx`
- `apps/web/e2e/calm-operations-manual-control.spec.ts`
- `apps/web/e2e/calm-operations-automation.spec.ts`
- `apps/web/e2e/automation-control-flow.spec.ts`
- `apps/web/e2e/control-map-target-selection.spec.ts`

- `apps/api/prisma/migrations/20260914090000_manual_control_baseline/migration.sql`
- `docs/superpowers/plans/2026-09-14-manual-baseline-control.md`
- `docs/runbooks/raspberry-pi-gateway-appliance.md`
- `apps/web/src/features/control/CommandHistoryPanel.tsx`
- `apps/web/src/features/control/CommandHistoryPanel.test.tsx`
- `apps/web/src/features/control/CommandOutcomeActions.tsx`
- `apps/web/src/features/control/CommandOutcomeActions.test.tsx`
- `apps/api/src/commands/command-delivery-reliability.spec.ts`
- `apps/api/src/retention/gateway-event-watermark.ts`, `apps/api/src/retention/gateway-event-watermark.integration.spec.ts`
- `apps/api/src/retention/data-retention.service.ts`, `apps/api/src/retention/data-retention.integration.spec.ts`
- [API·Web 운영 배포와 장애 대응](../runbooks/production-api-web-deployment.md)

- `apps/web/src/components/ui/AppRecoveryState.tsx`
- `apps/web/src/components/ui/AppErrorBoundary.tsx`
- `apps/web/src/AppRoot.tsx`
- `apps/web/src/App.recovery.test.tsx`
- `apps/web/e2e/app-shell-recovery.spec.ts`

- `apps/web/src/App.tsx`
- `apps/web/src/components/ui/RouteLoadingState.tsx`
- `apps/web/src/features/shells/CustomerShell.tsx`
- `apps/web/e2e/site-user-management.spec.ts`
- `apps/api/src/access/site-access.service.ts`
- `apps/api/src/commands/commands.service.ts`

- `apps/web/src/components/ui/SidePanel.tsx`

- `apps/web/src/features/transport-copy.ts`
- `apps/web/src/features/transport-copy.test.ts`
- `apps/api/src/automation/automation.controller.ts`
- `apps/api/src/sites/sites.service.ts`
- `apps/api/src/automation/automation.module.ts`
- `apps/api/src/automation/schedules.service.ts`
- `apps/api/src/automation/vehicle-event-rules.service.ts`
- `apps/api/src/automation/vehicle-sensor-capability.service.ts`
- `apps/api/src/automation/automation-mqtt-consumer.service.ts`
- `apps/api/src/automation/automation-outbox-publisher.service.ts`
- `apps/api/src/automation/automation-runtime.module.ts`
- `apps/gateway/src/automation/vehicle-event-runtime.ts`
- `apps/gateway/src/automation/automation-telemetry-handoff.ts`
- `apps/gateway/src/automation/automation-telemetry-outbox.ts`
- `apps/gateway/src/automation/automation-telemetry-gap-journal.ts`
- `apps/gateway/src/automation/automation-telemetry-coordinator.ts`
- `apps/gateway/src/automation/automation-storage.ts`
- `apps/gateway/src/storage/storage-headroom-manager.ts`
- `apps/gateway/src/automation/schedule-runtime.ts`
- `apps/gateway/src/automation/software-automation-simulator.ts`
- `apps/gateway/src/automation/software-automation-simulator.test.ts`
- `apps/gateway/src/runtime/gateway-mqtt-runtime.ts`
- `apps/api/src/automation/target-snapshot.service.ts`
- `apps/api/src/automation/automation-snapshot.service.ts`
- `apps/web/e2e/automation-control-flow.spec.ts`
- `apps/web/e2e/monitoring-control-flow.spec.ts`
- `apps/web/e2e/layout-assertions.spec.ts`
- `apps/web/e2e/support/layout-assertions.ts`
- `apps/web/e2e/support/real-backend-lab.ts`
- `apps/web/playwright.config.ts`
- `scripts/dev.mjs`
- `.superpowers/sdd/2026-08-29-schedule-vehicle-event-control/task-19-report.md`
- `.superpowers/sdd/2026-08-29-schedule-vehicle-event-control/task-20-report.md`
- `apps/api/src/automation/dto/schedule.dto.ts`
- `apps/api/src/automation/dto/vehicle-event-rule.dto.ts`
- `apps/web/src/api/automation.ts`
- `apps/web/src/api/queries.ts`
- `apps/web/src/features/control/ControlView.tsx`
- `apps/web/src/features/control/ControlTargetPicker.tsx`
- `apps/web/src/features/control/automation/VehicleEventControlPanel.tsx`
- `apps/web/src/features/control/automation/VehicleEventDialog.tsx`
- `apps/web/src/features/control/automation/vehicle-event-form.ts`
- `apps/web/src/features/control/automation/automation-presenters.ts`
- `apps/web/src/features/control/automation/automation-presenters.test.ts`
- `apps/web/src/features/control/automation/components/AutomationQuickFields.tsx`
- `apps/web/src/features/control/automation/components/AutomationQuickFields.test.tsx`
- `apps/api/src/automation/schedules.service.spec.ts`
- `apps/api/src/automation/vehicle-event-rules.service.spec.ts`
- `apps/api/test/automation-schedules.e2e-spec.ts`
- `apps/api/test/vehicle-event-rules.e2e-spec.ts`
- `apps/api/src/automation/vehicle-sensor-capability-schema.spec.ts`
- `apps/api/prisma/migrations/20260830_vehicle_sensor_source_invariants/migration.sql`
- `apps/api/prisma/migrations/20260830_add_vehicle_event_execution_list_index/migration.sql`
- `apps/api/prisma/migrations/20260901_automation_mqtt_delivery/migration.sql`
- `apps/api/prisma/migrations/20260904_bind_manual_execution_command_source/migration.sql`
- `apps/api/prisma/migrations/20260902_snapshot_backed_automation_execution/migration.sql`
- `packages/shared/src/automation-contracts.ts`
- `packages/shared/src/automation-action-result-contracts.ts`
- `packages/shared/package.json`
- `packages/shared/tsconfig.esm.json`
- `packages/shared/scripts/build.mjs`
- `packages/shared/scripts/build-output-lock.mjs`
- `packages/shared/src/build-output-lock.test.ts`
- `packages/shared/src/package-exports.test.ts`
- `packages/shared/src/mqtt.ts`
- `apps/web/src/features/control/ControlView.tsx`
- `apps/web/src/features/control/ControlTargetPicker.tsx`
- `apps/web/src/features/control/ControlView.test.tsx`
- `apps/web/src/components/ui/UnderlineNavigation.tsx`
- `apps/web/src/features/control/automation/ControlModeTabs.tsx`
- `apps/web/src/features/control/automation/ScheduleControlPanel.tsx`
- `apps/web/src/features/control/automation/ScheduleControlPanel.test.tsx`
- `apps/web/src/features/control/automation/VehicleEventControlPanel.tsx`
- `apps/web/src/features/control/automation/VehicleEventControlPanel.test.tsx`
- `apps/web/e2e/calm-operations-automation.spec.ts`
- `apps/web/e2e/calm-operations-manual-control.spec.ts`
- `apps/web/src/components/ui/Button.tsx`
- `apps/web/src/components/ui/Card.tsx`
- `apps/web/src/components/ui/PageHeader.tsx`
- `apps/web/src/components/ui/StatusBadge.tsx`
- `apps/web/src/components/ui/FeedbackState.tsx`
- `apps/web/src/styles.css`
- `apps/web/src/features/control/automation/automation-contracts.test.ts`
- `apps/web/src/features/control/automation/ScheduleDialog.tsx`
- `apps/web/src/features/control/automation/schedule-form.ts`
- `apps/web/src/features/control/automation/schedule-form.test.ts`
- `apps/web/src/api/automation.ts`
- `apps/web/src/api/automation.test.ts`
- `apps/web/vite.config.ts`
- `apps/web/scripts/audit-schedule-bundle.mjs`
- `apps/web/src/features/control/FixtureGroupDialog.tsx`
- `apps/web/src/features/control/FixtureGroupDialog.test.tsx`
- `apps/web/src/api/fixture-groups.ts`
- `apps/web/src/api/fixture-groups.test.ts`
- `apps/web/e2e/monitoring-control-flow.spec.ts`
- `apps/api/src/commands/commands.controller.ts`
- `apps/api/src/commands/commands.service.ts`
- `apps/api/src/fixture-groups/fixture-groups.controller.ts`
- `apps/api/src/fixture-groups/fixture-groups.service.ts`
- `apps/api/src/fixture-groups/fixture-groups.service.spec.ts`
- `apps/api/src/energy/energy-dimension-history.service.ts`
- `apps/api/src/energy/energy-dimension-history.service.spec.ts`
- `apps/api/src/energy/energy-dimension-history.integration.spec.ts`
- `apps/api/src/commands/command-dispatch.service.ts`
- `apps/api/src/commands/command-status.service.ts`
- `apps/web/src/api/commands.ts`
- `apps/web/src/features/control/active-command-store.ts`
- `packages/shared/src/dimming-command.ts`
- `apps/web/src/features/control/active-command-store.test.ts`
- `apps/api/src/mqtt/mqtt.service.ts`
- `apps/api/src/mqtt/mqtt.service.spec.ts`
- `apps/api/src/mqtt/mqtt.module.ts`
- `apps/api/src/mqtt/mqtt-shutdown-coordinator.service.ts`
- `apps/api/src/mqtt/mqtt-shutdown-coordinator.spec.ts`
- `apps/api/src/mesh-control-groups/mesh-group-sync.worker.spec.ts`
- `apps/api/src/fixtures/fixture-health.ts`
- `apps/api/src/mqtt/outbox-publisher.service.ts`
- `apps/api/src/mqtt/outbox-publisher.service.spec.ts`
- `apps/gateway/src/gateway.ts`
- `apps/gateway/src/index.ts`
- `apps/gateway/src/automation/automation-config-store.ts`
- `apps/gateway/src/automation/automation-runtime.ts`
- `apps/gateway/src/automation/automation-state-store.ts`
- `apps/gateway/src/automation/automation-arbiter.ts`
- `apps/gateway/src/automation/schedule-runtime.ts`
- `apps/gateway/src/automation/clock-trust-provider.ts`
- `apps/gateway/src/automation/automation-config-ack-outbox.ts`
- `apps/gateway/src/automation/automation-current-config-requester.ts`
- `apps/gateway/src/automation/automation-config-production-path.test.ts`
- `apps/gateway/src/runtime/gateway-mqtt-runtime.ts`
- `apps/gateway/src/runtime/background-mesh-resync.ts`
- `apps/gateway/src/commands/gateway-command-handler.ts`
- `packages/shared/src/command-delivery.ts`
- `packages/shared/src/gateway-contracts.ts`
- `apps/gateway/docker/mqtt-persistence.integration.mjs`
- `apps/web/e2e/automation-control-flow.spec.ts`
- `apps/web/e2e/support/real-backend-lab.ts`
- `packages/shared/src/automation-contracts.ts`
- `packages/shared/src/mqtt.ts`
- `infra/mosquitto.production-tls.conf`
- `docker-compose.production.yml`
- `apps/gateway/src/commands/command-journal.ts`
- `apps/gateway/src/commands/gateway-command-handler.ts`
- `apps/gateway/src/mesh/bluez-mesh-adapter.ts`
- `apps/gateway/src/mesh/bluez-provisioner.ts`
- `apps/gateway/src/mesh/bluez-config-client.ts`
- `apps/gateway/src/mesh/group-subscription-handler.ts`
- `apps/gateway/src/mesh/group-state-store.ts`
- `apps/gateway/src/mesh/bluez-model-codec.ts`
- `apps/gateway/src/runtime/keyed-serial-task-queue.ts`
- `apps/api/src/mesh-control-groups/mesh-control-group.service.ts`
- `apps/api/src/mesh-control-groups/mesh-group-sync.worker.ts`
- `apps/api/prisma/migrations/20260821093000_add_mesh_control_group_member_status_version/migration.sql`
- `apps/api/prisma/schema.prisma`
- `apps/api/prisma/migrations/20260819093000_add_mesh_control_groups/migration.sql`
- `apps/api/prisma/migrations/20260819094000_extend_command_targets/migration.sql`
- `docs/runbooks/raspberry-pi-gateway-appliance.md`
- `apps/esp32-h2-firmware/main/app_main.c`
- `apps/esp32-h2-firmware/main/ble_mesh_node.c`
- `apps/esp32-h2-firmware/main/ble_mesh_platform.c`
- `apps/esp32-h2-firmware/main/control_state.c`
- `apps/esp32-h2-firmware/main/led_driver.c`
- `apps/esp32-h2-firmware/main/vehicle_sensor_driver.c`
- `apps/esp32-h2-firmware/main/vehicle_sensor_driver.h`
- `apps/esp32-h2-firmware/main/vehicle_sensor_model.c`
- `apps/esp32-h2-firmware/main/vehicle_sensor_model.h`
- `apps/esp32-h2-firmware/main/vehicle_sensor_runtime.c`
- `apps/esp32-h2-firmware/main/vehicle_sensor_runtime.h`
- `apps/esp32-h2-firmware/main/vehicle_sensor_mesh_adapter.c`
- `apps/esp32-h2-firmware/main/vehicle_sensor_mesh_adapter.h`
- `apps/esp32-h2-firmware/main/vehicle_sensor_health.c`
- `apps/esp32-h2-firmware/main/vehicle_sensor_health.h`
- `apps/esp32-h2-firmware/partitions.csv`
- `apps/esp32-h2-firmware/manufacturing/production-trust-policy.conf`
- `apps/esp32-h2-firmware/patches/esp-idf-v5.5.1-server-send-ownership.patch`
- `apps/esp32-h2-firmware/patches/esp-idf-v5.5.1-server-send-ownership.conf`
- `apps/esp32-h2-firmware/patches/README.md`
- `apps/esp32-h2-firmware/sdkconfig.defaults`
- `apps/esp32-h2-firmware/test/native/test_vehicle_sensor_driver.c`
- `apps/esp32-h2-firmware/test/native/test_vehicle_sensor_model.c`
- `apps/esp32-h2-firmware/test/native/test_vehicle_sensor_mesh_adapter.c`
- `apps/esp32-h2-firmware/test/native/test_vehicle_sensor_health.c`
- `apps/esp32-h2-firmware/test/native/test_vehicle_sensor_model_target_artifact.sh`
- `apps/esp32-h2-firmware/test/host_fake/test_vehicle_sensor_model_runtime.c`
- `apps/esp32-h2-firmware/test/host_fake/test_vehicle_sensor_driver_integration.c`
- `apps/esp32-h2-firmware/test/host_fake/test_vehicle_sensor_host_fake.sh`
- `apps/esp32-h2-firmware/test/native/test_esp32_h2_artifact_audit.sh`
- `apps/esp32-h2-firmware/test/native/test_esp32_h2_artifact_attestation.sh`
- `apps/esp32-h2-firmware/test/native/test_esp32_h2_idf_patch_gate.sh`
- `apps/esp32-h2-firmware/test/native/test_esp_idf_server_send_boundary.sh`
- `apps/esp32-h2-firmware/test/native/test_esp32_h2_trust_policy.sh`
- `apps/esp32-h2-firmware/test/idf_patch_fake/test_server_send_boundary.c`
- `scripts/esp32-h2-idf-patch.sh`
- `scripts/esp32-h2-build.sh`
- `scripts/esp32-h2-flash.sh`
- `scripts/esp32-h2-artifact-audit.sh`
- `scripts/esp32-h2-manufacturing-approval.sh`
- `.superpowers/sdd/2026-08-29-schedule-vehicle-event-control/task-15-report.md`
- `apps/esp32-h2-firmware/main/mesh_state.c`
- `apps/esp32-h2-firmware/main/mesh_transaction_cache.c`
- `apps/esp32-h2-firmware/README.md`
- `apps/esp32-h2-firmware/sdkconfig.defaults`
- `apps/gateway/README.md`
- `scripts/esp32-h2-build.sh`
- `scripts/esp32-h2-flash.sh`
- `apps/gateway/scripts/local-smoke-test.mjs`
- `apps/api/src/mqtt/mqtt.service.ts`
- `packages/shared/src/schemas.ts`
- `packages/shared/src/mqtt.ts`

## 갱신 규칙

제어 메뉴의 개별/그룹/스케줄/이벤트 제어 기능이 바뀌면 이 문서를 같은 작업 안에서 갱신한다. software E2E 또는 HIL 증거 상태가 바뀌면 두 상태를 분리해 함께 갱신하며, 실장비 미실행 항목을 자동 검증 결과로 완료 처리하지 않는다.
