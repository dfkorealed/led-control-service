import { Buffer } from "node:buffer";
import * as iconv from "iconv-lite";

export const DXF_ENCODING_CHUNK_BYTES = 64 * 1024;
export const DXF_ENCODING_HEADER_BYTES = 64 * 1024;

const LEGACY_CODEPAGES: Readonly<Record<string, string>> = Object.freeze({
  ANSI_874: "windows-874",
  ANSI_932: "shift_jis",
  ANSI_936: "gbk",
  // The decoder below uses iconv-lite CP949, including extended Hangul that
  // Node 22 ICU's euc-kr decoder can silently map to C1 control characters.
  ANSI_949: "euc-kr",
  ANSI_950: "big5",
  ANSI_1250: "windows-1250",
  ANSI_1251: "windows-1251",
  ANSI_1252: "windows-1252",
  ANSI_1253: "windows-1253",
  ANSI_1254: "windows-1254",
  ANSI_1255: "windows-1255",
  ANSI_1256: "windows-1256",
  ANSI_1257: "windows-1257",
  ANSI_1258: "windows-1258"
});

function isInvalidEncodedData(error: unknown): boolean {
  // Node decoder errors can originate outside Jest's VM realm. Class identity
  // is unreliable; only the precise decoding failure may trigger fallback.
  return typeof error === "object" && error !== null && "code" in error &&
    error.code === "ERR_ENCODING_INVALID_ENCODED_DATA";
}

export function createStrictDxfDecoder(encoding: string): Pick<TextDecoder, "decode"> {
  const native = encoding.toLowerCase() === "cp949" ? null : new TextDecoder(encoding, { fatal: true });
  if (native && native.encoding !== "euc-kr") return native;
  let decoder = iconv.getDecoder("cp949", { stripBOM: false });
  let pending = Buffer.alloc(0);
  return {
    decode(input, options) {
      const bytes = input === undefined ? Buffer.alloc(0) : ArrayBuffer.isView(input)
        ? Buffer.from(input.buffer, input.byteOffset, input.byteLength) : Buffer.from(input);
      const original = pending.length ? Buffer.concat([pending, bytes]) : bytes;
      let decoded = decoder.write(bytes);
      if (!options?.stream) decoded += decoder.end() ?? "";
      // iconv-lite is replacement-based, so enforce strictness at our boundary.
      // Round-trip only consumed bytes, retaining at most one pending lead byte
      // across chunks; never accumulate the entire stream for validation.
      const encoded = iconv.encode(decoded, "cp949");
      if (decoded.includes("\ufffd") || encoded.length > original.length ||
          !encoded.equals(original.subarray(0, encoded.length))) {
        throw new Error("Invalid DXF CP949 encoding");
      }
      pending = Buffer.from(original.subarray(encoded.length));
      if (pending.length > 1 || (!options?.stream && pending.length)) throw new Error("Invalid DXF CP949 encoding");
      if (!options?.stream) {
        decoder = iconv.getDecoder("cp949", { stripBOM: false });
      }
      return decoded;
    }
  };
}

function declaredLegacyEncoding(prefix: Buffer, truncated: boolean): string {
  // Inspect only complete pairs in the bounded first HEADER, not arbitrary
  // entity text containing codepage names. Require ENDSEC so a later ACADVER
  // outside the prefix cannot conceal an R2007+ UTF-8-only declaration.
  const source = prefix.toString("latin1").replace(/^\xef\xbb\xbf/, "");
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  if (truncated && !/[\r\n]$/.test(source)) lines.pop();
  let inHeader = false;
  let complete = false;
  let version: string | undefined;
  let codepage: string | undefined;
  for (let index = 0; index + 1 < lines.length; index += 2) {
    const code = lines[index].trim();
    const value = lines[index + 1].trim().toUpperCase();
    if (!inHeader) {
      if (code === "999") continue;
      if (code !== "0" || value !== "SECTION" || lines[index + 2]?.trim() !== "2" ||
          lines[index + 3]?.trim().toUpperCase() !== "HEADER") break;
      inHeader = true;
      index += 2;
      continue;
    }
    if (code === "0") {
      complete = value === "ENDSEC";
      break;
    }
    if (code !== "9" || (value !== "$ACADVER" && value !== "$DWGCODEPAGE")) continue;
    const nextCode = lines[index + 2]?.trim();
    const nextValue = lines[index + 3]?.trim().toUpperCase();
    if (value === "$ACADVER") {
      if (version !== undefined) throw new Error("Ambiguous DXF encoding version");
      // Missing ACADVER keeps legacy compatibility, but a malformed explicit
      // declaration must never downgrade R2007+ bytes to a legacy decoder.
      if (nextCode !== "1" || !nextValue || !/^AC\d{4}$/.test(nextValue)) {
        throw new Error("Malformed DXF encoding version declaration");
      }
      version = nextValue;
    } else {
      if (codepage !== undefined) throw new Error("Ambiguous DXF encoding codepage");
      if (nextCode !== "3" || !nextValue) throw new Error("Malformed DXF encoding codepage declaration");
      codepage = nextValue;
    }
  }
  if (!complete) throw new Error("Invalid DXF UTF-8 encoding or missing complete bounded HEADER");
  if (version !== undefined && Number(version.slice(2)) >= 1021) {
    throw new Error("DXF R2007 and later require valid UTF-8 encoding");
  }
  const encoding = codepage && Object.hasOwn(LEGACY_CODEPAGES, codepage) ? LEGACY_CODEPAGES[codepage] : undefined;
  if (!encoding) throw new Error("DXF text encoding is neither valid UTF-8 nor a supported declared codepage");
  return encoding;
}

