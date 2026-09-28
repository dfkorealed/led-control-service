# IP 비종속 로그인과 양산 ingress 설계

기준일: 2026-09-29

## 목적

개발 Mac의 LAN IP, 사용자의 접속망, 양산 서버의 실제 host IP가 바뀌어도 같은 정식 URL에서 로그인과 세션 사용이 계속되어야 한다. 중앙 클라우드 단일 서비스에서 고객사는 tenant로 분리하며, 브라우저 인증 경로와 Gateway 장비 경로는 고정 DNS와 서로 다른 신뢰 경계를 사용한다.

이번 설계는 현재 장애도 함께 해결한다. 현행 로컬 `.env`와 Lab 인증서는 이전 주소 `192.168.45.69`를 가리키지만 현재 Mac 주소는 `172.30.1.6`이다. Lab network preflight가 전체 API 기동을 차단해 Web만 남고, Vite의 `/api/auth/login` proxy가 500을 반환한다.

## 성공 기준

- 개발자는 Mac의 Wi-Fi·Ethernet·DHCP 주소가 바뀌어도 `http://localhost:<WEB_PORT>`에서 로그인할 수 있다.
- 브라우저 사용자는 회사·모바일·가정 네트워크 사이에서 공인 IP가 바뀌어도 같은 양산 Web 도메인에서 로그인과 기존 세션을 사용할 수 있다.
- 비밀번호와 MFA 사이에 IP가 바뀌어도 유효한 일회성 challenge와 올바른 TOTP·복구 코드라면 로그인이 완료된다.
- IP는 rate limit, 감사, 세션 정보의 관측값으로 유지하지만 세션 또는 MFA의 소유 증명으로 사용하지 않는다.
- 임의 클라이언트가 forwarding header를 위조해 rate limit이나 감사 IP를 바꾸지 못한다.
- Gateway 공개 endpoint가 잘못됐거나 Gateway가 offline이어도 이를 online으로 위장하지 않는다. 로컬 앱 전용 모드에서는 장비 기능을 명시적으로 unavailable/offline으로 취급한다.
- 기존 production mTLS, device/manufacturing certificate guard, tenant authorization과 HttpOnly session cookie 계약을 약화하지 않는다.

## 배포 토폴로지

양산의 기준 토폴로지는 중앙 클라우드 단일 서비스와 고객사별 tenant 분리다.

- Web: `https://app.<service-domain>`
- Gateway MQTT: `mqtts://mqtt.<service-domain>:8883`
- Gateway device API: `https://device.<service-domain>`
- 브라우저 API: Web과 동일 origin의 `/api/*`

사용자에게 노출되는 URL은 IP literal이나 컨테이너 주소를 사용하지 않는다. DNS와 TLS 인증서는 실제 host 교체와 무관한 서비스 identity를 제공한다. Web reverse proxy만 브라우저 트래픽을 내부 `https://api:4000`으로 전달하고, Gateway device API는 기존 9443 raw TLS passthrough처럼 API가 client certificate를 직접 검증하는 별도 ingress를 유지한다.

HTTP 접속은 canonical Web HTTPS origin으로 이동한다. HTTPS 요청의 Host가 canonical host와 다르면 인증 POST를 다른 origin으로 redirect하지 않고 거부해 쿠키와 자격 증명 오전송을 막는다. session cookie는 host-only, `HttpOnly`, production `Secure`, `SameSite=Lax`, `Path=/`를 유지한다.

## 로컬 개발 경로

`DEV_LOCAL_APP_ONLY=1`은 IP가 자주 바뀌는 개발 Mac에서 앱·인증을 검증하기 위한 명시적 모드다. 기존 Lab/HIL 모드는 기본값으로 남고 현재 host가 장비용 공개 주소를 소유하는지 계속 fail-closed 검증한다.

로컬 앱 전용 모드에서는 다음 내부 연결만 loopback으로 고정한다.

- Vite → API: `https://127.0.0.1:<API_PORT>`
- API → 로컬 MQTT broker: `mqtts://127.0.0.1:8883`

TLS 검증을 끄지 않는다. 실제 연결 주소는 loopback이지만 API와 MQTT client는 기존 `LAB_API_DNS`, `LAB_MQTT_DNS`를 TLS server name으로 사용해 인증서를 검증한다. Vite proxy, API MQTT client, command Set MQTT client와 개발 launcher의 사전 handshake가 같은 server-name 계약을 사용한다. 별도의 server-name 환경변수는 추가하지 않는다.

이 모드에서는 stale `LAB_API_IP`, `LAB_MQTT_IP`, `MQTT_PUBLIC_URL` 때문에 API·Web 기동을 막지 않는다. 대신 내부 endpoint가 loopback인지, protocol과 port가 맞는지, TLS server name이 설정된 Lab DNS와 일치하는지를 검증한다. 장비 공개 endpoint는 자동으로 새 IP로 바꾸거나 online으로 간주하지 않으며, 실제 Gateway/HIL 작업 전에는 일반 Lab 모드로 돌아가 현재 네트워크의 PKI와 공개 DNS를 별도 검증해야 한다.

