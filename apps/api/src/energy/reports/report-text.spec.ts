import { assertReportTextSupported } from "./report-text";

describe("report text round-trip validation", () => {
  it("rejects NFD Hangul whose complete shaped run composes into different extracted scalars", () => {
    expect(() => assertReportTextSupported("한글".normalize("NFD"))).toThrow(/Unsupported report/);
  });
  it.each(["한글", "café e\u0301 a\u0301", "한글 💡 e\u0301 😀", "한글\r\n조명 💡"])("preserves supported NFC, combining and fallback runs (%s)", text => {
    expect(() => assertReportTextSupported(text)).not.toThrow();
  });
});
