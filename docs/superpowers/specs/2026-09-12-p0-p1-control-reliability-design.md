# P0/P1 조명 제어 신뢰성 설계

## 목표

명령이 게이트웨이에 전달된 뒤 최종 장비 상태 응답을 잃더라도 이를 단순 실패로 단정하지 않고, 실제 조명 상태를 읽어 안전하게 수렴시킨다. HTTP 응답 재조회와 물리 제어 재실행을 구분하고, 작업자가 과거 명령을 검색·재확인할 수 있게 한다.

## 확정한 접근

자동으로 밝기 Set을 다시 보내지 않는다. 대신 기존 MQTT outbox, 게이트웨이 durable journal, acceptance/device-status ACK 경로에 `status-check` 명령을 추가해 Generic OnOff/Lightness Get으로 실제 밝기를 읽는다. 이 선택은 중복 Set으로 현장 조명을 다시 움직이는 위험을 제거하면서, 게이트웨이 재시작·ACK 유실·API 응답 유실을 각각 독립적으로 복구한다.

## 상태 모델

- `Command.status`는 기존 저장·호환 계약(`pending`, `acknowledged`, `failed`)을 유지한다.
- nullable `Command.outcome`을 추가한다. 새 명령은 `pending`, 성공 ACK는 `applied`, 실행 전 거절은 `not_applied`, 일부 성공은 `partially_applied`, broker 전송 이후 ACK 또는 status가 사라지면 `unknown`이다. 기존 행은 `null`로 두어 과거 결과를 잘못 재분류하지 않는다.
- `CommandDispatch.kind`는 `dimming` 또는 `status_check`다. `status_check` dispatch는 원래 명령에 속하고 `verificationAttempt`와 HTTP 재요청용 `clientRequestId`를 가진다.
- 기존 dimming dispatch가 timeout으로 닫힌 뒤 늦은 device-status ACK가 도착하면 `outcome=unknown`인 경우에 한해 한 번 수렴을 허용한다. 수렴 뒤 duplicate ACK는 무시한다.
- 실행 전 `pending` delivery timeout은 `not_applied`; broker publish 뒤 acceptance 유실과 acceptance 뒤 device-status 유실은 `unknown`이다.

## 후속 상태 조회 계약

- API: `POST /commands/:commandId/status-checks`, body `{ clientRequestId: UUID }`.
- 권한: 원 명령 site에 대한 `control`; 읽기 전용 사용자는 실행할 수 없다.
- 허용 조건: 원 명령 outcome이 `unknown`, 같은 명령의 진행 중 status check가 없음, 시도 횟수 3회 미만.
- 동일 `clientRequestId`는 기존 status-check dispatch를 반환한다. 응답 유실 뒤 같은 요청을 재전송해도 물리 Get이 중복 생성되지 않는다.
- 새 shared MQTT kind/topic은 `status-check`다. payload는 command/dispatch/idempotency identity, 원 명령 ID, 대상 fixture ID 목록, 기대 밝기, attempt, publish-relative expiry를 포함한다.
- Gateway는 journal에 acceptance를 먼저 내구 저장한 후 대상별 Generic OnOff/Lightness Get을 수행한다. 관측한 fixture는 `succeeded + brightness`, 응답이 없는 fixture는 `timed_out`으로 기존 device-status ACK에 기록한다.
- API는 status-check 결과를 원 명령과 비교한다. 전부 기대 밝기면 `applied`, 전부 다른 현재 밝기면 `not_applied`, 혼합이면 `partially_applied`, 하나라도 관측하지 못하면 `unknown`을 유지한다.
- status-check 자체의 pending/published/accepted timeout은 해당 dispatch만 닫고 원 명령은 `unknown`으로 유지한다.

## 중복 제어 방지와 재시도 의미

