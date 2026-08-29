# 메뉴 완성 작업 상태판

기준일: 2026-08-30

## 현재 마일스톤

**스케줄·차량 감지 이벤트 제어 구현**: shared recurrence와 production schema에 이어 schedule 및 차량 이벤트 규칙 API CRUD, exact Fixture snapshot, 직렬화와 durable full-snapshot outbox까지 완료했다.

## 작업 상태

| 작업 | 상태 | 내용 |
| --- | --- | --- |
| 에이전트 운영 기반 Task 1 | 완료 | 운영 기준과 지속 갱신 상태판을 작성했다. |
| 에이전트 운영 기반 Task 2 | 완료 | 프로젝트 전용 custom agent 7개의 기본 권한 프로필과 디렉터리별 `AGENTS.md` 소유·검증 규칙을 구성했다. 실제 QA 읽기 전용 검토는 부모 세션도 읽기 전용 권한으로 실행한다. |
| 메뉴 완성 설계 작성 | 완료 | [모니터링·제어·통계 완료 설계](superpowers/specs/2026-08-26-monitoring-control-statistics-completion-design.md)에 재검토를 반영해 migration 시점 에너지 추적과 durable state outbox·application ACK까지 확정했다. |
| 메뉴 완성 구현 계획 | 완료 | [구현 계획](superpowers/plans/2026-08-26-monitoring-control-statistics-completion.md)을 12개 검증·커밋 단위로 작성했다. |
| 메뉴 완성 구현 | 완료(소프트웨어) | Task 12까지 구현·문서·전체 회귀와 실백엔드 설치·고객 운영 Chromium E2E를 통과했다. 실제 Raspberry Pi/ESP32-H2 HIL은 별도 검증으로 남아 있다. |
| 계정·설치 주체 전환 설계 | 완료 | [전역 운영자와 현장 관리자 계정 흐름 설계](superpowers/specs/2026-08-26-operator-admin-account-flow-design.md)에 로그인 아이디, 전역 단일 operator, 현장별 단일 admin, admin 최초 설치와 설정 범위를 정의했고 재설치는 제외했다. |
| 계정·설치 주체 전환 구현 계획 | 완료 | [구현 계획](superpowers/plans/2026-08-27-operator-admin-account-flow.md)을 DB·인증·권한·웹·E2E의 9개 검증·커밋 단위로 작성했다. |
| 계정·설치 주체 전환 구현 | 완료(소프트웨어) | Task 1~9와 final review fix를 완료했다. login/reset/change는 User row lock과 실제 PostgreSQL barrier로 old credential session race를 차단하고, 일반 admin의 command/group/floor write는 transaction 내부 Site lock 재인가를 사용한다. Web은 login 평문을 React Query cache에 넣지 않으며 principal 전환·강제 revoke에서 tenant Query/Mutation cache를 제거한다. service-global operator는 `/operator/site-admins`에서 현장별 assigned admin을 create/update/reset/disable하고 network allowlist는 `/api/auth/*`, `/api/operator/*`뿐이다. 격리 실백엔드 Chromium journey는 새 PostgreSQL/Redis/mTLS Mosquitto와 test-support simulator로 설치·claim·registration·제어·통계·도면·비밀번호·viewer 권한을 검증하며 사용자 개발 DB를 읽거나 초기화하지 않는다. 이는 production Gateway/BlueZ/RF 또는 Raspberry Pi/ESP32-H2 HIL 증거가 아니다. 모바일·재설치는 범위 밖이다. controller가 수동 in-app browser QA를 시도했지만 admin-enforced browser policy가 localhost 접근 전에 차단해 미실행이며 자동 Chromium E2E와 별개다. |
| 모니터링 등록 흐름 보완 | 완료(소프트웨어) | 조명 생성 후에도 유지되는 active session 복구 API·UI, 과거 attempt 미해결 노드 노출, `reconcile_required` 상태 재조회·안전 제외·세션 취소, MQTT 완료 경합 잠금, unresolved 재검색/완료 차단과 fixture benchmark 현장 범위 경로를 구현했다. 실장비 상태 자동 판정과 HIL은 포함하지 않는다. |
| 스케줄·차량 이벤트 제어 설계 | 완료(설계) | 반복 일정, overlap 차단, 수동 override·차량 이벤트·스케줄 우선순위, Gateway full snapshot 무중단 적용, offline 실행과 ESP32-H2 차량 감지 event 계약을 확정했다. Task 7 schedule API와 Task 8 차량 이벤트 규칙 API CRUD를 구현했고 Web과 Gateway 실행은 후속 Task다. |
| 스케줄·차량 이벤트 제어 Task 7 | 완료(소프트웨어) | assigned admin mutation/viewer read 권한, exact Fixture snapshot, 공통 engine overlap, automation advisory lock 후 Site 재인가 동시성, RepeatableRead 기반 bounded keyset 목록, schedule API CRUD와 revision/full-snapshot outbox를 구현했다. 실제 MQTT publish/application ACK는 Task 9, Gateway offline 실행과 schedule Web CRUD는 후속 Task다. |
| 스케줄·차량 이벤트 제어 Task 8 | 완료(소프트웨어) | `GET/POST/PATCH/DELETE /sites/:siteId/automation/vehicle-event-rules`, source/target exact Fixture snapshot, 5~1800초 hold와 기본 60초, false dimming 100% 정규화, 단일 Site/Gateway 검증, bounded keyset 목록과 최근 감지/실행, revision/full-snapshot outbox 원자성을 구현했다. PostgreSQL E2E는 role/tenant, rollback, stale admin 재인가와 동시 revision 직렬화를 검증한다. 실제 MQTT publish/application ACK, Gateway/센서 실행과 Web UI는 후속 Task다. |

