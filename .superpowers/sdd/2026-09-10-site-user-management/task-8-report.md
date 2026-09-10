# Task 8 구현 보고서

## 구현 범위

- 로그인·`/auth/me`의 `mustChangePassword`가 참이면 고객/운영자 shell보다 먼저 최초 비밀번호 변경 전용 화면을 렌더링한다.
- 현재 임시 비밀번호, 새 비밀번호, 확인값을 검증하고 비밀번호 변경 성공 후 응답 `user`로 principal cache를 교체한다.
- 실패 시 세 입력값을 제거하고 첫 입력으로 focus를 돌려 재시도할 수 있게 했다.
- 전용 화면 로그아웃과 성공 전환에서 tenant query/mutation, 편집기 상태, 현재 사용자의 활성 명령 복구 정보를 정리한다.
- 일반 설정 비밀번호 변경도 확장 응답 `{ ok: true, user }`를 반영하고 principal cache를 갱신한다.
- `apps/web/src/styles.css`는 수정하지 않고 전용 CSS 파일을 사용했다.

## RED

실행 명령:

```bash
pnpm --filter @led-control/web exec vitest run src/App.test.tsx src/features/auth/RequiredPasswordChangeView.test.tsx src/features/settings/security/PasswordSettingsView.test.tsx
```

확인한 실패:

- 전용 화면 모듈이 없어 신규 테스트 파일이 로드되지 않았다.
- admin/viewer/operator 강제 변경 사용자가 기존 shell과 현장 query를 열었다.
- 설정 비밀번호 변경이 공백-only, 1024자 초과를 차단하지 않았다.
- 성공 응답의 최신 `user`가 principal cache에 반영되지 않았다.

## GREEN

- `changePassword` 응답 타입을 백엔드 계약과 일치시켰다.
- 공통 비밀번호 정책 검증과 오류 매핑을 구현했다.
- `RequiredPasswordChangeView`와 전용 스타일을 구현했다.
- App에 shell보다 앞선 강제 변경 gate와 성공 후 `/monitoring` replace 이동을 추가했다.
- 빠른 연속 제출과 변경/로그아웃 동시 실행을 ref 기반 단일 action gate로 차단했다.
- 요청 중 외부 unmount가 발생하면 완료 응답이 이전 화면 상태를 다시 적용하지 않도록 mounted 상태를 확인한다.

## 검증

- 지정 인증 UI 테스트: 3개 파일, 81개 통과
- Web typecheck: 통과
- Web production build: 통과
- 기존 main chunk 500 kB 초과 경고는 유지되며 이번 기능 오류는 아니다.

## 자체 리뷰

- 평문 비밀번호는 React state와 직접 async 요청에만 존재하며 React Query mutation cache에 저장하지 않는다.
- 강제 변경 상태에서는 shell이 mount되지 않아 dashboard/tenant route query가 시작되지 않는다.
- 실패 경로에서 명령 session block을 해제하고, 성공/로그아웃 경로에서 사용자별 복구 record와 tenant/editor cache를 정리한다.
- Task 8 외 기존 dirty 파일과 계획·메뉴·상태 문서는 수정하거나 stage하지 않는다.
