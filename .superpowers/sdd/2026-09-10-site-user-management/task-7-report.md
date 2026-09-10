# Task 7 구현 보고서

## RED

- 공통 `ModalDialog` 테스트를 먼저 추가하고 실행해 export가 없어 2개 테스트가 실패하는 것을 확인했다.
- 유저 관리 폼과 화면 테스트를 먼저 추가하고 실행해 `SiteUsersView`, `site-user-form` 파일이 없어 suite 2개가 실패하는 것을 확인했다.
- `/settings/users` route 테스트를 먼저 추가하고 실행해 기존 placeholder 때문에 실제 화면 test id를 찾지 못하는 실패를 확인했다.
- 서버에서 동시 100명 제한을 반환하는 테스트를 추가하고 실행해 생성 버튼이 다시 활성화되는 실패를 확인했다.

## GREEN

- `ModalDialog`에 dialog semantics, 제목·설명 연결, Escape, focus trap, focus restore, 배경 클릭 닫기와 pending 중 닫기 차단을 구현했다.
- 사용자 목록의 loading, empty, success, 기존 목록 유지 background refresh error와 재시도를 구현했다.
- 이름·로그인 아이디 검색, 권한·상태 필터, 현재 인원/100 표시를 구현했다.
- 생성·수정·비밀번호 초기화·활성/비활성·영구 삭제 dialog와 검증을 구현했다.
- 생성·초기화의 평문 비밀번호 호출은 `useMutation` 없이 직접 비동기 상태로 처리하고 성공 후 로컬 입력을 지웠다.
- 영구 삭제는 현재 로그인 아이디가 대소문자까지 정확히 일치할 때만 활성화한다.
- API 오류 code를 서버 상세 문구나 PII 없이 안전한 한글 문구로 변환했다.
- 서버가 경쟁 상황에서 `USER_LIMIT_REACHED`를 반환하면 dialog와 상단 생성 버튼을 모두 잠근다.
- `CustomerShell`의 admin 전용 `/settings/users` placeholder를 실제 `SiteUsersView`로 교체했다.
- 기존 `apps/web/src/styles.css`는 수정하거나 stage하지 않고 전용 CSS 파일 두 개를 사용했다.

## 검증

- 지정 테스트: 4개 파일, 55개 통과
- Web typecheck: 통과
- Web production build: 통과
- build 경고: 기존 main chunk 500 kB 초과 경고만 남음

## 자체 리뷰

- 비밀번호는 API 응답, 성공 메시지, React Query cache에 다시 넣지 않는다.
- 수정 요청은 목록의 `updatedAt`을 `expectedUpdatedAt`으로 전달한다.
- 비활성화도 동일 update 계약을 사용하며 서버의 세션 폐기 완료 후 목록을 갱신한다.
- 행 버튼은 lucide 아이콘, `title`, `aria-label`을 함께 제공한다.
- Task 7 이외 기존 dirty 파일은 되돌리거나 포함하지 않았다.
- 남은 우려사항은 기능 결함이 아닌 기존 main bundle 크기 경고다.
