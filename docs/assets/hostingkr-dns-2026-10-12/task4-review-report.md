# Task4 및 외부 DNS 후속 전체 리뷰

- 검토 범위: `f31e56fadd27d63f96824bad2ea2c4ef71581b62..9a13a444` (`949fc946` 추적 문서 + `9a13a444` 구현), 지정된 고정 diff package와 task brief/implementation report.
- 역할: 단일 `qa_reviewer`. 제품 코드, 설정, AWS, 자격 증명, DNS를 수정하지 않았다. 이 보고서만 작성했다. 총괄의 진행 중 plan/status 수정은 건드리지 않았다.
- 판정: **핵심 기능 spec 준수 YES, quality Changes requested, whole-followup integration readiness NO**. 아래 Important 1건을 수정한 뒤 같은 리뷰에서 한정 재검토가 필요하다.
- 발견 수: **Critical 0 / Important 1 / Minor 0**.

## 조치가 필요한 발견

### I1 — 새 인증서 재검증에 필요한 배포 역할 권한 누락

- 변경 지점: `scripts/landing/deploy.mjs:116` (`verifyTarget` → `verifyCertificate`), 실제 AWS 호출은 `scripts/landing/deploy.mjs:98`.
- 연관 파일: `infra/landing/oidc-policy.example.json:21`의 permissionsPolicy 전체에 ACM Allow가 없다. 실행서는 `docs/runbooks/kinda-static-landing-aws.md:157`에서 이 정책을 배포 역할 검토 템플릿으로 안내한다.
- 재현 조건: 기존 전용 stack과 발급된 사용자 도메인 인증서가 있고, 문서화된 최소권한 정책을 사용한 배포 역할로 `check --execute`, `deploy --execute`, 또는 `rollback --execute`를 실행한다. 이전 버전은 일반 배포 경로에서 ACM을 읽지 않았으나 이번 변경은 외부/Route 53 사용자 도메인 모두 매번 읽는다. 다른 별도 정책에서 권한을 부여하지 않으면 `acm:DescribeCertificate`에서 AccessDenied가 발생한다. 안전하게 쓰기 전에 중단되지만 기존 사용자 도메인 배포·복구 경로가 막힌다.
- 원인: 인증서 조회를 provisioning 전용 경로에서 일반 배포 preflight로 확장하면서 기존 배포 IAM 예시와 권한 설명을 함께 갱신하지 않았다. Fake AWS는 IAM을 검사하지 않아 22개 계약 테스트로 발견되지 않는다.
- 수정: 정책 예시에 `acm:DescribeCertificate`만 추가하고 Resource를 `arn:aws:acm:us-east-1:ACCOUNT_ID:certificate/EXACT_CERTIFICATE_ID`처럼 승인된 인증서 하나에 제한한다. 실행서에 사용자 도메인 check/deploy/rollback의 이 읽기 권한을 명시한다. 인증서 발급/삭제·DNS 쓰기 권한은 필요하지 않다. 실제 계정 권한 변경은 사용자의 수동 절차로 유지한다.
- 한정 검증: 정책 JSON에 정확한 읽기 Action과 us-east-1의 단일 인증서 placeholder ARN이 있고 광범위한 ACM 권한이 없는지 검증한다. 전체 테스트 재실행이나 실제 AWS 호출은 이 수정의 로컬 검토에 필요하지 않다.
- 근거: AWS는 DescribeCertificate에 `acm:DescribeCertificate`와 certificate ARN resource를 명시한다. [AWS ACM API permissions](https://docs.aws.amazon.com/acm/latest/userguide/authen-apipermissions.html).

## Spec 준수 검토

| 계약 | 검토 결과 |
| --- | --- |
| 명시적 빈 zone만 외부 DNS, missing/malformed 거절 | `deploy.mjs:39–43`은 custom domain에서 string 타입과 empty/유효 Z ID를 구분한다. domain 없이 cert/zone도 거절한다. |
| 같은 계정 us-east-1 인증서, 발급/SAN 확인 | ARN 검증 `deploy.mjs:41`, AWS identity `:95`, ISSUED/SAN `:96–100`. provision과 기존 stack 모두 쓰기 전에 조회한다. 단일 label wildcard의 깊이도 제한한다. |
| 외부 DNS에서 CF alias/cert 유지 | `template.mjs:25–30`의 CustomDomain/ManagedDns 분리, `:48–49`는 계속 CustomDomain, R53 A/AAAA만 `:58–59`에서 ManagedDns를 사용한다. |
| 외부 DNS에는 R53 호출/활성 resource 없음 | provision의 R53 조회는 `hostedZoneId` 조건 안에만 있다. 기존 check/deploy/rollback에 R53 직접 호출이 없고 빈 zone에서 CFN 조건이 false다. |
| 기존 DNS 소유권 보호 | `deploy.mjs:112–116`은 실제 stack의 domain/zone/cert parameter와 config를 비교한다. managed→external, default→custom 등 변경은 lock/S3/CFN 쓰기 이전에 실패한다. 별도 이전 절차 요구는 실행서에 명시되어 있다. |
| 실제 CloudFront target 안내 | `deploy.mjs:126`은 실제 Distribution.DomainName 형식과 CFN DistributionDomain 일치를 확인한다. check와 활성화 완료 뒤 deploy/rollback은 검증된 output으로 안내한다. offline/provision은 null과 unresolved 안내를 유지한다. |
| 기존 계약 보존 | 단일 WEB_DEPLOY_MODE, default 도메인, managed DNS, private S3/OAC, expected owner, 불변 archive/hash, lock/recovery, mode-bound rollback/API 전달/auth 경로는 범위 내 변경으로 완화되지 않았다. |
| 초보자용 HostingKR 실행서 | us-east-1 ACM DNS validation CNAME → ISSUED → provision/wait/output/check → 첫 deploy → 실제 target의 kinda CNAME → dig/smoke 순서가 있다. 검증 CNAME 유지, 상대 이름, NS 위임 불필요, 실제 계정/target만 사용을 명시한다. |
| 배포 관문 및 정직한 상태 | 동일 검토 커밋 canonical 전체 CI 관문이 명시되어 있다. 실제 AWS/DNS/TLS 미검증 및 사용자의 수동 배포를 보존한다. 정책 정합성 I1은 이 관문 전에 수정해야 한다. |

HostingKR 공식 CNAME 문서의 메뉴 경로·서브도메인 입력 안내와 실행서를 대조했다. 실제 계정 UI 또는 DNS 설정은 열거나 조작하지 않았다. [HostingKR CNAME 등록](https://help.hosting.kr/hc/ko/articles/5694434421529). ACM DNS validation 문서에서도 검증 CNAME과 갱신 안내를 확인했다. [AWS ACM DNS validation](https://docs.aws.amazon.com/acm/latest/userguide/dns-validation.html).

## 증거와 한계

- 구현 보고서와 원 로그를 대조했다: 초기 16개 중 6개 실패, 최종 `node --test scripts/landing/*.test.mjs apps/web/scripts/public-deploy-contract.test.mjs`는 22/22 PASS, skip 0. 구현자 환경은 Node 24.19.0 / pnpm 9.15.0이다.
- 동일 테스트를 재실행하지 않았다. 리뷰 중 `git diff --check f31e56fa..9a13a444`는 exit 0이다.
- 최종 테스트는 external provision/check/deploy/rollback, managed ownership guard, invalid issued/SAN, default→custom guard, mode/lock/hash 보존을 다룬다. AWS mock은 실제 IAM/CloudFormation/DNS/TLS 성공 증거가 아니다.
- Node 22, 동일 커밋 canonical full CI, AWS validate/create/update, 실제 ACM/HostingKR DNS/TLS/운영 smoke는 미검증이다. 이번 리뷰는 해당 성공을 주장하지 않는다.
- runbook의 profile 사용은 기존 인증 환경을 전제로 하며 계정 mismatch는 preflight에서 실패한다. 기존 UI/backend/API 구현과 무관한 과거 문제는 범위를 넓혀 재검토하지 않았다.
- 총괄은 I1 수정·재검토 뒤 계획과 상태판을 함께 최신화해야 한다. 현재 문서의 작업 중 표시는 진행 상태이며 완료 증거로 읽지 않았다.

## 전체 후속 준비 상태

핵심 외부 DNS 동작은 요구사항에 맞는다. 다만 새 필수 AWS 읽기 호출과 배포 권한 템플릿이 불일치하므로 현재 whole-followup 병합 준비는 승인하지 않는다. I1의 최소 수정과 한정 정적 검증 후 재검토하면 된다. 코드 통합 승인과 실제 클라우드 배포 성공은 별개이며, 클라우드 성공은 사용자의 동일 커밋 CI 및 수동 실행 확인이 남아 있다.
