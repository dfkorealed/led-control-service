import type { CadBounds, CadPoint } from "./cad-types";

const MAX_MAP_WIDTH = 2_400;
const MAX_MAP_HEIGHT = 1_600;
const MIN_MAP_EDGE = 800;
const MAP_PADDING = 40;

interface CadViewportProjection {
  width: number;
  height: number;
  scale: number;
  offsetX: number;
  offsetY: number;
}

function createProjection(bounds: CadBounds): CadViewportProjection {
  const sourceWidth = Math.max(0, bounds.maxX - bounds.minX);
  const sourceHeight = Math.max(0, bounds.maxY - bounds.minY);
  const layoutWidth = Math.max(1, sourceWidth);
  const layoutHeight = Math.max(1, sourceHeight);
  const scale = Math.min(
    (MAX_MAP_WIDTH - MAP_PADDING * 2) / layoutWidth,
    (MAX_MAP_HEIGHT - MAP_PADDING * 2) / layoutHeight
  );
  const contentWidth = sourceWidth * scale;
  const contentHeight = sourceHeight * scale;
  const width = Math.ceil(Math.max(MIN_MAP_EDGE, Math.min(MAX_MAP_WIDTH, contentWidth + MAP_PADDING * 2)));
  const height = Math.ceil(Math.max(MIN_MAP_EDGE, Math.min(MAX_MAP_HEIGHT, contentHeight + MAP_PADDING * 2)));
  return {
    width,
    height,
    scale,
    offsetX: (width - contentWidth) / 2,
    offsetY: (height - contentHeight) / 2
  };
}

export function createCadViewport(bounds: CadBounds): { width: number; height: number } {
  const { width, height } = createProjection(bounds);
  return { width, height };
}

export function projectCadPointToViewport(point: CadPoint, bounds: CadBounds): { x: number; y: number } {
  const projection = createProjection(bounds);
  return {
    x: (point.x - bounds.minX) * projection.scale + projection.offsetX,
    y: (bounds.maxY - point.y) * projection.scale + projection.offsetY
  };
}

export function cadViewportSvgTransform(bounds: CadBounds): string {
  const projection = createProjection(bounds);
  return `matrix(${format(projection.scale)} 0 0 -${format(projection.scale)} ${format(projection.offsetX - bounds.minX * projection.scale)} ${format(projection.offsetY + bounds.maxY * projection.scale)})`;
}

function format(value: number): string {
  return Number(value.toFixed(6)).toString();
}
