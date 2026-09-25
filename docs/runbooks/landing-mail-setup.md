# 킨다 상담 문의 메일 연결 운영 절차

기준일: 2026-09-25

이 절차는 관제 서비스의 독립 NAVER WORKS 연결을 설정한다. 회사 홈페이지의 애플리케이션, 토큰 또는 암호화 키를 공유하지 않는다. 실제 OAuth 승인·메일 발송·받은편지함 수신은 아직 확인하지 않았다.

## 배포 전 설정

1. NAVER WORKS에서 **이 서비스 전용 애플리케이션**을 만들고 구성원 OAuth의 `mail` 범위를 허용한다. 발신할 구성원 계정의 메일 주소와 전송 권한을 확인한다. 애플리케이션의 Client ID와 Client Secret은 서버 secret store에만 보관한다.
2. 외부 HTTPS에서 API로 도달하는 callback의 **정확한 전체 URL**을 NAVER WORKS에 등록하고 `LANDING_NAVER_WORKS_REDIRECT_URI`에도 한 글자까지 동일하게 설정한다. 경로는 반드시 `GET /landing-mail/oauth/callback`이며, URL에 query·fragment·사용자 정보가 없어야 한다. 예를 들어 배포 API 호스트가 `api.example.com`이면 `https://api.example.com/landing-mail/oauth/callback` 형식이다. 예시 호스트를 그대로 등록하지 않는다. callback 완료 후의 상대 경로 `/operator/landing-inquiries?mail=connected`가 운영자 웹 화면으로 이동하도록 배포 라우팅도 확인한다.
3. 서버 환경 변수 또는 secret store에 아래 다섯 항목을 설정한다. 값을 문서·커밋·브라우저 설정에 기록하지 않는다.

| 변수 | 값의 조건 |
| --- | --- |
| `LANDING_NAVER_WORKS_CLIENT_ID` | 위 독립 애플리케이션의 Client ID |
| `LANDING_NAVER_WORKS_CLIENT_SECRET` | 같은 애플리케이션의 Client Secret |
| `LANDING_NAVER_WORKS_REDIRECT_URI` | 등록한 HTTPS callback 전체 URL과 정확히 일치 |
| `LANDING_NAVER_WORKS_SENDER` | 메일 발신 구성원의 고정 이메일 주소. NAVER WORKS `/users/{userId}/mail` 경로에 사용됨 |
| `LANDING_MAIL_TOKEN_KEY` | 암호학적으로 생성한 32바이트 난수의 **표준 Base64** 인코딩. AES-256-GCM 토큰 암호화에 사용 |

키 생성은 보안이 통제된 환경에서 `openssl rand -base64 32` 같은 명령을 사용하고 결과를 secret store에만 넣는다. 기존 암호화 키를 잃거나 바꾸면 저장된 토큰을 읽을 수 없으므로 새 연결 절차가 필요하다. 수신자는 서버 코드에서 `kymkjh2002@dfkorealed.com`으로 고정되어 있고 문의자의 이메일을 발신자로 쓰지 않는다. 배포 DB에는 [스키마](../database-schema.md)의 두 landing migration이 적용되어야 한다. 운영 DB의 migration은 별도 승인 절차에 따라 적용한다.

## 최초 연결과 상태 확인

1. 운영자 계정으로 로그인해 `/operator/landing-inquiries`를 연다. 고객 admin/viewer는 이 화면 및 연결 API를 사용할 수 없다.
2. `NAVER WORKS 메일 연결`이 `연결되지 않음`이면 `NAVER WORKS 연결`을 누른다. 서버가 발급한 NAVER WORKS 인가 화면에서 **위 발신 구성원**으로 승인한다. 인가 `state`는 10분 동안 한 번만 유효하므로 만료 또는 실패 시 화면에서 새로 시작한다.
3. callback 성공 후 운영자 화면으로 돌아오면 연결 상태를 다시 조회해 `연결됨`을 확인한다. `GET /operator/landing-mail/status`의 `connected: true`는 현재 설정·토큰 복호화·refresh 만료일에 대한 **로컬 준비 상태**다. 원격 계정의 권한 회수나 실제 발송 가능성을 보증하지 않는다.
4. 배포 환경에서 운영자가 승인한 실제 상담 문의로 발송 결과와 수신함을 별도로 확인한다. 테스트 대역의 성공, 화면의 `연결됨`, 접수번호, `제공자 수락`만으로 실제 도착을 판정하지 않는다.

