# 메뉴 완성 작업 상태판

기준일: 2026-08-27

## 현재 마일스톤

**계정·설치 주체 전환 설계**: 전역 단일 operator는 현장별 단일 admin 계정만 관리하고, admin이 최초 현장 설치와 고객 운영을 담당하도록 인증·권한·UI 경계를 전환한다. 재설치와 모바일 변경은 이번 범위에서 제외한다.

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
| 계정·설치 주체 전환 구현 | 진행 중 | Task 1~7과 Task 7 review fix round 3을 완료했다. `User.loginId`는 required unique 로그인 정본이고 `email`은 nullable 초대 연락처로만 남으며 public/session DTO에는 노출하지 않는다. 공개 signup UI는 제거하고 viewer invitation signup API 호환만 유지하며 operator/admin signup은 거부한다. Task 6에서 operator/customer shell을 분리해 operator는 `/operator/site-admins` 전용 route로 수렴하고 customer site/dashboard query를 실행하지 않으며 admin/viewer는 기존 고객 메뉴를 유지한다. Task 7은 operator 전용 현장 관리자 테이블에서 Task 3의 여섯 endpoint로 현장·admin 생성, 기존 현장 admin 지정, 수정, 비밀번호 재설정과 비활성화를 제공한다. React Query key는 `['operator', 'site-admins']` 하나이며 create/assign/reset의 평문 비밀번호는 React Query cache, API response 또는 완료 안내에 저장하지 않고, 성공 또는 사용자가 dialog를 닫을 때 component input state에서 제거한다. 실패 뒤 열린 dialog의 입력은 재시도를 위해 유지한다. `ApiError.body.message`가 정확히 `loginId already exists`인 409만 field 오류와 focus를 사용하고, 그 밖의 409는 일반 재시도 alert다. 각 성공 flow는 active 목록 refetch가 끝난 뒤 dialog를 닫고, 원 trigger가 여전히 연결되어 있으면 create/edit/reset/assign/disable 모두 그 trigger를 복원하며 실제로 제거됐을 때만 안정적인 생성 command를 fallback으로 사용한다. mock 기반 view test는 이 password secrecy, 409 분기, 오류·재시도와 dialog keyboard focus 복원을 검증했지만 실백엔드 E2E는 아니다. assigned active customer admin은 정확히 하나의 `Site.adminUserId` 현장에만 `read/manage/commission`을 가지며 viewer는 membership `read` 전용, operator는 고객 현장 capability와 목록이 없다. `POST /setup/initial-site`와 `POST /setup/floors`는 row lock과 transaction 내부 재검증으로 stale admin mutation을 막는다. `POST /gateways/claim`은 serial별 PostgreSQL transaction advisory lock 안에서 Site 재검증, rolling failure count, 모든 terminal audit과 원자 claim을 완료한 뒤 정제된 응답을 반환한다. registration create/retry/register/complete mutation도 transaction 첫 단계에서 Site를 재검증하고 `Site -> Gateway -> Session -> Node` 잠금 순서를 지켜 stale admin의 session/outbox/node/complete mutation을 차단한다. durable outbox·allocator·provisioning state transition과 device certificate bootstrap/manufacturing enrollment 경계는 유지했고, inventory disable은 customer SiteAccess 없이 active service-provider operator만 수행한다. disposable PostgreSQL에서 병렬 invalid 5회 제한과 전 요청 audit, success/already-consumed 원자성, serial별 독립 진행, claim 및 registration reassignment race를 검증했다. Task 8 admin 최초 설치·commissioning 웹 UI, Task 9 실백엔드 E2E와 모바일은 아직 구현하지 않았다. |

## 다음 단계

**메뉴 완성 소프트웨어 범위는 이전 계정 계약에서 완료했다.** 해당 Chromium E2E의 operator 현장·층 생성과 commissioning 흐름은 현재 Task 1~7 계정 전환의 완료 증거로 사용하지 않는다. 현재 API 계약은 operator가 Task 3 API와 Task 7 웹 관리 화면으로 pending Site/admin을 provision하고 assigned admin이 Task 4 설치와 Task 5 Gateway claim/registration commissioning을 수행하는 단계까지 구현됐으며, Task 6은 operator/customer web shell 경계를 적용했다. Task 8 웹 기능과 Task 9 실백엔드 E2E 전환은 아직 남아 있다. 실제 Raspberry Pi/ESP32-H2 HIL과 모바일도 남아 있다.

## 알려진 미해결 항목

### 모니터링

- 진행 중인 조명 검색·등록 세션은 브라우저 새로고침 뒤 자동 복구되지 않는다. 현재 세션 ID가 화면 상태에만 있으므로 active session 조회·복구 API와 UI가 후속으로 필요하다.

### 제어

- 저장 구역 CRUD, ready 차단, 요청 멱등성, ACK 대상·종합 상태 검증과 개별·다중·층·구역 동기 제어는 구현됐다.
- Gateway Config Model Subscription Add/Delete와 실제 조명 제어는 Raspberry Pi/ESP32-H2 HIL에서 검증해야 한다.

### 통계

- 상태 이벤트 기반 오늘·월·년 집계, 일·월 차트, 180초 projection, 예상 비용과 24시간 100% 기준 절감량을 구현했다.
- 실제 ESP32-H2 상태 publication을 장시간 수집하는 HIL은 실행하지 않았다.

### 계정 인계

- viewer 초대 토큰 소비 API는 호환으로 유지하지만 공개 회원가입 UI는 제거됐다. 운영자용 고객 관리자 CRUD 웹 UI는 Task 7에서 완료했으며 viewer 초대 발급 UI는 후속 범위다. 현재 제조·운영 절차에서 필요한 viewer record를 준비해야 한다.

### 실장비 검증

- Raspberry Pi, MQTT broker, ESP32-H2를 연결한 검색·등록·제어·상태 수집 HIL은 아직 실행하지 않았다.

## 기록 원칙

이 문서는 현재 상태 요약의 정본이다. 활성 작업의 세부 실행 단계는 `writing-plans` 체크리스트에서 관리하며, 상태가 바뀌면 두 기록을 함께 일치시켜 갱신한다. 장기 설계와 미구현 계획은 기존 설계·계획 문서를 유지하며, 완료 여부를 실제 자동 검증과 HIL 증거에 맞춰 갱신한다.
