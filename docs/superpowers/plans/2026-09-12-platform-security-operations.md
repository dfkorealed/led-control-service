# 플랫폼 계정 보안 운영 구현 계획

기준일: 2026-09-12

## 진행 체크리스트

- [x] Task 1. MFA·세션 데이터 모델과 migration, 암호화/TOTP 기반 모듈을 테스트 우선으로 구현한다.
- [x] Task 2. Redis 기반 로그인 IP·계정·고객사/IP 제한과 감사 기록을 구현한다.
- [x] Task 3. MFA 등록·확인·로그인·복구 코드·해제 API와 세션 회전을 구현한다.
- [x] Task 4. 세션 목록·개별 종료·다른 세션 전체 종료 API와 권한 변경 시 세션 폐기를 구현한다.
- [x] Task 4-A. 로그인 제한 통합 테스트를 시나리오별 Redis namespace와 소유 범위 cleanup으로 격리하고, 명시적 hop/IP/CIDR만 허용하는 reverse proxy 신뢰 설정을 검증한다.
- [x] Task 5. 로그인 MFA 단계와 admin/operator 계정 보안 UI를 실제 API에 연결한다. 계정별 MFA·세션 cache 격리와 지연 mutation principal guard를 포함하며 Web unit 705개, typecheck, production build와 focused Chromium E2E를 통과했다.
- [ ] Task 6. 일회용 PostgreSQL·Redis 통합, 웹 접근성·회귀, 전체 품질 게이트를 실행하고 문서를 최신화한다.

## 완료 조건

- 로그인 제한 저장소 장애에서 비밀번호 검증과 세션 발급이 진행되지 않는다.
- MFA 활성 계정은 비밀번호만으로 세션을 받을 수 없고 TOTP 또는 미사용 복구 코드가 필요하다.
- 비밀번호·MFA·권한 변경 전 발급된 토큰은 이후 보호 API에서 `401`이 된다.
- 사용자는 실제 활성 세션만 조회하고 소유한 세션만 종료할 수 있다.
- 설정 보안 UI와 operator 보안 UI가 loading, empty, success, error 상태를 모두 제공한다.
- schema 변경은 `docs/database-schema.md`, 설정 UI 변경은 `docs/menus/settings.md`, 전체 진행은 `docs/project-status.md`에 반영한다.