새 문의 `POST /landing/inquiries`의 HTTP 201과 접수번호는 DB 저장 완료를 뜻한다. 메일 연결 준비가 안 된 상태에서는 새 문의를 저장하지 않고 HTTP 503을 반환하며, 공개 양식은 직접 이메일 문의 링크를 안내한다. 이미 저장된 동일 요청의 재시도는 연결 장애 중에도 같은 접수번호를 돌려줄 수 있다. NAVER WORKS 전송의 HTTP 202만 `provider_accepted`로 기록한다. 202는 제공자의 **요청 수락**이지 받은편지함 도착 확인이 아니다.

## 장애와 수락 여부 불확실 처리

운영자 목록은 접수번호, 회신 정보, 문의 내용과 `queued`(발송 대기), `retry_wait`(재시도 대기), `provider_accepted`(제공자 수락), `delivery_uncertain`(수락 여부 불확실), `failed`(발송 실패)를 보여준다. 목록은 최근순 20건씩 다음/이전 페이지를 조회하며, 만료된 문의는 표시하지 않는다. 문의에는 개인정보가 있으므로 운영자 권한으로만 조회한다.

| 징후 | 운영 절차 |
| --- | --- |
| 연결되지 않음 또는 새 문의 503 | 다섯 서버 설정, callback 등록값, 발신 계정 권한과 DB 연결을 확인한다. 운영자 화면에서 새 OAuth 연결을 시작한다. `connected: true`만으로 원격 권한을 단정하지 않는다. |
| `queued` 또는 `retry_wait` 지속 | API worker 실행 상태와 DB 연결을 확인한다. worker는 시작 시와 30초 간격으로 처리한다. 메일 호출 전 OAuth 실패나 확정된 429 거부는 최대 5회, 1·2·4·8분 간격으로 재시도한다. |
| `delivery_uncertain` | 접수번호와 시각을 기준으로 NAVER WORKS 보낸메일·수신 상태를 확인하고, 필요하면 담당자에게 회신 필요 여부를 확인한다. 네트워크 단절·타임아웃·5xx 또는 worker lease 만료 후 이미 수락됐을 수 있으므로 자동 재발송하지 않는다. |
| `failed` | `lastErrorCode`와 발신 계정·권한·설정을 확인하고 보낸메일/수신 상태 및 회신 필요 여부를 대조한다. 화면과 API에는 수동 재발송 기능이 없다. |
| `provider_accepted`인데 수신자가 못 받음 | NAVER WORKS 보낸메일과 고정 수신함의 스팸·필터·전달 정책을 확인한다. 202 수락은 최종 수신을 증명하지 않는다. |

공개 양식의 네트워크 오류·타임아웃은 접수 결과를 모르는 상태다. 사용자가 내용을 바꾸지 않고 재시도하면 같은 멱등 키를 사용하므로 기존 접수번호를 재확인한다. IP 제한은 15분에 5회이며 초과하면 429를 반환한다. 입력 제한, 동의 버전 및 4KB 본문 제한을 완화하지 않는다. 제공자 요청·자격 증명·문의 원문을 임의 로그에 기록하지 않는다.

## 90일 보관·삭제 확인

문의 원본, 동의 버전·시각, 발송 상태·시도 기록은 접수 후 90일 만료 시각을 가진다. worker가 시작 시와 30초마다 만료 행을 최대 100건씩 삭제하며, 원본과 같은 행의 발송 기록이 함께 제거된다. 만료된 행은 삭제 대기 중에도 발송 및 운영자 목록에서 제외된다. 중단이나 대량 백로그가 있으면 물리적 삭제가 늦어질 수 있으므로 건수만 기록하는 삭제 로그와 DB 만료 잔여량을 확인하고 worker 상태를 복구한다. NAVER WORKS 보낸메일·수신함 사본은 이 삭제 대상이 아니며 제공자의 보유 정책을 따른다.

구현 근거: [OAuth 서비스](../../apps/api/src/landing-inquiries/landing-mail-oauth.service.ts), [운영자 연결 API](../../apps/api/src/landing-inquiries/landing-mail.controller.ts), [메일 전송](../../apps/api/src/landing-inquiries/landing-mail.transport.ts), [worker](../../apps/api/src/landing-inquiries/landing-mail.worker.ts), [운영자 화면](../../apps/web/src/features/operator/LandingInquiriesView.tsx). 제공자 호출은 테스트 대역을 사용했으며 [OAuth 테스트](../../apps/api/src/landing-inquiries/landing-mail-oauth.service.spec.ts), [worker 통합 테스트](../../apps/api/src/landing-inquiries/landing-mail.worker.integration.spec.ts), [운영자 화면 테스트](../../apps/web/src/features/operator/LandingInquiriesView.test.tsx)에서 소프트웨어 동작을 확인했다.
