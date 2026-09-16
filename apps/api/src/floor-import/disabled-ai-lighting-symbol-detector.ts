import type { NormalizedCadDocument } from "./cad-types";
import type { DetectedLightingSymbol, LightingDetectionOptions, LightingSymbolDetector } from "./lighting-symbol-detector";

/** The production default intentionally has no provider dependency or I/O path. */
export class DisabledAiLightingSymbolDetector implements LightingSymbolDetector {
  async detect(_document: NormalizedCadDocument, _options?: LightingDetectionOptions): Promise<DetectedLightingSymbol[]> {
    return [];
  }
}
