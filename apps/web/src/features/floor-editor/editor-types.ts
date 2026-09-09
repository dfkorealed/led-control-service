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
  };
  fixtures: EditorFixture[];
  objects: FloorMapObject[];
}

export interface FloorPlanDraft {
  id?: string;
  imageUrl: string;
  sourceType?: "none" | "image" | "pdf";
  originalFileUrl?: string | null;
  renderedImageUrl?: string | null;
  width: number;
  height: number;
  version: number;
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
