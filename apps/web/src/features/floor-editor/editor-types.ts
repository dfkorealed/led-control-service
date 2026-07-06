export type EditorTool = "select" | "pan" | "rectangle" | "triangle" | "line" | "text";

export type MapObjectType = "rectangle" | "triangle" | "line" | "text";

export interface FloorEditorState {
  floor: {
    id: string;
    name: string;
    level: number;
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
  ratedWatt: number;
  brightness: number;
  status: "online" | "offline" | "fault";
}

export interface FloorMapObject {
  id: string;
  floorId: string;
  type: MapObjectType;
  x: number;
  y: number;
  width: number;
  height: number;
  points?: Array<{ x: number; y: number }>;
  rotation: number;
  strokeColor: string;
  fillColor?: string;
  strokeWidth: number;
  text: string;
  fontSize?: number;
  zIndex: number;
  locked: boolean;
  visible: boolean;
}

export type FloorMapObjectDraft = Omit<FloorMapObject, "id" | "floorId" | "zIndex"> & { zIndex?: number };
