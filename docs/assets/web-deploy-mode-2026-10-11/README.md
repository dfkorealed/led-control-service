# 공개 Web 배포 모드 검증 기록

제품 source `577e7cfa` (`cc6b9a7a` 기준). `WEB_DEPLOY_MODE=landing|service`는 같은 명령의 재빌드·재배포 시 공개 범위를 선택한다.

- [구현 및 수리 보고서](task1-report.md): 모드·아카이브·API·실패 복구 계약과 정확한 검증 명령/로그.
- [독립 전체 검토](review-report.md): 최초 중요2건과 근거.
- [수정분 재검토](re-review-report.md): 두 중요 문제 해결, spec/quality/source integration 승인.
- [운영 절차](../../runbooks/kinda-static-landing-aws.md): 최초 설정, 전환, 복구, 실제 배포 전 관문.

검증: 관련 Web unit45, 초기 Node17 및 수정 계약12, UI정책79·위반0/0, 타입검사, 양 모드 실제 빌드, production landing2PASS/서비스전용2SKIP·service4PASS, 일반 로그인2PASS. 수정 후 service audit77unique 및 공개 바이트 불변. 총괄은 실제 산출물78파일 SHA256과 알려진 경로 HTTP200/알 수 없는 경로404를 다시 확인했다.

한계: 알려진 번들 크기/pnpm 경고가 남는다. 전체 canonical CI·실제 AWS/CloudFormation/IAM/DNS/API TLS·실장비 검증/배포 결과가 아니다. 정상 서비스는 최초 API origin·인증 설정이 필요하다. 보고서의 임시 worktree 경로와 미리보기 PID는 당시 실행 이력이며 운영 주소가 아니다.
