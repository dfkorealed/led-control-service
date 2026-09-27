# 운영자 상담 문의 메뉴 기능 현황

기준일: 2026-09-27

## 구현 완료

- 운영자 전용 `/operator/landing-inquiries` 메뉴에서 최근 상담 문의와 메일 상태를 조회한다. 기존 운영자 기본 경로 `/operator/site-admins`를 유지하며, 익명 요청은 401, 고객 admin/viewer 요청은 403으로 차단한다. 화면도 operator 이외 역할을 고객 모니터링으로 돌린다.
- 문의 목록은 접수번호·접수일·회사/담당자·회신 정보·내용·발송 상태를 최근순으로 보여주고 불투명 커서로 20건씩 이전/다음 페이지를 이동하며, 이후 페이지 조회 실패 중에도 이전 페이지로 돌아갈 수 있다. 만료된 문의는 조회에서 제외한다. 응답은 `Cache-Control: no-store`이며 토큰, 내부 문의 ID와 제공자 응답 원문은 노출하지 않는다.
- 공개 요금제 페이지에서 선택한 Basic/Plus는 별도 DB 필드 없이 기존 문의 `message`의 `선택한 요금제:` 머리말로 접수된다. 운영자는 본문을 바꾼 고객의 문의에서도 이 머리말로 선택 맥락을 확인할 수 있다.
- `GET /operator/landing-mail/status`로 로컬 연결 상태를 확인하고, 미연결 또는 기존 연결을 교체할 때 `POST /operator/landing-mail/authorize`로 독립 NAVER WORKS 구성원 OAuth를 시작한다. `mail` 범위의 인가 URL만 브라우저 이동을 허용한다. 연결된 상태에도 `NAVER WORKS 다시 연결`을 제공한다. 새 인가 시작은 이전 URL을 무효화하며, 단회 10분 state와 PostgreSQL 잠금으로 오래된 callback의 덮어쓰기를 거부한다. 공개 Web origin의 `/api/landing-mail/oauth/callback`은 토큰을 암호화 저장하고 같은 origin의 운영자 문의 화면으로 돌려보낸다. 명시적으로 거부된 refresh 자격 증명은 미연결과 새 문의 503으로 전환하며 일시 장애는 연결을 유지한다.
- 메일 worker는 시작 시와 30초마다 대기 문의를 처리한다. NAVER WORKS HTTP 202만 `provider_accepted`와 응답 후 수락 시각으로 기록하고 `queued`, `retry_wait`, `delivery_uncertain`, `failed`를 구분한다. 호출 전 OAuth 오류 또는 확정 429 거부만 제한적으로 재시도하며 수락 여부가 불확실하면 중복 전송을 막기 위해 닫는다.
- 접수 후 90일이 지난 문의 원본과 발송 메타데이터를 한 번에 최대 100건씩 삭제한다. `landing_inquiry_prune` JSON 이벤트의 숫자 `deletedCount`로 실제 삭제 건수(0 포함)를 관측한다. 삭제 대기 중에도 만료된 문의는 목록과 발송 대상에서 제외한다.
- 소프트웨어 검증은 API의 권한·OAuth·PostgreSQL worker 통합 테스트와 Web 운영자 화면·Chromium 경로 검사를 통과했다.

## 미구현

- 운영자 수동 재발송 버튼/API와 자동 불확실 결과 재발송은 제공하지 않는다.
- NAVER WORKS 받은편지함 도착 여부를 서비스 안에서 확인하는 기능은 제공하지 않는다.

## 부족하거나 개선이 필요한 기능

- 실제 운영 자격 증명으로 OAuth 연결, 발송 및 받은편지함 수신을 아직 검증하지 않았다. 화면의 `연결됨`은 로컬 토큰 준비 상태이고 `제공자 수락`은 HTTP 202이며 최종 수신 증거가 아니다. [운영 절차](../runbooks/landing-mail-setup.md)에 따라 배포 후 확인한다.
- `delivery_uncertain` 또는 `failed`는 접수번호를 NAVER WORKS 보낸메일·수신 상태와 대조하고 회신 필요 여부를 운영자가 판단해야 한다. worker가 중단되거나 대량 만료 백로그가 쌓이면 물리적 삭제가 늦을 수 있다. 메일 사본은 NAVER WORKS 보유 정책을 따른다.

## 관련 파일

- 화면: [운영자 셸](../../apps/web/src/features/operator/OperatorShell.tsx), [문의 화면](../../apps/web/src/features/operator/LandingInquiriesView.tsx), [웹 API 어댑터](../../apps/web/src/api/landing-inquiries.ts)
- API: [문의 조회](../../apps/api/src/landing-inquiries/operator-landing-inquiries.controller.ts), [연결 경로](../../apps/api/src/landing-inquiries/landing-mail.controller.ts), [OAuth](../../apps/api/src/landing-inquiries/landing-mail-oauth.service.ts), [전송](../../apps/api/src/landing-inquiries/landing-mail.transport.ts), [worker](../../apps/api/src/landing-inquiries/landing-mail.worker.ts), [DB 스키마](../database-schema.md)
- 검증: [문의 조회 권한 테스트](../../apps/api/src/landing-inquiries/operator-landing-inquiries.controller.spec.ts), [OAuth 통합 테스트](../../apps/api/src/landing-inquiries/landing-mail-oauth.integration.spec.ts), [worker 통합 테스트](../../apps/api/src/landing-inquiries/landing-mail.worker.integration.spec.ts), [운영자 화면 테스트](../../apps/web/src/features/operator/LandingInquiriesView.test.tsx), [랜딩 브라우저 테스트](../../apps/web/e2e/landing.spec.ts)

## 갱신 규칙

- 운영자 권한, 조회 항목·페이지 방식, OAuth 설정·연결 상태, 전송 결과·재시도, 90일 삭제가 바뀌면 이 문서와 [공개 랜딩 문서](landing.md), [운영 절차](../runbooks/landing-mail-setup.md)를 같은 작업에서 갱신한다.
- API 대역·격리 DB 검증과 실제 NAVER WORKS 연결·수신 검증을 별도로 기록한다.
