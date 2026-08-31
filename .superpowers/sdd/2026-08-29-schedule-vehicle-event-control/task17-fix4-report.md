# Task 17 Fix Round 4 보고서

기준일: 2026-08-31

## 수정 내용

- Shared build manifest는 POSIX/Windows absolute path, `..`와 `.` component, empty entry/component, NUL, portable canonical duplicate, trailing separator와 mixed-separator escape를 거부한다. Manifest entry가 기존 directory, symlink 또는 regular file이 아닌 target을 가리켜도 mutation 전에 실패한다.
- Manifest 파일 자체를 `lstat`한 뒤 `O_NOFOLLOW` file descriptor로 읽는다. 이전 manifest와 이번 generated file의 합집합을 먼저 검사하므로 뒤쪽 unsafe entry 때문에 앞쪽 정상 산출물이 먼저 삭제되지 않는다.
- `dist`가 없으면 real directory로 만들 수 있지만 symlink 또는 non-directory이면 실패한다. 각 manifest/generated path는 `dist` root부터 target parent까지 모든 기존 component를 `lstat`하고 cleanup, empty-directory prune, parent mkdir과 artifact write 직전에 다시 검사한다.
- Manifest-owned target은 regular file일 때만 `unlink`한다. Target symlink는 외부 target을 건드리지 않고 build 전체를 fail-closed하며 symlink 자체도 유지한다. Parent directory prune은 manifest path에서 유도한 내부 real directory에만 `rmdir`을 사용하므로 unrelated file이 있는 directory는 보존한다.
- Recursive `mkdir`과 symlink-following `copyFile`을 제거했다. Parent를 한 단계씩 만들고, generated source를 `O_NOFOLLOW`로 읽어 destination sibling의 exclusive temporary regular file에 쓴 뒤 `rename`한다. Build와 모든 mutation loop는 순차 실행한다.

## TDD RED

`packages/shared/src/package-exports.test.ts`에 격리 package fixture와 외부 sentinel을 먼저 추가했다. 기존 `2921355` 구현에서 focused 7건 중 4건이 실패했다.

1. `dist/esm` parent symlink는 외부 `index.js`를 실제 삭제했고 앞선 정상 `dist/index.js`도 먼저 삭제했다.
2. `dist` root symlink는 build가 실패하지 않고 외부 target에 generated artifact를 썼다.
3. Target file symlink는 symlink만 제거한 뒤 build가 성공해 선택한 fail-closed 정책을 위반했다.
4. Windows absolute path, duplicate와 mixed-separator manifest 중 일부가 거부되지 않아 악성 manifest 묶음 테스트가 실패했다.

Core GREEN 뒤 source-side 경계를 재검토해 symlinked ESM compiler output 테스트를 추가했고, 기존 metadata `writeFile`이 외부 `package.json`을 쓴 뒤 build 성공해 별도 RED 1건을 확인했다.

## GREEN 검증

- Focused package export/cleanup: 1파일 8/8 통과
- Shared 전체: 8파일 83/83, build와 typecheck 통과
- Normal stale manifest cleanup, empty real directory prune, clean build, unrelated `dist/user-kept.txt` 보존: 통과
- Workspace direct ESM import와 packed isolated root/subpath ESM·CJS consumer `safeParse`: 통과
- `dist/esm` parent, `dist` root, target file과 ESM compiler output symlink의 외부 sentinel/기존 정상 artifact 보존: 통과
- POSIX/Windows absolute, traversal, empty, duplicate, directory, NUL, mixed-separator manifest 거부: 통과
- Web 전체: 32파일 334/334 통과
- Web production build와 bundle audit: 2,370 modules, main `1,028.66 kB / gzip 313.70 kB`, schedule `76.11 kB / gzip 20.12 kB`
- API: typecheck, build, CommonJS shared root valid payload import smoke와 built main syntax check 통과
- Gateway: typecheck, build, root ESM-to-CJS/narrow ESM valid payload import smoke와 output syntax check 통과, bundle `504.9 kB`
- `git diff --check`: 통과

## 남은 경쟁 조건

Node의 표준 `fs` API는 이미 연 directory descriptor를 기준으로 한 `openat`/`unlinkat`/`renameat` mutation을 제공하지 않는다. 따라서 각 mutation 직전 `lstat` chain을 재검증해도 별도 악성 process가 그 직후 parent directory를 symlink로 교체하는 OS scheduling window까지 원자적으로 제거할 수는 없다. Final target은 `unlink` 또는 temporary-file `rename`으로 symlink 자체를 따라가지 않지만 parent component swap은 이 제한에 남는다.

현재 완화는 build 직렬 실행, 전체 mutation plan 선검증, mutation 직전 component 재검증, exclusive temporary file과 no-follow final operation이다. 완전한 적대적 동시 writer 방어가 필요하면 native dirfd-relative helper를 사용하거나 외부 writer가 접근할 수 없는 private build directory에서 전체 `dist` tree를 만든 뒤 상위 경계에서 원자 교체해야 한다.

## 미실행 범위

- Production API/Gateway를 연결한 Chromium software E2E는 이번 build cleanup fix에서 실행하지 않았다.
- 실제 Raspberry Pi/BlueZ/ESP32-H2 RF 및 전원 차단 HIL은 실행하지 않았다.
- main과 PDF chunk의 기존 500 kB Vite warning은 유지되며 Task 17 bundle audit 상한은 통과했다.