`.env.example`과 Lab bootstrap 산출물은 두 모드를 구분한다. 사용자의 현재 로컬 `.env`에는 앱 전용 모드를 적용하지만 secret, DB 데이터, Gateway identity와 인증서를 초기화하지 않는다.

## 실제 클라이언트 IP 신뢰 경계

API 전역의 `trust proxy`는 켜지 않는다. 같은 API listener가 Web HTTPS proxy와 device raw TLS를 함께 받으므로 전역 forwarding header 신뢰는 장비 ingress의 위조 가능성을 만든다.

Web nginx는 외부 요청의 관련 header를 전달하지 않고 다음 값을 항상 덮어쓴다.

- `X-Web-Ingress-Secret`: 기존 `LANDING_INGRESS_SECRET`을 Web ingress 전체 비밀로 일반화해 주입하는 64자리 hex secret
- `X-Web-Client-IP`: nginx가 관측한 `$remote_addr`

API의 공통 client-address resolver는 secret을 timing-safe 비교한다. 검증된 Web ingress 요청만 `X-Web-Client-IP`를 사용하고, 그 밖의 직접·device 요청은 socket에서 계산된 `request.ip`를 사용한다. `X-Forwarded-For`, `X-Real-IP` 또는 secret 없는 전용 header를 직접 신뢰하지 않는다. 공개 문의와 브라우저 인증은 같은 nginx→API ingress 경계를 사용하므로 하나의 secret을 함께 회전하며, OAuth·메일·MFA 암호화 키와는 재사용하지 않는다.

개발 Vite proxy는 외부 사용자 IP를 신뢰 경계로 전달하지 않는다. 로컬 요청의 loopback 주소가 감사·rate-limit 주소가 되는 것이 정상이다.

## 인증과 MFA의 IP 의미

일반 session lookup은 지금처럼 session token hash, 만료, revoke 상태, 사용자 활성 상태로만 판단한다. IP가 달라졌다는 이유로 session을 revoke하거나 401을 반환하지 않는다.

로그인 MFA challenge는 다음 값과 결속한다.

- 암호학적으로 안전한 256-bit challenge token의 hash key
- user ID와 user row version
- 자동 로그인 선택
- 짧은 TTL
- Redis `GETDEL` 기반 일회성 소비

challenge에 기록된 시작 IP와 User-Agent는 감사·위험 분석용 snapshot으로 보존하되 완료 요청과 정확히 같아야 한다는 조건을 제거한다. 완료 시점의 검증된 client IP와 현재 User-Agent를 새 session과 로그인 성공 감사의 관측값으로 기록한다. TOTP counter 재사용 방지, recovery code 일회성 제거, user row lock과 실패 시 fail-closed 동작은 유지한다.

rate limit은 접속 IP와 account/tenant 차원을 계속 사용한다. 비밀번호 단계와 MFA 완료 단계에서 현재 요청의 검증된 client IP를 사용하므로 IP 변경은 새 버킷으로 관측되지만 정상 challenge를 무효화하지 않는다. challenge는 첫 완료 시도에 소비되므로 잘못된 코드 뒤에는 비밀번호 단계부터 다시 시작한다.

이 결정은 2026-09-12 계정 보안 설계의 “MFA challenge를 접속 IP·User-Agent와 정확히 결속” 규칙을 대체한다. IP 주소는 이동통신 NAT, VPN, 기업망 전환에서 인증 주체의 안정적인 identity가 아니며, challenge token·두 번째 인증 요소·일회성 소비가 소유 증명을 담당한다.

## 양산 설정과 fail-closed 검증

production preflight는 다음을 강제한다.

- `WEB_PUBLIC_URL`과 `WEB_HTTPS_ORIGIN`은 같은 canonical public HTTPS origin이다. canonical host는 `WEB_HTTPS_ORIGIN`에서 시작 시 파생하며 사용자 설정을 추가하지 않는다.
- `MQTT_PUBLIC_URL`은 `localhost`, 사설 container name, IP literal이 아닌 승인된 DNS hostname을 사용한다. 장비 API 공개 주소는 기존 Gateway 배포의 `GATEWAY_BOOTSTRAP_URL`에서 같은 규칙을 검증하며 서버용 중복 환경변수를 추가하지 않는다.
- API의 내부 MQTT URL은 production network의 `mqtt-tls` service identity를 사용한다.
- Web ingress secret은 landing secret과 다르고 정확히 64자리 hex다.
- Web nginx는 client IP/secret header를 overwrite하고 API는 secret 없이는 해당 IP를 신뢰하지 않는다.
- browser origin certificate, device API certificate, MQTT certificate는 각각의 DNS 이름을 SAN으로 포함한다.