## 다음 단계

**다음 구현은 automation MQTT 동기화다.** Task 7~8의 schedule/vehicle full snapshot outbox를 publisher와 exact revision application ACK에 연결한 뒤 Gateway 규칙 엔진, ESP32-H2 sensor event, Web CRUD, software E2E와 HIL 순서로 진행한다. test-support simulator 결과를 production Gateway identity·BlueZ/RF·실장비 완료로 확대 해석하지 않는다.

## 알려진 미해결 항목

### 모니터링

- 진행 중인 조명 검색·등록 세션은 브라우저 새로고침 뒤 자동 복구된다. `reconcile_required`는 자동 재시도하지 않으며 실제 장비 상태의 자동 질의·정리는 Raspberry Pi/ESP32-H2 HIL과 함께 후속 검증해야 한다.

### 제어

- 저장 구역 CRUD, ready 차단, 요청 멱등성, ACK 대상·종합 상태 검증과 개별·다중·층·구역 동기 제어는 구현됐다.
- Gateway Config Model Subscription Add/Delete와 실제 조명 제어는 Raspberry Pi/ESP32-H2 HIL에서 검증해야 한다.
- 스케줄 및 차량 이벤트 규칙 API CRUD와 durable full-snapshot outbox 저장은 완료했다. 실제 MQTT publish/application ACK, Gateway 무중단 규칙 동기화, offline 실행, sensor event와 Web CRUD는 아직 구현되지 않았다.

### 통계

- 상태 이벤트 기반 오늘·월·년 집계, 일·월 차트, 180초 projection, 예상 비용과 24시간 100% 기준 절감량을 구현했다.
- 실제 ESP32-H2 상태 publication을 장시간 수집하는 HIL은 실행하지 않았다.

### 계정 인계

- viewer 초대 토큰 소비 API는 호환으로 유지하지만 공개 회원가입 UI는 제거됐다. 운영자용 고객 관리자 CRUD 웹 UI는 Task 7에서 완료했으며 viewer 초대 발급 UI는 후속 범위다. 현재 제조·운영 절차에서 필요한 viewer record를 준비해야 한다.

### 실장비 검증

- Raspberry Pi, MQTT broker, ESP32-H2를 연결한 검색·등록·제어·상태 수집 HIL은 아직 실행하지 않았다.

## 기록 원칙

이 문서는 현재 상태 요약의 정본이다. 활성 작업의 세부 실행 단계는 `writing-plans` 체크리스트에서 관리하며, 상태가 바뀌면 두 기록을 함께 일치시켜 갱신한다. 장기 설계와 미구현 계획은 기존 설계·계획 문서를 유지하며, 완료 여부를 실제 자동 검증과 HIL 증거에 맞춰 갱신한다.
