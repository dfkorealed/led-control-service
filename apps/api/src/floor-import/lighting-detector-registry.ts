import type { LightingSymbolDetector } from "./lighting-symbol-detector";
import {
  GENERIC_LIGHTING_PROFILE,
  RuleBasedLightingSymbolDetector,
  SITE_DRAWING_20260803_PROFILE
} from "./rule-based-lighting-symbol-detector";

export type CadImportDetectorProfileId = "generic-lighting-v1" | "site-drawing-20260803-v1";
export const PROVIDED_SAMPLE_DWG_SHA256 = "01f25d539c20f93663c9183bbf70d83e578ae9990c2eb6dabb543bf39d71854d";

interface DetectorBindingInput {
  sourceSha256: string;
  siteId: string;
}

export interface LightingDetectorRegistry {
  get(profileId: CadImportDetectorProfileId): LightingSymbolDetector;
  resolve(input: DetectorBindingInput): CadImportDetectorProfileId;
  assertBinding(input: DetectorBindingInput & { profileId: string }): void;
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

  resolve(input: DetectorBindingInput): CadImportDetectorProfileId {
    if (!/^[a-f0-9]{64}$/.test(input.sourceSha256) || !input.siteId) throw new Error("Invalid CAD detector binding input");
    return input.sourceSha256 === PROVIDED_SAMPLE_DWG_SHA256
      ? "site-drawing-20260803-v1"
      : "generic-lighting-v1";
  }

  assertBinding(input: DetectorBindingInput & { profileId: string }): void {
    if (this.resolve(input) !== input.profileId) throw new Error("CAD detector profile does not match the approved source binding");
  }
}
