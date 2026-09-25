# 공개 랜딩 메뉴 기능 현황

기준일: 2026-09-25

## 구현 완료

- `/`를 로그인 없이 볼 수 있는 공개 랜딩으로 분리했다. 공개 화면 진입 때 `/auth/me`를 호출하지 않으며 로그인 링크는 기존 `/login`으로 이동한다.
- 킨다 브랜드 안내, `제품 화면 예시`로 표시한 정적 대시보드, 제품 기능과 시설 운영 담당자·시공/유통 파트너의 흐름을 같은 비중으로 제공한다. 정적 예시는 실제 관제 데이터나 작동하는 데모가 아니다.
- 상담 양식은 회사명·담당자·회신 이메일·문의 내용·개인정보 동의를 필수로, 전화번호·고객 유형을 선택으로 받는다. 동의 안내에 목적·항목·90일 보관·거부 시 온라인 접수 제한·NAVER WORKS 메일 사본 정책을 표시한다. 필드와 4KB 본문을 검사하고 중복 제출을 막는다.
- 공개 API는 동의 버전 `landing-2026-09-v1-90d`, honeypot, IP당 15분 5회 제한, 정규화된 내용의 UUID 멱등 키, DB 트랜잭션 저장을 적용한다. HTTP 201과 접수번호는 **서버 접수**를 뜻한다. 동일 요청을 응답 유실 후 재시도하면 같은 접수번호를 반환하고, 같은 키에 다른 내용이면 409다.
- 오류 시 입력을 보존한다. 429는 잠시 후 재시도를, 메일 연결 준비가 안 된 503은 직접 이메일 문의 링크를 안내한다. 네트워크 오류/타임아웃 뒤 내용이 같으면 같은 멱등 키로 재시도한다.
- 랜딩/양식의 자동 검증에는 320·390·1024·1440px 가로 넘침, 키보드 접근, 축소 동작, 접근성 검사와 공개 경로의 인증 비호출이 포함된다.

## 미구현

- 파일 첨부와 랜딩에서의 계정 생성은 제공하지 않는다.
- 공개 화면에서 실제 고객 현장 데이터를 조회하거나 제어하는 체험 기능은 제공하지 않는다.

## 부족하거나 개선이 필요한 기능

- 실제 NAVER WORKS OAuth 승인, 메일 발송 및 받은편지함 도착은 운영 자격 증명과 배포 환경에서 아직 확인하지 않았다. 201 접수는 이메일 수신을 보증하지 않는다. 운영 설정과 검증 순서는 [메일 연결 운영 절차](../runbooks/landing-mail-setup.md)를 따른다.
- 브라우저의 제출 시나리오는 API 응답 대역을 사용했다. 실제 배포 브라우저에서 API·메일·운영자 확인까지의 전체 여정은 별도 점검이 필요하다.

## 관련 파일

- 화면: [공개 경로](../../apps/web/src/main.tsx), [랜딩](../../apps/web/src/features/landing/LandingPage.tsx), [대시보드 예시](../../apps/web/src/features/landing/DashboardPreview.tsx), [상담 양식](../../apps/web/src/features/landing/InquiryForm.tsx), [웹 API 어댑터](../../apps/web/src/api/landing-inquiries.ts)
- API: [접수 컨트롤러](../../apps/api/src/landing-inquiries/landing-inquiries.controller.ts), [접수 서비스](../../apps/api/src/landing-inquiries/landing-inquiries.service.ts), [DTO](../../apps/api/src/landing-inquiries/landing-inquiry.dto.ts), [요청 제한](../../apps/api/src/landing-inquiries/landing-inquiry-rate-limit.service.ts), [DB 스키마](../database-schema.md)
- 검증: [랜딩 브라우저 테스트](../../apps/web/e2e/landing.spec.ts), [양식 테스트](../../apps/web/src/features/landing/InquiryForm.test.tsx), [접수 서비스 테스트](../../apps/api/src/landing-inquiries/landing-inquiries.service.spec.ts), [요청 크기 테스트](../../apps/api/src/api-body-parser-landing.spec.ts)

## 갱신 규칙

- 공개 경로, 화면 문구·접근성, 상담 필드·동의·보관 정책, API 접수/오류 계약이 바뀌면 이 문서와 영향을 받는 [운영자 메뉴 문서](operator.md)를 같은 작업에서 갱신한다.
- 자동 테스트, 실제 배포 연결, 최종 메일 수신의 검증 상태를 구분해 기록한다.
