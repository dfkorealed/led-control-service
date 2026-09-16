import type { CadImportDetectorProfileId } from "@led-control/shared";
import type { LightingSymbolDetector } from "./lighting-symbol-detector";
import {
  GENERIC_LIGHTING_PROFILE,
  RuleBasedLightingSymbolDetector,
  SITE_DRAWING_20260803_PROFILE
} from "./rule-based-lighting-symbol-detector";

export interface LightingDetectorRegistry {
  get(profileId: CadImportDetectorProfileId): LightingSymbolDetector;
}

export class FixedLightingDetectorRegistry implements LightingDetectorRegistry {
  private readonly detectors = new Map<CadImportDetectorProfileId, LightingSymbolDetector>([
    ["generic-lighting-v1", new RuleBasedLightingSymbolDetector(GENERIC_LIGHTING_PROFILE)],
    ["site-drawing-20260803-v1", new RuleBasedLightingSymbolDetector(SITE_DRAWING_20260803_PROFILE)]
  ]);

  get(profileId: CadImportDetectorProfileId): LightingSymbolDetector {
    const detector = this.detectors.get(profileId);
    if (!detector) throw new Error(`Unknown CAD detector profile: ${profileId}`);
    return detector;
  }
}
