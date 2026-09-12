# Gateway release bundle 검증 계약

기준일: 2026-09-13

이 문서는 Task 1의 build/CI 검증 범위다. Pi activation/rollback, backup/restore와 운영 승인 절차를 대신하지 않는다. Node CLI는 build/CI용이며 Pi host에 Node가 있다고 가정하지 않는다.

## Artifact와 provenance

`scripts/gateway-release-bundle.mjs create`는 clean Git checkout, 실제 `docker save` tar/config, Docker inspect와 image 내부 inventory를 입력으로 immutable bundle directory를 생성한다. `verify --bundle DIR --policy TRUSTED_POLICY --expected-commit FULL_SHA`는 config/layer digest, full commit, package version, lock/BlueZ/firmware policy, SPDX inventory와 전체 regular-file checksum closure를 비교한다. 기존 directory는 덮어쓰지 않는다.

기본 platform은 `linux/arm64`다. `--test-mode --platform linux/amd64`는 명시적인 CI artifact이며 기본 verify에서 거부한다. `--allow-test-mode`는 disposable CI 검증 전용이다.

Docker save의 외부 tar 안에서 legacy raw tar layer와 Docker 29의 **단일 gzip member layer**를 지원한다. Content-addressed blob/OCI descriptor digest는 저장된 compressed bytes에, config `rootfs.diff_ids`는 해제된 tar bytes에 각각 검증한다. Gzip header/CRC/length와 정확한 member 끝을 검증하며 손상·truncation·trailing bytes·연결 member·미지원 압축을 거부한다. Archive와 전체 decoded layers는 각각 2 GiB, 각 blob/layer는 compressed·decoded 각각 512 MiB, layer 수는 128로 제한한다. 임시 decoded 파일은 해당 검증이 소유한 directory에만 생성하고 성공/실패 시 제거한다.

OCI archive는 index/manifest descriptor에서 선택한 platform의 config와 ordered layers까지 digest/size/media type을 결속한다. Descriptor graph는 깊이 8 미만·256개 이하이며, 두 번째 runtime image는 거부한다. Buildx의 `unknown/unknown` in-toto attestation만 선택한 manifest에 대한 reference가 일치할 때 허용한다. Index의 tag annotation, archive RepoTag, inspect reference/labels도 일치해야 한다. `image.configDigest`는 항상 실제 config bytes의 SHA-256이다. 별도 `image.descriptorDigest`는 검증된 Docker inspect `.Id`(classic daemon은 config, Docker 29 containerd는 manifest/index)를 기록하며 config와 혼동하지 않는다.

## Image inventory의 최종 가시성

