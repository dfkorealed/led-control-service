import type { NormalizedCadDocument } from "./cad-types";
import { DisabledAiLightingSymbolDetector } from "./disabled-ai-lighting-symbol-detector";

describe("disabled AI lighting symbol detector", () => {
  it("returns no decisions without calling an external provider", async () => {
    const fetchSpy = jest.spyOn(globalThis, "fetch");
    const document: NormalizedCadDocument = { version: 1, bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 }, blocks: [], entities: [] };

    await expect(new DisabledAiLightingSymbolDetector().detect(document)).resolves.toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
