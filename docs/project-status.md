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
| 계정·설치 주체 전환 구현 | 진행 중 | Task 1~8과 Task 7 review fix round 3을 완료했다. `User.loginId`는 required unique 로그인 정본이고 `email`은 nullable 초대 연락처로만 남으며 public/session DTO에는 노출하지 않는다. 공개 signup UI는 제거하고 viewer invitation signup API 호환만 유지하며 operator/admin signup은 거부한다. Task 6에서 operator/customer shell을 분리해 operator는 `/operator/site-admins` 전용 route로 수렴하고 customer site/dashboard query를 실행하지 않으며 admin/viewer는 기존 고객 메뉴를 유지한다. Task 7은 operator 전용 현장 관리자 테이블에서 Task 3의 여섯 endpoint로 현장·admin 생성, 기존 현장 admin 지정, 수정, 비밀번호 재설정과 비활성화를 제공한다. Task 8에서 dashboard `site` 실제 계약을 반영하고 pending assigned admin의 customer direct route를 selected/default `siteId` 보존 `/settings?siteId=...` replace로 제한했다. admin은 배정 현장의 주소·단가·시간대·층만 `POST /setup/initial-site`에 보내 최초 설치를 완료하고, 성공 dashboard key 갱신과 prefix invalidate로 guard를 해제한다. 설치 완료 admin은 설정과 등록 조명 0개 모니터링에서 Gateway claim/조명 등록을 사용할 수 있으며 viewer는 이를 볼 수 없다. 설정 메뉴는 admin의 설정 개요·도면 관리·비밀번호 변경과 viewer의 읽기 전용 설정 개요·도면 관리로 축소했다. `POST /auth/change-password` 평문은 React Query mutation/cache에 넣지 않고 component-local request state에만 두며, 성공·화면 이탈 시 제거하고 실패 재시도에는 유지한다. web focused/full test, typecheck와 production build는 통과했지만 Task 9 실백엔드 E2E, 모바일, 재설치와 Raspberry Pi/ESP32-H2 HIL은 아직 완료하지 않았다. |

## 다음 단계

**메뉴 완성 소프트웨어 범위는 이전 계정 계약에서 완료했다.** 해당 Chromium E2E의 operator 현장·층 생성과 commissioning 흐름은 현재 Task 1~8 계정 전환의 완료 증거로 사용하지 않는다. 현재 API 계약은 operator가 Task 3 API와 Task 7 웹 관리 화면으로 pending Site/admin을 provision하고 assigned admin이 Task 4 설치와 Task 5 Gateway claim/registration commissioning을 수행하며, Task 8은 이 흐름의 웹 설치·설정·비밀번호 화면을 연결했다. Task 9 실백엔드 E2E 전환, 실제 Raspberry Pi/ESP32-H2 HIL, 모바일과 재설치는 남아 있다.

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
