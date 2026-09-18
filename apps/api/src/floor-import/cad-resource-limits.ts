const MEBIBYTE = 1024 * 1024;

export const CAD_IMPORT_MAX_SOURCE_BYTES = 50 * MEBIBYTE;
export const CAD_IMPORT_MAX_DXF_BYTES = 256 * MEBIBYTE;
export const CAD_RENDERED_SVG_RAW_MAX_BYTES = 128 * MEBIBYTE;
export const CAD_RENDERED_SVG_MAX_BYTES = 8 * MEBIBYTE;
export const CAD_IMPORT_TEMP_FILESYSTEM_OVERHEAD_BYTES = 64 * MEBIBYTE;
export const CAD_IMPORT_TEMP_VOLUME_BYTES = 512 * MEBIBYTE;

export const CAD_IMPORT_RENDER_TEMP_RESERVE_BYTES =
  CAD_RENDERED_SVG_RAW_MAX_BYTES +
  CAD_RENDERED_SVG_MAX_BYTES +
  CAD_IMPORT_TEMP_FILESYSTEM_OVERHEAD_BYTES;

interface CadTempFileSystemStats {
  bsize: number | bigint;
  blocks: number | bigint;
  bavail: number | bigint;
}

export function assertCadImportTempBudget(stats: CadTempFileSystemStats, retainedBytes: number): void {
  if (!Number.isSafeInteger(retainedBytes) || retainedBytes < 0 ||
      retainedBytes + CAD_IMPORT_RENDER_TEMP_RESERVE_BYTES > CAD_IMPORT_TEMP_VOLUME_BYTES) {
    throw new Error("CAD import temporary disk budget exceeded");
  }
  const blockSize = BigInt(stats.bsize);
  const capacityBytes = blockSize * BigInt(stats.blocks);
  const availableBytes = blockSize * BigInt(stats.bavail);
  if (capacityBytes < BigInt(CAD_IMPORT_TEMP_VOLUME_BYTES) ||
      availableBytes < BigInt(CAD_IMPORT_RENDER_TEMP_RESERVE_BYTES)) {
    throw new Error("CAD import temporary disk budget unavailable");
  }
}
