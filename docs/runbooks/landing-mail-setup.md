# 킨다 상담 문의 메일 연결 운영 절차

기준일: 2026-09-25

이 절차는 관제 서비스의 독립 NAVER WORKS 연결을 설정한다. 회사 홈페이지의 애플리케이션, 토큰 또는 암호화 키를 공유하지 않는다. 실제 OAuth 승인·메일 발송·받은편지함 수신은 아직 확인하지 않았다.

## 배포 전 설정

1. NAVER WORKS에서 **이 서비스 전용 애플리케이션**을 만들고 구성원 OAuth의 `mail` 범위를 허용한다. 발신할 구성원 계정의 메일 주소와 전송 권한을 확인한다. 애플리케이션의 Client ID와 Client Secret은 서버 secret store에만 보관한다.
2. `WEB_PUBLIC_URL`과 `WEB_HTTPS_ORIGIN`을 동일한 공개 웹 HTTPS origin으로 설정한다. NAVER WORKS에 **그 origin의 `/api/landing-mail/oauth/callback` 전체 URL**을 등록하고 `LANDING_NAVER_WORKS_REDIRECT_URI`에 정확히 같은 문자열을 넣는다. 예: `https://web.example.com/api/landing-mail/oauth/callback`. 예시 호스트를 그대로 사용하지 않는다. query·fragment·사용자 정보는 금지한다. API 전용 origin이나 `/api` 없는 경로는 지원하지 않는다. Web nginx가 `/api/`를 제거해 내부 `GET /landing-mail/oauth/callback`으로 전달하고, 성공 시 같은 Web origin의 `/operator/landing-inquiries?mail=connected`로 이동한다.
3. standalone production Compose의 **명시적 `PRODUCTION_ENV_FILE`**에 아래 다섯 항목을 secret store에서 주입한다. 일반 shell 환경 변수만 설정해도 된다고 가정하지 않는다. `production-compose-config.mjs`는 shell 비밀값을 상속하지 않는다. 다섯 값은 API container에만 전달되며 Web build/browser에는 제공하지 않는다. 미설정값은 빈 문자열로 전달되어 새 문의 접수가 미연결 상태로 닫힌다.

| 변수 | 값의 조건 |
| --- | --- |
| `LANDING_NAVER_WORKS_CLIENT_ID` | 위 독립 애플리케이션의 Client ID |
| `LANDING_NAVER_WORKS_CLIENT_SECRET` | 같은 애플리케이션의 Client Secret |
| `LANDING_NAVER_WORKS_REDIRECT_URI` | Web origin의 등록된 HTTPS `/api/landing-mail/oauth/callback` 전체 URL과 정확히 일치 |
| `LANDING_NAVER_WORKS_SENDER` | 메일 발신 구성원의 고정 이메일 주소. NAVER WORKS `/users/{userId}/mail` 경로에 사용됨 |
| `LANDING_MAIL_TOKEN_KEY` | 암호학적으로 생성한 32바이트 난수의 **표준 Base64** 인코딩. AES-256-GCM 토큰 암호화에 사용 |

별도로 **필수** `LANDING_INGRESS_SECRET`을 같은 env 파일에 설정한다. 보안이 통제된 환경에서 `openssl rand -hex 32`로 독립 난수를 생성하며 정확히 64자리 소문자 hex여야 한다. OAuth secret·토큰 암호화 키와 재사용하지 않는다. 이 값은 API와 Web nginx runtime에만 전달된다. nginx는 브라우저가 보낸 `X-Landing-Ingress-Secret`·`X-Landing-Client-IP`를 각각 이 비밀과 실제 연결의 `$remote_addr`로 덮어쓴다. API는 상수 시간 비밀 비교와 단일 IP 검증을 통과한 공개 문의만 처리한다. 다른 container·클라이언트·로그·정적 번들에 값을 넣지 않는다.