- POST dimming의 HTTP 응답을 잃은 경우 UI는 기존 `clientRequestId`로 “동일 요청 확인”을 수행한다. 이는 새 물리 제어가 아니다.
- `outcome=unknown`인 명령과 fixture가 겹치는 새 dimming 요청은 API에서 `409 uncertain_command_requires_status_check`로 거부한다.
- `not_applied`로 확인된 뒤에만 UI가 “안전하게 다시 적용”을 제공하며 새 `clientRequestId`로 새 명령을 만든다.
- `unknown` 상태에서는 Set 재전송 버튼을 제공하지 않고 “실제 상태 확인”만 제공한다. 3회 모두 불확실하면 현장 확인이 필요하다고 표시한다.
- `applied` 또는 `partially_applied`는 원 명령을 그대로 재전송하지 않는다. 사용자가 다른 밝기를 선택한 새 제어만 허용한다.

## timeout worker

- timer callback은 single-flight로 동작해 느린 DB 작업 중 다음 tick이 겹치지 않는다.
- 예약 실행의 reject는 Nest Logger에 Prisma code 또는 `UNEXPECTED_ERROR`만 기록하고 payload, SQL, credential, raw message는 기록하지 않는다.
- `onModuleDestroy()`는 interval을 해제하고 진행 중 batch가 끝날 때까지 await한다. 중지 시작 뒤 새 batch는 실행하지 않는다.
- 직접 호출하는 `closeExpired(now)`는 테스트와 관리 경로를 위해 오류를 숨기지 않는다. 예약 wrapper만 catch/log한다.

## 명령 이력과 UI

- API: `GET /commands?siteId=...&query=...&stage=...&cursor=...&limit=20`.
- site read 권한을 검증하고 최신순 cursor pagination을 사용한다. query는 명령 ID prefix와 fixture 이름을 검색하며 site 범위를 벗어나지 않는다.
- 수동 제어 화면에 최근 명령 패널을 공통 카드로 분리한다. 검색, 상태 필터, 더 보기, 행 선택 후 기존 상세 조회 재오픈을 제공한다.
- `unknown` 상세는 경고 tone, 원인(`ACCEPTANCE_TIMEOUT`, `STATUS_TIMEOUT`, gateway restart 등), 시도 횟수, “실제 상태 확인”을 표시한다.
- status check 후 `not_applied`이면 안전 재적용 버튼, `applied`이면 이미 적용됨, `partially_applied`이면 대상별 현재값과 새 제어 안내를 표시한다.

## 테스트 경계

- API timeout: slow DB, transient error, overlapping tick, shutdown drain, pending/published/accepted 분류.
- API lifecycle: acceptance/status loss, late ACK 수렴, duplicate ACK, status-check HTTP response loss/idempotency, 최대 3회, 겹치는 새 dimming 차단, history scope/search/cursor.
- Gateway: acceptance 직후 재시작, status loss, duplicate command/ACK 결과 재사용, status-check 관측/부분 timeout/expiry/journal recovery.
- Web: 일반 네트워크 재시도와 물리 재제어 문구·버튼 분리, unknown에서 Set 차단, 상태 확인, safe retry, history 검색·상세 재오픈.

## HIL 경계

소프트웨어 테스트는 단일·다중 fixture의 계약, 중복 방지, 상태 수렴과 UI를 검증한다. 실제 Raspberry Pi/BlueZ/ESP 조합에서 다중 fixture, 층, Mesh 그룹, 전원 차단, broker 단절, gateway 프로세스 강제 종료를 수행하는 HIL은 별도이며 완료로 표기하지 않는다.

## 운영 제약

- Prisma migration 파일과 schema 문서는 갱신하지만 사용자 DB에는 migration을 적용하지 않는다.
- 실제 배포, 운영 secret 변경, 외부 서비스 호출은 범위 밖이다.
- 구현은 `/Users/kim-jh/Documents/led-control-service/.worktrees/p0p1-control-reliability`와 `codex/p0p1-control-reliability`에서만 수행하며 main에는 merge하지 않는다.
