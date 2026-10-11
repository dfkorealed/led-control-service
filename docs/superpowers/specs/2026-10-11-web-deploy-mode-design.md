# 공개 프론트 배포 모드

사용자 요청: 배포 환경변수 플래그 하나로 랜딩 공개에서 전체 서비스 공개로 전환한다. 이전의 ‘수정사항 바로 반영’ 지시에 따라 별도 설계 승인 대기를 반복하지 않고 구현한다.

## 계약

- 단일 선택값 `WEB_DEPLOY_MODE=landing|service`. 미설정은 `landing`, 그 외 값은 빌드/배포 전에 오류. 정적 호스팅이므로 환경변수 변경 후 동일 명령으로 재빌드·재배포한다. 브라우저 런타임 토글은 아니다.
- `landing`: 기존 승인 세 페이지/전화·이메일 상담/준비 중/내부 경로404와 실제 내부 graph·산출물 제외를 유지한다.
- `service`: 최신 기존 관제 Web을 포함하는 운영 산출물을 생성한다. 시안·테스트 자료는 제외하고 공개 페이지 로그인은 같은 origin `/login`으로 활성화한다. 정상 관제 경로의 직접 접속/새로고침을 지원하고 알 수 없는 경로는404. 기존 세션·역할·tenant 인증을 유지한다.
- 운영 API는 현재 `/api` same-origin 계약을 유지한다. CloudFront service 모드에서 명시적으로 미리 설정한 HTTPS API origin으로 `/api/*`를 전달하고 캐시를 끄며 세션 cookie/query/필요 header·메서드를 전달한다. landing은 API를 공개하지 않는다.
- AWS 계정·domain·API origin·TLS·권한은 최초 환경 구성에서 설정한다. 이후 모드 선택을 위해 별도 로그인 URL/라우팅 변수/수동 리소스 수정이 필요하지 않아야 한다. API origin 누락 시 service 실제 배포는 원격 쓰기 전에 실패한다.
- 동일 배포 명령이 모드별 빌드 산출물과 edge/API 설정을 함께 적용한다. stale/wrong-mode 산출물은 거절한다. 릴리스에 모드를 기록하고 전환·롤백 순서/중간 실패 복구를 명시한다. 기존 대상 identity/lock/archive/hash/old assets 보존 관문을 유지한다.
- 실제 AWS credentials/target이 없으므로 코드·fake AWS·local HTTP/browser로 준비한다. 실제 AWS 생성/운영 변경/DB·장비 작업은 수행하지 않는다. 기존 canonical CI 관문을 유지한다.

## 기준과 범위

최신 기본 `cc6b9a7a`의 ATLAS UI·브라우저 주석 교정을 보존한다. 기존 랜딩 배포 구현 `78fab117`/`1b10cd95`를 이 기준에 통합하되 과거 상태판 전체를 덮어쓰지 않는다. 기존 일반 개발 앱 진입과 모바일 bootstrap은 유지한다.

단일 담당이 연결된 Web/배포 계약을 순서대로 구현하고 독립 리뷰로 검증한다. 새로운 SaaS 배포 플랫폼이나 백엔드 provisioning은 추가하지 않는다.
