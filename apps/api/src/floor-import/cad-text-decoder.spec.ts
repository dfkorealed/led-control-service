import { decodeCadMText } from "./cad-text-decoder";

describe("CAD MTEXT plain-text decoding", () => {
  it.each([
    ["{\\fGulim|b0|i0|c129|p50;\uB514\uC5D0\uD504\uCF54\uB9AC\uC544}", "\uB514\uC5D0\uD504\uCF54\uB9AC\uC544"],
    ["{\\C1;A{\\H2x;B}\\L C\\l}", "AB C"],
    ["\\{literal\\} \\\\P", "{literal} \\P"],
    ["A\\PB\\~C\\XD", "A\nB\u00a0C\nD"],
    ["\\U+B514\\U+C5D0\\U+D504", "\uB514\uC5D0\uD504"],
    ["\\U+D83D\\U+DE00", "\uD83D\uDE00"],
    ["\\S1#2; \\S+0.8^+0.1; \\S3/4;", "1/2 +0.8/+0.1 3/4"],
    ["\\FArial;\\W0.8x;\\Q15;\\T2;\\A1;\\c12345;\\pi0;\\Oa\\o\\Kb\\k", "ab"],
    ["plain <&>", "plain <&>"],
    ["\\Zunknown;", "\\Zunknown;"],
    ["\\fMissing terminator", "\\fMissing terminator"],
    ["\\fMissing\\Pvisible", "\\fMissing\nvisible"],
    ["\\S1#2", "\\S1#2"],
    ["\\U+XYZ1", "\\U+XYZ1"],
    ["trailing\\", "trailing\\"]
  ])("preserves visible content and escaped literals (%#)", (raw, visible) => {
    expect(decodeCadMText(raw)).toBe(visible);
  });

  it("handles repeated malformed commands without losing content", () => {
    const value = "\\f".repeat(16_000);
    expect(decodeCadMText(value)).toBe(value);
  });
});
