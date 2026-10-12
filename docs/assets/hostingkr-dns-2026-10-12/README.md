# 호스팅케이알 외부 DNS 지원 증거

기준: 2026-10-12. 제품 기준 f31e56fa, 구현 9a13a444, 최소 ACM 읽기 권한 수정 ffbd8b09.

- [구현 및 수정 보고서](task4-impl-report.md): RED 6건과 IAM 정책 RED 1건, 최종 Node 배포 계약 23/23PASS.
- [최초 검토](task4-review-report.md): C0/I1/M0, ACM 권한 예시 누락.
- [재검토](task4-re-review-report.md): I1 ADDRESSED, 신규 C0/I0/M0, specYES/qualityAPPROVED/전체 후속 소스 통합YES.
- [진행 기록](progress.md) 및 `logs/`: 작업 당시 원 증거. 총괄은 같은 제품 커밋에서 23/23와 diffcheck0을 독립 재확인했고, 기본 checkout f31e56fa→2b3d9aae FF 후에도 23/23와 diffcheck0을 확인했다.

로컬 Node24.19.0 검증이다. Node22, 동일 커밋 canonical 전체 CI, 실제 AWS/CloudFormation/IAM/ACM/DNS/TLS/배포 smoke는 미검증이며 사용자 수동 배포 관문이다. 기존 UI/API/DB/서비스/장비는 변경하지 않았다.

설정과 수동 실행 절차의 정본은 [AWS 실행서](../../runbooks/kinda-static-landing-aws.md)다. 실제 계정이나 인증서 ARN/자격 증명은 이 증거에 포함하지 않는다.