class DxfEncodingProbe {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly prefix = Buffer.alloc(DXF_ENCODING_HEADER_BYTES);
  private prefixBytes = 0;
  private bytesRead = 0;
  private validUtf8 = true;

  constructor(private readonly maxInputBytes: number, private readonly checkBudget: () => void) {}

  accept(chunk: Buffer): void {
    this.checkBudget();
    this.bytesRead += chunk.byteLength;
    if (this.bytesRead > this.maxInputBytes) throw new Error("DXF input limit exceeded");
    const retained = Math.min(chunk.byteLength, this.prefix.length - this.prefixBytes);
    chunk.copy(this.prefix, this.prefixBytes, 0, retained);
    this.prefixBytes += retained;
    if (this.validUtf8) {
      try { this.decoder.decode(chunk, { stream: true }); }
      catch (error) {
        if (!isInvalidEncodedData(error)) throw error;
        this.validUtf8 = false;
      }
    }
    // Keep scanning after invalid UTF-8: fallback must not bypass file size or
    // time limits, and a valid UTF-8 prefix never proves the entire file valid.
    this.checkBudget();
  }

  finish(): string {
    this.checkBudget();
    if (this.validUtf8) {
      try { this.decoder.decode(); }
      catch (error) {
        if (!isInvalidEncodedData(error)) throw error;
        this.validUtf8 = false;
      }
    }
    const encoding = this.validUtf8 ? "utf-8" : declaredLegacyEncoding(
      this.prefix.subarray(0, this.prefixBytes), this.bytesRead > this.prefixBytes
    );
    this.checkBudget();
    return encoding;
  }
}

export function decodeDxfBuffer(input: Buffer, maxInputBytes: number, checkBudget: () => void): string {
  const probe = new DxfEncodingProbe(maxInputBytes, checkBudget);
  for (let offset = 0; offset < input.byteLength; offset += DXF_ENCODING_CHUNK_BYTES) {
    probe.accept(input.subarray(offset, offset + DXF_ENCODING_CHUNK_BYTES));
  }
  const decoder = createStrictDxfDecoder(probe.finish());
  const decoded: string[] = [];
  for (let offset = 0; offset < input.byteLength; offset += DXF_ENCODING_CHUNK_BYTES) {
    checkBudget();
    decoded.push(decoder.decode(input.subarray(offset, offset + DXF_ENCODING_CHUNK_BYTES), { stream: true }));
  }
  decoded.push(decoder.decode());
  checkBudget();
  return decoded.join("");
}

export async function detectDxfFileEncoding(
  input: AsyncIterable<Buffer> | Iterable<Buffer>, maxInputBytes: number, checkBudget: () => void
): Promise<string> {
  const probe = new DxfEncodingProbe(maxInputBytes, checkBudget);
  for await (const chunk of input) {
    for (let offset = 0; offset < chunk.byteLength; offset += DXF_ENCODING_CHUNK_BYTES) {
      probe.accept(chunk.subarray(offset, offset + DXF_ENCODING_CHUNK_BYTES));
    }
    checkBudget();
  }
  return probe.finish();
}