지원 topology는 인터넷 방문자 → Web nginx 8443 → 내부 API 4000이다. API는 host port를 직접 게시하지 않는다. 장비용 Web 9443은 같은 API로 TLS를 그대로 전달하므로 **전역 `API_TRUST_PROXY`를 설정하지 않는다**. 9443 직접 문의는 인증 헤더가 없어 503으로 거부된다. 추가 CDN/LB를 앞에 붙이면 현재 계약에서는 그 LB가 한 방문자로 계산되므로, 별도의 검토 없이 클라이언트 XFF를 신뢰하지 않는다. 비밀 누락은 Compose render를 실패시키고, 형식·API/Web 불일치·origin 불일치·전역 proxy trust는 preflight에서 거부한다. 교체 시 API/Web을 같은 유지보수 창에서 갱신하며 불일치 중 새 접수는 503이다.

운영 승인 전 검사는 값을 출력하지 않는 아래 명령으로 수행한다. env 파일은 제한된 권한으로 보관하고 raw `docker compose config`·`docker inspect`·nginx 전체 설정을 출력하지 않는다.

```bash
node -- scripts/production-compose-config.mjs check --project "$PRODUCTION_COMPOSE_PROJECT" --env-file "$PRODUCTION_ENV_FILE"
```

토큰 암호화 키 생성은 보안이 통제된 환경에서 `openssl rand -base64 32` 같은 명령을 사용하고 결과를 secret store에만 넣는다. 기존 암호화 키를 잃거나 바꾸면 저장된 토큰을 읽을 수 없으므로 새 연결 절차가 필요하다. 수신자는 서버 코드에서 `kymkjh2002@dfkorealed.com`으로 고정되어 있고 문의자의 이메일을 발신자로 쓰지 않는다. 배포 DB에는 [스키마](../database-schema.md)의 세 landing migration이 적용되어야 한다. 운영 DB의 migration은 별도 승인 절차에 따라 적용한다.

## 최초 연결과 상태 확인

1. 운영자 계정으로 로그인해 `/operator/landing-inquiries`를 연다. 고객 admin/viewer는 이 화면 및 연결 API를 사용할 수 없다.
2. `NAVER WORKS 메일 연결`이 `연결되지 않음`이면 `NAVER WORKS 연결`, 기존 계정을 바꾸거나 권한을 복구하려면 `NAVER WORKS 다시 연결`을 누른다. 서버가 발급한 NAVER WORKS 인가 화면에서 **위 발신 구성원**으로 승인한다. 인가 `state`는 10분 동안 한 번만 유효하다. 새 연결 시작은 모든 운영자의 이전 미완료 URL을 무효화한다. 만료·실패·대체된 URL은 화면에서 새로 시작한다.
3. callback 성공 후 운영자 화면으로 돌아오면 연결 상태를 다시 조회해 `연결됨`을 확인한다. `GET /operator/landing-mail/status`의 `connected: true`는 현재 설정·토큰 복호화·refresh 만료일에 대한 **로컬 준비 상태**다. 원격 계정의 권한 회수나 실제 발송 가능성을 보증하지 않는다. Refresh에서 400/401과 명시적 `invalid_grant`, `invalid_client`, `unauthorized_client`, `invalid_scope`를 받거나 새 토큰의 scope가 명시적으로 `mail`을 제외하면 저장 자격 증명을 제거해 미연결/새 접수 503으로 전환한다. 429·5xx·네트워크 오류와 알 수 없는 응답은 기존 연결을 유지하며 일시 장애로 처리한다.
4. 배포 환경에서 운영자가 승인한 실제 상담 문의로 발송 결과와 수신함을 별도로 확인한다. 테스트 대역의 성공, 화면의 `연결됨`, 접수번호, `제공자 수락`만으로 실제 도착을 판정하지 않는다.

새 문의 `POST /landing/inquiries`의 HTTP 201과 접수번호는 DB 저장 완료를 뜻한다. 메일 연결 준비가 안 된 상태에서는 새 문의를 저장하지 않고 HTTP 503을 반환하며, 공개 양식은 직접 이메일 문의 링크를 안내한다. 이미 저장된 동일 요청의 재시도는 연결 장애 중에도 같은 접수번호를 돌려줄 수 있다. NAVER WORKS 전송의 HTTP 202만 `provider_accepted`로 기록하며 `providerAcceptedAt`은 응답을 받은 뒤의 서버 시각이다. 202는 제공자의 **요청 수락**이지 받은편지함 도착 확인이 아니다.

## 장애와 수락 여부 불확실 처리

