import type {
  CadImportMimeType,
  CadImportSourceFormat,
  CadSceneDescriptor,
  FloorImportApplyResult as SharedFloorImportApplyResult,
  FloorImportCandidate,
  FloorImportJobStatus,
  FloorImportRenderedViewport,
  FloorLightSlotDto
} from "@led-control/shared";

export type EditorTool = "select" | "pan" | "rectangle" | "triangle" | "line" | "text";

export type MapObjectType = "rectangle" | "triangle" | "line" | "text";

export interface FloorEditorState {
  floor: {
    id: string;
    siteId: string;
    name: string;
    level: number;
    mapRevision: number;
    floorPlan: FloorPlanDraft | null;
    cadScene?: CadSceneDescriptor | null;
    mapDocument?: import("@led-control/shared").MapDocumentRef | null;
  };
  fixtures: EditorFixture[];
  lightSlots: FloorLightSlotDto[];
  objects: FloorMapObject[];
}

export interface FloorPlanDraft {
  id?: string;
  imageUrl: string;
  sourceType?: "none" | "image" | "pdf" | "cad";
  originalFileUrl?: string | null;
  renderedImageUrl?: string | null;
  width: number;
  height: number;
  gridSize?: number;
  version: number;
}

export interface FloorAsset {
  id: string;
  kind: "original" | "rendered";
  status: "pending" | "ready";
  mimeType: "image/png" | "image/jpeg" | "application/pdf" | "image/svg+xml" | CadImportMimeType;
  sizeBytes: number;
  sha256: string;
  accessPath: string;
  readyAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface FloorImportJob {
  jobId: string;
  floorId: string;
  sourceAssetId: string;
  renderedAssetId: string | null;
  sourceFormat: CadImportSourceFormat;
  status: FloorImportJobStatus;
  stage: string;
  progressPercent: number;
  attemptCount: number;
  parserVersion: string | null;
  detectorVersion: string | null;
  failureCode: string | null;
  sourceAssetPath: string;
  renderedAssetPath: string | null;
  renderedViewport: FloorImportRenderedViewport | null;
  startedAt: string | null;
  reviewRequiredAt: string | null;
  appliedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type FloorImportApplyResult = SharedFloorImportApplyResult;

export interface CadImportReviewState {
  job: FloorImportJob;
  candidates: FloorImportCandidate[];
  acceptedCandidateIds: string[];
  // Missing context is unresolved, never evidence of legacy coordinates.
  scene?: { kind: "native"; regionId: string } | { kind: "legacy" };
}

export interface CadMapResetSummary {
  fixtureCount: number;
  objectCount: number;
  slotCount: number;
}

export interface EditorFixture {
  id: string;
  name: string;
  x: number;
  y: number;
  size?: number;
  ratedWatt: number;
  brightness: number;
  status: "online" | "offline" | "fault";
  placementStatus?: "unplaced" | "placed";
  positionVerifiedAt?: string | null;
  /** Explicit user confirmation intent; only the server assigns a timestamp. */
  positionVerified?: boolean;
  serialNumber?: string | null;
  meshAddress?: number | string | null;
}

export interface FloorMapObject {
  id: string;
  floorId: string;
  type: MapObjectType;
  x: number;
  y: number;
  width: number;
  height: number;
  points?: Array<{ x: number; y: number }> | null;
  rotation: number;
  strokeColor: string;
  fillColor?: string | null;
  strokeWidth: number;
  text: string;
  fontSize?: number | null;
  zIndex: number;
  locked: boolean;
  visible: boolean;
}

export type FloorMapObjectDraft = Omit<FloorMapObject, "id" | "floorId" | "zIndex"> & { zIndex?: number };

export type CadEditorSelection =
  | {
      mode: "group";
      targetId: string;
      elementId: string;
      groupId: string;
      layerName: string;
    }
  | {
      mode: "element";
      targetId: string;
      element: import("./cad-editor-runtime").CadEditableElement | null;
    };
