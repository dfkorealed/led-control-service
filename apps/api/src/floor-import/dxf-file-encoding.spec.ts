import { Buffer } from "node:buffer";
import { decodeDxfBuffer, detectDxfFileEncoding, DXF_ENCODING_HEADER_BYTES } from "./dxf-file-encoding";

const header = (codepage = "ANSI_949", version = "AC1015") =>
  `0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\n${version}\n9\n$DWGCODEPAGE\n3\n${codepage}\n0\nENDSEC\n`;
const noBudget = () => {};
const decode = (bytes: Buffer) => decodeDxfBuffer(bytes, bytes.length, noBudget);
const detect = (chunks: Buffer[], limit = 2 * 1024 * 1024) => detectDxfFileEncoding(chunks, limit, noBudget);

describe("bounded DXF byte encoding", () => {
  it("validates UTF-8 through the entire input, not just the retained HEADER prefix", async () => {
    const bytes = Buffer.concat([Buffer.from(header()), Buffer.alloc(100_000, 0x20), Buffer.from([0xb0, 0xa1])]);
    await expect(detect([bytes])).resolves.toBe("euc-kr");
    expect(decode(bytes).endsWith("\uac00")).toBe(true);
  });

  it("retains decoder state when actual UTF-8 is split into single-byte chunks", async () => {
    const bytes = Buffer.from(header() + "\uac00\ub098");
    await expect(detect([...bytes].map(byte => Buffer.from([byte])))).resolves.toBe("utf-8");
  });

  it("flushes trailing incomplete UTF-8 before selecting fallback", async () => {
    await expect(detect([Buffer.from(header("ANSI_1252")), Buffer.from([0xc3])])).resolves.toBe("windows-1252");
  });

  it("keeps scanning and rejects the byte cap after UTF-8 has already failed", async () => {
    const chunks = [Buffer.from(header()), Buffer.from([0xff]), Buffer.alloc(300_000, 0x20)];
    await expect(detect(chunks, 200_000)).rejects.toThrow(/input limit/i);
  });

  it("does not recognize codepage words outside a real HEADER", async () => {
    await expect(detect([Buffer.from("0\nSECTION\n2\nENTITIES\n9\n$DWGCODEPAGE\n3\nANSI_949\n"),
      Buffer.from([0xb0, 0xa1])])).rejects.toThrow(/encoding/i);
  });

  it("fails closed when the complete HEADER exceeds the retained prefix", async () => {
    const bytes = Buffer.concat([Buffer.from(header().replace("0\nENDSEC\n", "999\n")),
      Buffer.alloc(DXF_ENCODING_HEADER_BYTES, 0x20), Buffer.from("\n0\nENDSEC\n"), Buffer.from([0xb0, 0xa1])]);
    await expect(detect([bytes])).rejects.toThrow(/bounded HEADER/i);
  });

  it("does not mistake a truncated ENDSEC value at the prefix boundary for a complete pair", async () => {
    const start = header().replace("0\nENDSEC\n", "999\n");
    const padding = "x".repeat(DXF_ENCODING_HEADER_BYTES - Buffer.byteLength(start) - Buffer.byteLength("\n0\nENDSEC"));
    const bytes = Buffer.concat([Buffer.from(start + padding + "\n0\nENDSEC_INVALID\n"), Buffer.from([0xb0, 0xa1])]);
    await expect(detect([bytes])).rejects.toThrow(/bounded HEADER/i);
  });

  it("rejects duplicate codepage declarations instead of choosing an arbitrary decoder", async () => {
    const source = header().replace("0\nENDSEC\n", "9\n$DWGCODEPAGE\n3\nANSI_1252\n0\nENDSEC\n");
    await expect(detect([Buffer.from(source), Buffer.from([0xb0, 0xa1])])).rejects.toThrow(/ambiguous/i);
  });

  it("preserves valid CP949 extensions instead of returning C1 control characters", () => {
    const bytes = Buffer.concat([Buffer.from(header()), Buffer.from([0xb0, 0xa1, 0x81, 0x41])]);
    expect(decode(bytes)).toBe(header() + "\uac00\uac02");
  });

  describe("fallback declaration validation", () => {
    const korean = Buffer.from([0xb0, 0xa1, 0x81, 0x41]);

    it.each(["AC1032junk", "AC1015junk", "AC102", "AC10320", ""])(
      "rejects malformed version %j before legacy fallback", async version => {
        const bytes = Buffer.concat([Buffer.from(header("ANSI_949", version)), korean]);
        expect(() => decode(bytes)).toThrow(/malformed.*version/i);
        await expect(detect([bytes])).rejects.toThrow(/malformed.*version/i);
      }
    );

    it.each([
      ["version", "$ACADVER\n1\nAC1015", "$ACADVER\n3\nAC1015"],
      ["codepage", "$DWGCODEPAGE\n3\nANSI_949", "$DWGCODEPAGE\n1\nANSI_949"],
      ["codepage", "$DWGCODEPAGE\n3\nANSI_949", "$DWGCODEPAGE\n3\n"]
    ])("rejects wrong type or empty %s declarations", async (kind, before, after) => {
      const bytes = Buffer.concat([Buffer.from(header().replace(before, after)), korean]);
      expect(() => decode(bytes)).toThrow(new RegExp(`malformed.*${kind}`, "i"));
      await expect(detect([bytes])).rejects.toThrow(new RegExp(`malformed.*${kind}`, "i"));
    });

    it.each([
      ["$ACADVER", "3\nAC1015"], ["$ACADVER", "1\n"],
      ["$DWGCODEPAGE", "1\nANSI_949"], ["$DWGCODEPAGE", "3\n"]
    ])("does not silently ignore a malformed repeated %s declaration (%s)", async (variable, value) => {
      const source = header().replace("0\nENDSEC\n", `9\n${variable}\n${value}\n0\nENDSEC\n`);
      const bytes = Buffer.concat([Buffer.from(source), korean]);
      expect(() => decode(bytes)).toThrow(/ambiguous|malformed/i);
      await expect(detect([bytes])).rejects.toThrow(/ambiguous|malformed/i);
    });

    it.each([
      header("ANSI_949", "AC1032junk"),
      header().replace("$ACADVER\n1\nAC1015", "$ACADVER\n3\n"),
      header().replace("$DWGCODEPAGE\n3\nANSI_949", "$DWGCODEPAGE\n1\n")
    ])("prioritizes actual valid UTF-8 over malformed encoding metadata %#", async source => {
      const text = source + "\uac00\uac02";
      const bytes = Buffer.from(text);
      expect(decode(bytes)).toBe(text);
      await expect(detect([bytes])).resolves.toBe("utf-8");
    });

    it("keeps declared legacy fallback when the version variable is absent", async () => {
      const source = header().replace("9\n$ACADVER\n1\nAC1015\n", "");
      const bytes = Buffer.concat([Buffer.from(source), korean]);
      expect(decode(bytes)).toBe(source + "\uac00\uac02");
      await expect(detect([bytes])).resolves.toBe("euc-kr");
    });
  });

  it("checks budgets inside a large producer chunk rather than only at chunk boundaries", async () => {
    let checks = 0;
    const checkBudget = () => { if (++checks > 4) throw new Error("DXF parsing CPU time limit exceeded"); };
    await expect(detectDxfFileEncoding([Buffer.alloc(300_000, 0x20)], 400_000, checkBudget)).rejects.toThrow(/CPU.*limit/i);
  });
});
