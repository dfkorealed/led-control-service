# Task4 I1 수정 재검토

- 대상: `9a13a444..ffbd8b09`, 고정 diff package `review-9a13a444..ffbd8b09.diff`와 갱신된 구현 보고서 및 `logs/task4-fix-*.log`.
- 범위: I1 수정의 정책 예시, 실행서, 회귀 계약만 검토했다. 원 기능 spec 판정은 앞선 `task4-review-report.md`를 따른다. 제품 변경이나 테스트 재실행, 실제 IAM/AWS/DNS 호출·변경은 없었다. 이 보고서만 작성했다.

## 판정

- **I1 ADDRESSED.**
- 신규 **Critical 0 / Important 0 / Minor 0**.
- 최종 **spec compliance YES / quality APPROVED / whole-followup source integration readiness YES**.
- 이 판정은 `f31e56fa..9a13a444` 원 리뷰와 `9a13a444..ffbd8b09` 한정 수정 리뷰를 합친 결과다. 전체 클라우드 배포 성공 판정은 아니다.

## 확인 내용

`infra/landing/oidc-policy.example.json:96–102`에 `acm:DescribeCertificate` Allow 하나를 추가했다. Resource는 같은 계정의 `us-east-1` 인증서 하나를 지정하는 `arn:aws:acm:us-east-1:ACCOUNT_ID:certificate/EXACT_CERTIFICATE_ID`이다. ACM 와일드카드나 발급·삭제·내보내기 권한을 추가하지 않았으며 기존 trust 및 다른 권한은 변경하지 않았다. 따라서 원 finding의 새 필수 인증서 조회와 배포 역할 예시의 불일치를 해결했다.

`docs/runbooks/kinda-static-landing-aws.md:157`은 외부 DNS와 Route 53 사용자 도메인 모두 check/deploy/rollback에 이 읽기 권한이 필요함을 설명한다. config의 실제 인증서 ID로 placeholder를 채우고, default-domain-only 역할에는 이 항목이 필요 없으며 최초 provision의 생성 권한은 별도임을 명시한다. 실제 IAM 역할을 생성하거나 수정했다고 주장하지 않는다.

`scripts/landing/contracts.test.mjs:251–261`은 정책 산출물의 ACM statement가 정확한 읽기 Action/단일 ARN인지 검사하고 전체 Action `*`도 거절한다. 이번 fix는 runtime deploy/template을 바꾸지 않아 원래 승인한 외부 DNS 조건, 소유권 guard, 실제 target 안내, mode/lock/archive/hash 동작에 새 경로를 추가하지 않는다.

## 증거 및 남은 관문

- 원 로그에서 정책 회귀 계약 RED 1 FAIL → GREEN 1 PASS를 확인했다. 구현자의 최종 Node 계약 전체 로그는 **23 PASS / 0 FAIL / 0 SKIP**이다. 재검토에서 같은 테스트를 반복하지 않았다.
- 재검토의 `git diff --check 9a13a444..ffbd8b09`는 exit 0이다.
- 구현자 로컬 검증 환경은 Node 24.19.0 / pnpm 9.15.0이다. Node 22와 동일 검토 커밋의 canonical full CI는 아직 검증되지 않았으며 공개 배포 전 관문으로 유지한다.
- 실제 AWS IAM/CloudFormation/ACM, HostingKR DNS, HTTPS와 운영 smoke는 수행하지 않았다. 로컬 mock/정책 검사 결과로 실제 배포 성공을 추론하지 않는다.
- 총괄의 미커밋 plan/status bookkeeping은 수정하지 않았다. 총괄은 검토 완료·통합 상태를 두 기록에 함께 반영하면 된다.