Inventory 경로는 `usr/local/share/gateway-release-inventory.json`이다. 지원하는 layer의 검증된 uncompressed tar를 순서대로 적용하되, 각 layer의 whiteout을 **이전 layer의 상태에 먼저** 적용하고 같은 layer의 새 파일은 그 뒤 반영한다. Tar 안 marker 순서는 결과를 바꾸지 않는다. 이는 [OCI layer whiteout 규칙](https://github.com/opencontainers/image-spec/blob/v1.1.1/layer.md#whiteouts)을 따른다.

- `.wh.<name>`은 해당 경로와 하위 inventory를 제거한다. Root의 `.wh.usr`도 포함한다.
- `.wh..wh..opq`는 해당 directory의 이전 layer 하위 내용을 가린다. Root와 `usr`, `usr/local`, `usr/local/share` 각각을 처리한다.
- 상위 경로가 symlink나 일반 파일로 교체되면 inventory를 무효화한다. Directory를 다시 생성한 것만으로 이전 inventory를 복구하지 않는다.
- 모든 layer 적용 뒤 보이는 최종 **일반 파일** 하나만 JSON/inventory로 읽는다. 지워지거나 가려진 옛 JSON은 최종 inventory가 아니다.

## Private-material 검사의 정확한 범위

Manifest의 `privateMaterialScan`에는 고정 profile `led-control-private-material/v2`와 아래 보장·한계가 들어간다. Verify는 profile을 생략하거나 다른 profile로 바꾼 manifest를 거부한다. v1 artifact를 v2 증거라고 재인증하지 않는다. 이 검사는 “어떤 형태의 secret도 없다”는 증명이 아니다.

| 검사 | 보장 범위 |
| --- | --- |
| 파일 이름/형식 | `.env`/`.env.*`, `id_rsa`/`id_dsa`/`id_ecdsa`/`id_ed25519`, `private-key`/`private_key` 계열 basename·directory, `.key`/`.p12`/`.pfx`/`.pkcs12`/`.pkcs8`를 거부한다. 일반 `*-key`나 `.pem`을 모두 거부하지 않는다. `apt-key` 같은 public tool·`key.js`·public SPKI/CA PEM은 허용하고, `secrets/device-key`처럼 확장자가 없어도 실제 key 내용이면 아래 검사로 거부한다. Bundle symlink/hardlink/special file와 예상 밖 경로는 거부하며 image 내부 정상 OS symlink는 개인키로 보지 않는다. |
| PEM | UTF-8 text 안의 complete `BEGIN … PRIVATE KEY`→동일한 `END` block을 [Node `createPrivateKey`](https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptocreateprivatekeykey)가 실제 private key로 parse할 때 거부한다. Header 문자열이나 파싱 불가능한 설명 예시는 key로 판정하지 않는다. |
| DER | 파일 전체가 PKCS#1/PKCS#8/SEC1 private key이고 Node crypto parse가 성공할 때 거부한다. 앞뒤 ASCII whitespace는 허용해 검사한다. Binary의 임의 offset을 sliding scan하지 않는다. |
| Base64 | **파일 전체**가 표준 base64 한 겹으로 감싼 standalone PEM/DER key일 때 같은 검사를 한다. ASCII whitespace 전체(Space/HT/LF/VT/FF/CR), 짧은 마지막 줄, chunk 경계를 정규화한다. JSON/text 안 일부 base64 token은 이 계약에 포함하지 않는다. |
| 범위/예산 | Bundle의 일반 파일과 **삭제된 layer까지 포함한** 각 image layer의 일반 파일 **내용 단위**로 검사한다. Tar header/padding나 다른 파일의 bytes를 합쳐 key로 해석하지 않는다. DER는 최대 65,536 bytes, complete PEM block과 공백 제거한 base64 candidate는 각각 최대 131,072 characters다. 후보만 bounded buffering하며 전체 image/file을 메모리에 올리지 않는다. |

공개 SPKI/CA certificate, 정상 library binary와 marker-only 문서를 개인키로 판정하지 않는 회귀도 유지한다. 오류에는 검사 종류만 남기며 key bytes, base64 원문, JSON excerpt나 passphrase를 출력하지 않는다. 테스트 개인키는 Node crypto로 매 실행 생성하는 disposable fixture뿐이다.

검사하지 않는 범위: 일반 password/token/raw symmetric key, passphrase 없이는 parse할 수 없는 encrypted key, binary 내부 DER·PEM, text 일부의 base64 token, 위 예산보다 큰 후보, 임의의 obfuscation/다른 encoding/재귀 encoding, layer 내부 파일의 nested compressed payload, Node가 지원하지 않는 key/container 형식(예: OpenSSH private container). 지원 image layer transport(raw tar 또는 단일 gzip)는 해제 후 파일별 검사하지만, 임의의 내부 archive를 재귀 해제하지 않는다. Site env/key filename denylist와 `.dockerignore`는 유지되며, 이 content profile의 한계를 운영 key custody나 artifact 승인으로 대체해 해석하면 안 된다.

## Shell metadata 전달

`appliance.env`는 checksum 보호를 받는 exact allowlist이며 shell 식이나 site 설정을 넣지 않는다. **`GATEWAY_RELEASE_TEST_MODE=0|1`만 허용**한다. `0`은 production, `1`은 test-only다. `true`, `false`, 빈 값, `00`, `01`, 그 밖의 숫자나 manifest와 다른 값은 거부한다. JSON manifest의 `testMode`와 OCI label의 boolean text는 이 shell wire와 구분한다.

새 producer의 14개 키: `GATEWAY_GIT_COMMIT`, `GATEWAY_GIT_COMMIT_TIMESTAMP`, `GATEWAY_IMAGE_ARCHIVE`, `GATEWAY_IMAGE_CONFIG_DIGEST`, `GATEWAY_IMAGE_DESCRIPTOR_DIGEST`, `GATEWAY_IMAGE_REPOSITORY`, `GATEWAY_IMAGE_TAG`, `GATEWAY_LOCK_SHA256`, `GATEWAY_RELEASE_ID`, `GATEWAY_RELEASE_PLATFORM`, `GATEWAY_RELEASE_POLICY_SHA256`, `GATEWAY_RELEASE_SCHEMA`, `GATEWAY_RELEASE_TEST_MODE`, `GATEWAY_VERSION`.

갱신된 verifier/activation/state consumer는 descriptor 키가 없는 기존 exact 13-key bundle도 rollback 용도로 허용하되 기존 config-ID 일치 조건을 유지한다. 새 bundle은 checksum 검증 후 exact tag를 load/inspect하여 daemon ID가 config 또는 archive에 결속된 descriptor이며 revision/version/policy/test-mode label도 같은지 확인한다. 실제 container `.Image`는 이때 캡처한 daemon ID와 비교한다. 이전 consumer는 새 14-key bundle을 거부하므로 **새 producer 사용 전에 verifier와 activation/state helper를 함께 갱신**해야 한다. 임의 mixed-version 운영 호환성을 보장하지 않는다.

Task 2 consumer도 exact key allowlist/중복/누락/개별 값 범위를 검증해야 한다. Checksum과 provenance는 서명이 아니므로 trusted policy, expected commit과 승인된 배포 경로가 필요하다.

## 검증 한계

Task 1 fixtures는 실제 CLI/Git/tar/Bash를 실행하되 Docker 경계만 fixture로 대체한다. 실제 Docker image build/export/runtime inventory smoke는 Task 4 범위이며 Raspberry Pi, BlueZ/HCI/RF, 운영 키·identity·배포·HIL은 별도 승인·증거가 필요하다.