이번 변경에서 새로 추가하는 사용자 설정은 `DEV_LOCAL_APP_ONLY` 하나뿐이다. 나머지 값은 기존 `LAB_API_DNS`, `LAB_MQTT_DNS`, `WEB_HTTPS_ORIGIN`, `LANDING_INGRESS_SECRET`, `MQTT_PUBLIC_URL`, `GATEWAY_BOOTSTRAP_URL`에서 파생하거나 기존 의미를 일반화한다.

실제 DNS record, 공인 TLS 발급, cloud load balancer, firewall와 secret 주입은 배포 환경의 책임이다. 저장소는 render/preflight/container smoke로 잘못된 값과 신뢰 경계 우회를 차단하고 runbook에 provisioning·회전·rollback 순서를 제공한다.

## 오류 처리와 사용자 표시

- API가 실행되지 않거나 proxy 연결에 실패하면 Web은 원문 stack 대신 기존 service recovery 화면과 재시도를 제공한다.
- 잘못된 자격 증명은 401, rate limit은 429, Redis challenge/rate-limit 장애는 503을 유지한다.
- IP 변경 자체는 사용자 오류로 표시하지 않는다.
- 로컬 앱 전용 모드에서 Gateway·MQTT 공개 연결이 불가능하면 모니터링과 설정 화면은 장비를 offline/unavailable로 표시하며 로그인은 허용한다.
- production의 DNS/TLS 오설정은 startup 또는 deploy preflight에서 실패시키고 인증서 검증을 끄는 fallback은 두지 않는다.

## 테스트와 검증

### RED→GREEN 계약

- stale Lab LAN IP에서 일반 Lab 모드는 계속 실패하고 `DEV_LOCAL_APP_ONLY=1`만 안전한 loopback 내부 endpoint로 통과한다.
- 로컬 앱 모드가 non-loopback proxy/MQTT endpoint, 잘못된 port/protocol 또는 누락된 TLS server name을 거부한다.
- Vite proxy와 두 API MQTT client가 loopback 연결에서도 지정된 TLS server name을 사용한다.
- 비밀번호 단계 IP와 MFA 완료 IP가 달라도 올바른 challenge/TOTP는 성공하고 완료 IP가 session/audit에 기록된다.
- challenge 재사용, 잘못된 TOTP, 만료, user version 변경은 기존처럼 실패한다.
- 위조한 `X-Web-Client-IP`는 secret 없거나 틀리면 무시되고, nginx가 덮어쓴 header와 올바른 secret만 인증·rate-limit IP가 된다.
- 기존 device mTLS ingress는 Web ingress header를 신뢰하지 않는다.
- production Compose/preflight가 IP literal 공개 URL, secret 재사용·누락과 canonical Web origin 불일치를 거부한다.

### 완료 검증

- API·Web·root 단위 테스트, 타입 검사와 build
- 실제 PostgreSQL·Redis 인증 통합 테스트
- 실제 nginx를 거치는 production browser ingress 계약 테스트
- Playwright 실백엔드 로그인: 일반 로그인, MFA 도중 client-IP 변화, 새 네트워크를 모사한 기존 session `/auth/me`
- production Compose render와 container smoke
- 현재 Mac에서 API/Web 기동 후 실제 로그인과 `/auth/me`

소프트웨어 테스트는 실제 공인 DNS, TLS 발급, CDN/LB, 모바일 통신사 전환과 Gateway HIL을 대신하지 않는다. 양산 오픈 전 staging의 서로 다른 두 외부 네트워크에서 로그인·MFA·session 유지와 Gateway MQTT/device API를 별도로 검증한다.

## 문서 영향

- `docs/runbooks/device-lab-first-install.md`: 로컬 앱 전용 모드와 HIL 복귀 절차
- `docs/runbooks/production-api-web-deployment.md`: canonical DNS, ingress secret, 인증서·회전·staging 검증
- `docs/menus/settings.md`: MFA와 session의 IP 의미 및 검증 한계
- `docs/lesson_leared.md`: LAN IP에 전체 앱 기동을 결합한 실패와 예방 규칙
- `docs/project-status.md`: 구현·검토·운영 검증 상태

## 제외

- 특정 cloud provider 계정에서 DNS·load balancer·WAF를 실제 생성하는 작업
- 공인 도메인 구매와 production secret·certificate 발급
- 다중 region active-active, global session replication과 zero-downtime orchestration
- 사용자 위치 기반 차단, impossible-travel 탐지와 device fingerprinting
- 실제 Gateway를 현재 Mac의 새 네트워크로 원격 이전하거나 online으로 위장하는 작업
