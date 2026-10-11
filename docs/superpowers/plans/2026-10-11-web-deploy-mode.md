# Public Web Deployment Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement the coupled tasks sequentially.

**Goal:** `WEB_DEPLOY_MODE` 하나로 동일 배포 명령의 랜딩/전체 서비스 빌드와 AWS 공개 범위를 전환한다.

**Architecture:** 최신 UI 기준에 승인된 정적 랜딩 준비를 통합한다. 모드 parser/route/artifact 계약을 빌드와 배포가 공유하고, 서비스 모드만 인증된 기존 앱과 same-origin API origin을 제공한다.

**Tech Stack:** Node22/pnpm9.15/Vite/React/CloudFormation/S3/OAC/CloudFront.

**Spec:** `docs/superpowers/specs/2026-10-11-web-deploy-mode-design.md`

## Global Constraints

- 단일 모드 `WEB_DEPLOY_MODE=landing|service`; 기본 landing, invalid fail before writes.
- landing graph/output 내부 제외, service 최신 UI/인증 보존, 시안/test 자료 제외.
- service 로그인 같은 origin `/login`, API `/api` 계약 유지. 운영 API origin은 최초 한 번 명시 입력.
- 계정/소유권·lock/hash/archive/과거 assets 보존·canonical CI gate 유지. 운영 AWS/DB/장비 조작 없음.

## Review Focus

- 플래그는 service인데 landing 산출물/edge가 남은 경우: 모드·바이트 연계 gate 및 fake deploy assertion.
- landing으로 돌아왔는데 API/로그인/내부 JS 접근이 열린 경우: 왕복 전환 HTTP/edge/API 계약.
- API 401/403을 HTML404로 바꾸거나 쿠키가 캐시되는 경우: API behavior/cache/error 정책 검사.
- 직접 접속·새로고침 또는 정상 nested route를 잘못404로 처리하는 경우: 실제 route 계약+production browser.
- 실패한 전환/rollback이 다른 모드의 archive를 게시하는 경우: manifest mismatch/identity/no-write·복구 검사.

## Tasks — 단일 writer 순차 구현

- [ ] Task1: 최신 `cc6b9a7a`에 기존 AWS/Web 준비 `78fab117`/`1b10cd95` 통합. 최근 UI와 기본 entry를 보존하고 충돌은 소유 범위의 양쪽 의미를 유지한다. 과거 상태판은 덮어쓰지 않는다.
- [ ] Task2: 공통 배포 모드 parser·route/artifact 계약, `build:public` 및 production-only service entry/config 구현. 실패 테스트→최소 구현→양 모드 build/graph/HTTP와 서비스 로그인/일반 auth 회귀. 파일: `apps/web/**`, 필요 `scripts/landing` 공통 계약.
- [ ] Task3: 기존 `infra/landing/**`, `scripts/landing/**` 배포 흐름을 양 모드로 확장. 같은 deploy 명령으로 edge/API 설정과 산출물 조율, service preflight, mode-bound release/rollback, 최소 IAM·runbook·공개 메뉴 문서. fake AWS 왕복/부분 실패/틀린 모드/쿠키·캐시 계약으로 검증.
- [ ] Task4: 한정 최종 타입/UI/양 모드 build·생산 browser, 독립 spec/quality 전체 리뷰 및 필요한 국소 수리. 기본 UI 기존 실패/전체 CI·remote 미실행을 구분한다.
- [ ] Task5: 총괄이 체크리스트·상태판 최신화, 검토된 커밋·미리보기/정확한 사용 명령·최초 환경 입력·실제 공개 상태 보고. 기존 root 서비스/다른 worktree는 보존한다.

## Ownership

긴밀한 공유 계약이므로 한 implementer에게 `apps/web/**`, `infra/landing/**`, `scripts/landing/**`, 필요 root package script, 공개 메뉴3문서와 기존 AWS runbook을 승인한다. 서버/공유 MQTT/DB/인증서/기존 production Compose/CI 변경은 제외한다. 총괄만 이 계획·spec·project-status를 갱신한다.

검토는 baseline부터 task commit까지의 고정 diff package와 담당 보고서를 사용한다. 불필요한 전체 suite 재실행 없이 changed unit/actual build/실제 접속과 제한적인 auth browser로 완료 기준을 확인한다.