운영자 목록은 접수번호, 회신 정보, 문의 내용과 `queued`(발송 대기), `retry_wait`(재시도 대기), `provider_accepted`(제공자 수락), `delivery_uncertain`(수락 여부 불확실), `failed`(발송 실패)를 보여준다. 목록은 최근순 20건씩 다음/이전 페이지를 조회하며, 만료된 문의는 표시하지 않는다. 문의에는 개인정보가 있으므로 운영자 권한으로만 조회한다.

| 징후 | 운영 절차 |
| --- | --- |
| 연결되지 않음 또는 새 문의 503 | 다섯 메일 설정, API/Web ingress 비밀 일치, callback 등록값, 발신 계정 권한과 DB 연결을 확인한다. 운영자 화면에서 새 OAuth 연결을 시작한다. `connected: true`만으로 원격 권한을 단정하지 않는다. |
| `queued` 또는 `retry_wait` 지속 | API worker 실행 상태와 DB 연결을 확인한다. worker는 시작 시와 30초 간격으로 처리한다. 메일 호출 전 OAuth 실패나 확정된 429 거부는 최대 5회, 1·2·4·8분 간격으로 재시도한다. |
| `delivery_uncertain` | 접수번호와 시각을 기준으로 NAVER WORKS 보낸메일·수신 상태를 확인하고, 필요하면 담당자에게 회신 필요 여부를 확인한다. 네트워크 단절·타임아웃·5xx 또는 worker lease 만료 후 이미 수락됐을 수 있으므로 자동 재발송하지 않는다. |
| `failed` | `lastErrorCode`와 발신 계정·권한·설정을 확인하고 보낸메일/수신 상태 및 회신 필요 여부를 대조한다. 화면과 API에는 수동 재발송 기능이 없다. |
| `provider_accepted`인데 수신자가 못 받음 | NAVER WORKS 보낸메일과 고정 수신함의 스팸·필터·전달 정책을 확인한다. 202 수락은 최종 수신을 증명하지 않는다. |

공개 양식의 네트워크 오류·타임아웃은 접수 결과를 모르는 상태다. 사용자가 내용을 바꾸지 않고 재시도하면 같은 멱등 키를 사용하므로 기존 접수번호를 재확인한다. IP 제한은 15분에 5회이며 초과하면 429를 반환한다. 입력 제한, 동의 버전 및 4KB 본문 제한을 완화하지 않는다. 제공자 요청·자격 증명·문의 원문을 임의 로그에 기록하지 않는다.

## 90일 보관·삭제 확인

문의 원본, 동의 버전·시각, 발송 상태·시도 기록은 접수 후 90일 만료 시각을 가진다. worker가 시작 시와 30초마다 만료 행을 최대 100건씩 삭제하며, 원본과 같은 행의 발송 기록이 함께 제거된다. 만료된 행은 삭제 대기 중에도 발송 및 운영자 목록에서 제외된다. 중단이나 대량 백로그가 있으면 물리적 삭제가 늦어질 수 있으므로 `operation: "landing_inquiry_prune"`, 숫자 `deletedCount`(0~100)를 담는 production JSON 로그와 DB 만료 잔여량을 확인하고 worker 상태를 복구한다. NAVER WORKS 보낸메일·수신함 사본은 이 삭제 대상이 아니며 제공자의 보유 정책을 따른다.

구현 근거: [OAuth 서비스](../../apps/api/src/landing-inquiries/landing-mail-oauth.service.ts), [운영자 연결 API](../../apps/api/src/landing-inquiries/landing-mail.controller.ts), [메일 전송](../../apps/api/src/landing-inquiries/landing-mail.transport.ts), [worker](../../apps/api/src/landing-inquiries/landing-mail.worker.ts), [운영자 화면](../../apps/web/src/features/operator/LandingInquiriesView.tsx). 제공자 호출은 테스트 대역을 사용했으며 [OAuth 테스트](../../apps/api/src/landing-inquiries/landing-mail-oauth.service.spec.ts), [worker 통합 테스트](../../apps/api/src/landing-inquiries/landing-mail.worker.integration.spec.ts), [운영자 화면 테스트](../../apps/web/src/features/operator/LandingInquiriesView.test.tsx)에서 소프트웨어 동작을 확인했다.
