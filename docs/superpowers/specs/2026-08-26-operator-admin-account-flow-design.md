# 전역 운영자와 현장 관리자 계정 흐름 설계

기준일: 2026-08-26

## 목적

최초 현장 설치의 주체를 서비스 운영사 `operator`에서 고객사 `admin`으로 변경한다. `operator`는 서비스 전체에 한 명만 존재하며 고객용 관제 기능에는 접근하지 않고, 현장별 단일 admin 계정의 생성·조회·수정·비활성화와 비밀번호 재설정만 담당한다.

이번 범위에는 재설치 기능과 모바일 변경을 포함하지 않는다.

## 확정한 권한 모델

| 역할 | 수량과 범위 | 웹 기능 |
| --- | --- | --- |
| `operator` | 서비스 전체에 정확히 1명 | 현장별 admin 계정 관리만 제공 |
| `admin` | 현장당 1명, 계정당 1개 현장 | 최초 설치, 모니터링, 제어, 통계, 맵 에디터, 본인 비밀번호 변경 |
| `viewer` | 현장당 여러 명 | 기존 현장 읽기 전용 기능 유지 |

- `Site.adminUserId`를 nullable unique 외래키로 두어 현장당 admin 1명과 admin당 현장 1곳을 DB에서 강제한다.
- viewer의 현장 범위는 기존 `SiteMembership`으로 유지한다.
- admin의 현장 접근은 고객사 Organization 전체가 아니라 `Site.adminUserId` 일치 여부로 판정한다.
- 기존 PostgreSQL partial unique index와 bootstrap 절차로 전역 service-provider Organization과 operator가 둘 이상 생성되지 않게 유지한다.

## 로그인 아이디 전환

- 로그인 입력은 이메일이 아닌 `loginId`를 사용한다.
- `loginId`는 4~100자의 영문자, 숫자, 마침표, 밑줄, 하이픈과 `@`만 허용한다. `@`는 기존 이메일 계정의 무손실 이전을 위해 허용할 뿐 이메일 형식을 요구하지 않는다.
- 로그인 아이디는 앞뒤 공백을 제거하고 소문자로 정규화해 전역에서 유일하게 관리한다.
- 기존 `User.email` 값은 migration에서 정규화한 `loginId`의 초기값으로 이전한다. 충돌이 발견되면 migration을 실패시켜 운영자가 데이터를 먼저 정리하게 하며 임의 접미사를 붙이지 않는다.
- 이메일은 로그인 계약에서 제거한다. 기존 viewer 초대에 필요한 연락 이메일은 `Invitation.email`에 남기되 사용자 로그인 식별자로 사용하지 않는다.
- 인증 실패 응답은 존재하지 않는 아이디와 잘못된 비밀번호를 구분하지 않는다.

## Operator 계정 관리 흐름

operator 로그인 시 고객용 메뉴와 route를 렌더링하지 않고 `/operator/site-admins`로 이동한다.

### 생성

operator는 다음 값을 입력한다.

- 고객사명
- 현장명
- admin 이름
- admin 로그인 아이디
- 초기 비밀번호

API는 customer Organization, 설치 대기 Site, admin User와 `Site.adminUserId` 연결을 Serializable transaction 하나에서 생성한다. Site 주소와 전기요금 단가는 admin 설치 전까지 nullable이며, 설치 완료 시 필수값으로 검증한다.

### 조회와 수정

- 목록에는 고객사명, 현장명, admin 이름, 로그인 아이디, 계정 상태, 설치 상태와 최종 변경 시각을 표시한다.
- operator는 admin 이름과 로그인 아이디를 수정할 수 있다.
- 비밀번호 또는 비밀번호 해시는 어떤 조회 API에도 포함하지 않는다.

### 비밀번호 재설정

- operator가 새 초기 비밀번호를 직접 입력해 재설정한다.
- 서버는 새 hash를 저장하고 해당 admin의 모든 기존 세션을 폐기한다.
- 평문 비밀번호는 저장하거나 감사 로그에 기록하지 않는다.

### 비활성화와 교체

- 삭제 UI는 실제 행 삭제 대신 계정을 `disabled`로 변경하고 모든 세션을 폐기한다.
- 현장, 장비, 조명, 전력 및 감사 이력은 보존한다.
- 비활성화 transaction은 `Site.adminUserId`를 null로 바꾸되 기존 사용자를 삭제하지 않는다. 과거 감사 로그의 actor와 운영 이력은 기존 사용자 ID를 계속 참조한다.
- admin이 없는 기존 현장은 operator 목록에 `관리자 미지정`으로 표시한다. operator는 해당 현장을 선택해 새 admin을 생성할 수 있으며, 새 사용자 생성과 `Site.adminUserId` 연결을 원자적으로 처리한다.
- 비활성화 전에 로그아웃과 현장 접근 중단 결과를 명확히 경고한다.

## Admin 최초 설치 흐름

1. operator가 설치 대기 현장과 admin 계정을 생성한다.
2. admin이 발급받은 로그인 아이디와 초기 비밀번호로 로그인한다.
3. 설치 대기 현장에서는 admin용 설정 마법사를 표시한다.
4. admin이 주소, 전기요금 단가(원/kWh), 시간대와 한 개 이상의 층을 입력한다.
5. 서버가 배정된 현장을 갱신하고 층을 transaction으로 생성한다.
6. admin이 Gateway claim, 조명 검색, BLE Mesh provisioning과 조명 정보 설정을 수행한다.
7. 설치가 완료되면 모니터링·제어·통계와 맵 에디터를 사용한다.

