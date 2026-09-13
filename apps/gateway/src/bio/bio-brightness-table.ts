/**
 * BIO 정수 밝기 변환 계약
 *
 * - [확인됨] 설치 APK(해시와 버전은 bio-protocol-v1 fixture에 기록)의 `deep_all`
 *   표시 배열에서 정확히 `0%..100%`인 항목을 찾고, 같은 index의
 *   `Scene.DEEP_VALUES`를 선택하면 아래 101개 값이 된다.
 * - [확인됨] 따라서 이 표는 `percent * 2.55`나 감마식으로 재계산할 수 없으며,
 *   reverse 변환도 표에 정확히 존재하는 raw byte에만 정의된다.
 * - [미확인] 이 정적 APK 계약의 모든 단계가 실제 조명 firmware에서 동일하게
 *   적용되는지는 Task 9 HIL 전까지 확인되지 않았다. 표 밖 raw 값을 보간하지 않는다.
 */
const BIO_RAW_BY_INTEGER_PERCENT = [
  0, 26, 36, 44, 51, 57, 62, 67, 72, 77, 81,
  85, 88, 92, 95, 99, 102, 105, 108, 111, 114,
  117, 120, 122, 125, 128, 130, 133, 135, 137, 140,
  142, 144, 146, 149, 151, 153, 155, 157, 159, 161,
  163, 165, 167, 169, 171, 173, 175, 177, 179, 180,
  182, 184, 186, 187, 189, 191, 193, 194, 196, 198,
  199, 201, 202, 204, 206, 207, 209, 210, 212, 213,
  215, 216, 218, 219, 221, 222, 224, 225, 227, 228,
  230, 231, 232, 234, 235, 236, 238, 239, 241, 242,
  243, 245, 246, 247, 249, 250, 251, 252, 254, 255
] as const;

const BIO_INTEGER_PERCENT_BY_RAW = new Map<number, number>(
  BIO_RAW_BY_INTEGER_PERCENT.map((raw, percent) => [raw, percent])
);

/** [확인됨] 서비스가 허용하는 정수 `0..100`만 APK의 exact lookup으로 변환한다. */
export function percentToBioRaw(percent: number): number {
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new RangeError("BIO brightness percent must be an integer from 0 to 100");
  }
  return BIO_RAW_BY_INTEGER_PERCENT[percent];
}

/** [확인됨] APK 정수 표시값과 정확히 대응하지 않는 raw byte는 반올림 없이 null이다. */
export function bioRawToPercent(raw: number): number | null {
  if (!Number.isInteger(raw) || raw < 0 || raw > 0xff) return null;
  return BIO_INTEGER_PERCENT_BY_RAW.get(raw) ?? null;
}
