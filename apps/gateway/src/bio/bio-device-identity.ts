const BIO_DEVICE_UUID_PATTERN = /^bio:([0-9a-f]{12})$/;
const BIO_NATIVE_UUID_PATTERN = /^[0-9a-f]{12}$/i;

/**
 * [확인됨] 12 수신 header의 bytes 1..6은 6-byte native UUID로 캡처되었다.
 * cloud 경계에서는 다른 adapter/device와 충돌하지 않도록 lowercase `bio:<12 hex>`만 허용한다.
 * [미확인] 이 값의 제조사 발급 체계나 암호학적 고유성은 보장하지 않는다.
 */
export function formatBioDeviceUuid(nativeUuid: string) {
  if (!BIO_NATIVE_UUID_PATTERN.test(nativeUuid)) throw new Error("Invalid BIO native UUID");
  return `bio:${nativeUuid.toLowerCase()}`;
}

/** [확인됨] canonical cloud form만 역변환하며 대문자/다른 prefix는 identity 경계를 넘지 못한다. */
export function parseBioDeviceUuid(deviceUuid: string) {
  const match = BIO_DEVICE_UUID_PATTERN.exec(deviceUuid);
  if (!match) throw new Error("Invalid BIO device UUID");
  return match[1];
}
