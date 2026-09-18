export interface CadPoint {
  x: number;
  y: number;
  z: number;
}

export interface CadScale {
  x: number;
  y: number;
  z: number;
}

export interface CadBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface CadPolylineVertex extends CadPoint {
  /** DXF bulge: tan(included arc angle / 4) for the segment to the next vertex. */
  bulge: number;
}

export interface NormalizedCadAttribute {
  sourceEntityId: string;
  tag: string;
  value: string;
  position: CadPoint;
  rotation: number;
  height: number;
}

interface NormalizedCadEntityBase {
  sourceEntityId: string;
  layer: string;
}

export interface NormalizedCadLine extends NormalizedCadEntityBase {
  type: "line";
  start: CadPoint;
  end: CadPoint;
}

export interface NormalizedCadPolyline extends NormalizedCadEntityBase {
  type: "lwpolyline" | "polyline";
  vertices: CadPolylineVertex[];
  closed: boolean;
}

export interface NormalizedCadCircle extends NormalizedCadEntityBase {
  type: "circle";
  center: CadPoint;
  radius: number;
}

export interface NormalizedCadArc extends NormalizedCadEntityBase {
  type: "arc";
  center: CadPoint;
  radius: number;
  startAngle: number;
  endAngle: number;
}

export interface NormalizedCadText extends NormalizedCadEntityBase {
  type: "text" | "mtext";
  position: CadPoint;
  rotation: number;
  height: number;
  text: string;
}

export interface NormalizedCadInsert extends NormalizedCadEntityBase {
  type: "insert";
  blockName: string;
  position: CadPoint;
  rotation: number;
  scale: CadScale;
  attributes: NormalizedCadAttribute[];
}

export type NormalizedCadEntity =
  | NormalizedCadLine
  | NormalizedCadPolyline
  | NormalizedCadCircle
  | NormalizedCadArc
  | NormalizedCadText
  | NormalizedCadInsert;

export interface NormalizedCadBlock {
  name: string;
  basePoint: CadPoint;
  entities: NormalizedCadEntity[];
}

export interface NormalizedCadDocument {
  version: 1;
  bounds: CadBounds;
  blocks: NormalizedCadBlock[];
  entities: NormalizedCadEntity[];
}
