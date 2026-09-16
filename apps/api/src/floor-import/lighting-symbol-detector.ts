import type { CadPoint, NormalizedCadDocument } from "./cad-types";

export interface DetectedLightingSymbol {
  sourceEntityId: string;
  layerName: string;
  blockName: string;
  position: CadPoint;
  rotation: number;
  confidence: number;
  method: "rule" | "ai";
  evidence: string[];
  provider?: string;
  model?: string;
  inputDigest?: string;
  profileVersion?: string;
  profileDigest?: string;
}

export interface LightingDetectionOptions {
  abortSignal?: AbortSignal;
  maxDurationMs?: number;
  now?: () => number;
}

export interface LightingSymbolDetector {
  detect(document: NormalizedCadDocument, options?: LightingDetectionOptions): Promise<DetectedLightingSymbol[]>;
}