서비스 구독 요금제는 도입하지 않는다. 전기요금 단가는 통계의 예상 전기료 계산만을 위해 유지한다.

기존 operator 전용 `setup`, Gateway claim, registration 권한은 admin으로 이전한다. API는 역할 검사뿐 아니라 `Site.adminUserId` 기반 `commission` capability를 함께 확인한다. operator는 고객용 API와 현장 데이터에 접근할 수 없다.

## Admin 설정

admin 설정에는 다음 실제 기능만 노출한다.

- 설정 개요 및 최초 설치 상태
- 층별 도면 목록과 맵 에디터
- 본인 비밀번호 변경

비밀번호 변경은 현재 비밀번호, 새 비밀번호와 확인값을 받는다. 성공하면 현재 세션을 제외한 나머지 세션을 폐기하고 감사 로그를 남긴다. 재설치 기능은 이번 설계와 구현 범위에서 제외한다.

## API 경계

### Operator 전용

- `GET /operator/site-admins`
- `POST /operator/site-admins`
- `POST /operator/sites/:siteId/admin`
- `PATCH /operator/site-admins/:userId`
- `POST /operator/site-admins/:userId/reset-password`
- `DELETE /operator/site-admins/:userId`

첫 번째 POST는 새 고객사·현장·admin을 함께 생성하고, 현장별 POST는 admin이 없는 기존 현장에 교체 admin을 생성한다. 모든 endpoint는 service-provider `operator`만 호출할 수 있다. 응답 DTO는 password 관련 필드를 갖지 않는다.

### Admin 본인 계정

- `POST /auth/change-password`

현재 비밀번호 확인, 비밀번호 정책 검증, hash 교체와 다른 세션 폐기를 하나의 서비스 경계에서 처리한다.

### 설치

- 기존 `POST /setup/initial-site`는 새 현장을 생성하지 않고 admin에게 배정된 설치 대기 현장을 완성하도록 계약을 변경한다.
- 층 추가, Gateway claim과 registration endpoint는 배정된 admin의 `commission` capability를 요구한다.
- 설치 완료 상태는 필수 현장 정보와 최소 한 개 층의 존재로 판정하고 별도 수동 완료 플래그를 두지 않는다.

## UI와 오류 처리

- operator와 고객 역할은 로그인 직후 서로 다른 shell을 사용한다.
- operator가 고객 route를 직접 입력하면 operator 계정 관리 화면으로 replace 이동한다.
- admin이 다른 현장 ID를 입력하면 정보 노출 없이 `404`로 처리한다.
- 중복 로그인 아이디는 입력 필드 오류로 표시한다.
- 계정 생성 transaction이 일부라도 실패하면 고객사·현장·사용자를 모두 rollback한다.
- admin 비활성화와 비밀번호 재설정은 확인 대화상자를 사용하고 중복 제출을 막는다.
- 공개 회원가입 전환 버튼과 admin 초대 가입 흐름은 웹에서 제거한다. 기존 viewer 초대 계약은 삭제하지 않지만 이번 범위에서 새 관리 UI를 구현하지 않는다.

## Migration과 호환성

- migration은 `User.loginId`, `Site.adminUserId`, nullable 설치 전 Site 필드를 추가하고 기존 데이터를 backfill한다.
- 기존 customer admin이 관리하는 현장이 정확히 하나이면 자동 연결한다.
- 현장이 없거나 둘 이상인 기존 customer admin이 있으면 모호한 권한 확대를 방지하기 위해 migration 적용 전 점검 스크립트에서 실패시킨다.
- 애플리케이션 배포는 migration 호환 구간을 거친다. 먼저 새 필드를 읽고 기존 값을 fallback하는 버전, backfill과 제약 적용, 기존 email 로그인 제거 순서로 진행한다.

## 테스트와 완료 조건

### Backend

- 전역 operator 중복 생성 차단
- 현장당 admin 및 admin당 현장 유일성
- operator의 admin CRUD와 비밀번호 비노출
- admin 계정 비활성화·비밀번호 변경 시 세션 폐기
- admin의 자기 현장 설치 성공과 타 현장 접근 차단
- operator의 고객용 setup, monitoring, control API 접근 차단
- 기존 viewer의 여러 계정·읽기 전용 접근 유지

### Web

- operator 전용 shell과 고객 메뉴 미노출
- admin 계정 생성·조회·수정·비밀번호 재설정·비활성화
- 로그인 아이디 기반 로그인과 공개 회원가입 UI 제거
- admin 첫 로그인 설치 마법사, 맵 에디터와 비밀번호 변경
- role별 직접 URL 접근 차단

### E2E

실제 PostgreSQL·Redis·MQTT·API·Web 환경에서 다음 흐름을 브라우저로 검증한다.

`operator 로그인 → 현장/admin 생성 → admin 로그인 → 현장·층 설정 → Gateway claim → 조명 검색·등록 → 모니터링 → 제어 → 통계 → 맵 저장 → 비밀번호 변경 → 재로그인`

Gateway와 ESP32-H2의 실제 무선 동작은 HIL 검증으로 구분한다. 소프트웨어 E2E 성공만으로 실장비 검증 완료라고 기록하지 않는다.

## 문서 갱신 범위

- `docs/project-status.md`
- `docs/database-schema.md`
- `docs/menus/monitoring.md`
- `docs/menus/control.md`
- `docs/menus/settings.md`
- 인증·설치 수동 절차를 담은 기존 운영 문서
