import Konva from "konva";
import { useEffect, useRef } from "react";
import { Group, Line, Rect, Text, Transformer } from "react-konva";
import type { CadElementOverridePatch, CadElementTransform } from "@led-control/shared";
import { themeColor } from "../../components/ui/utils/theme-color";
import type { CadEditableElement } from "./cad-editor-runtime";

interface CadElementOverlayProps {
  element: CadEditableElement;
  readOnly: boolean;
  zoom: number;
  onCommit: (patch: Omit<CadElementOverridePatch, "elementId">) => void;
}

const identityTransform: CadElementTransform = {
  translateX: 0,
  translateY: 0,
  scaleX: 1,
  scaleY: 1,
  rotation: 0
};

export function CadElementOverlay({ element, readOnly, zoom, onCommit }: CadElementOverlayProps) {
  const nodeRef = useRef<Konva.Group>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  const transform = element.override?.transform ?? identityTransform;

  useEffect(() => {
    const node = nodeRef.current;
    transformerRef.current?.nodes(!readOnly && node ? [node] : []);
    transformerRef.current?.getLayer()?.batchDraw();
  }, [readOnly, element.elementId]);

  if (element.override?.hidden) return null;

  const commitTransform = () => {
    const node = nodeRef.current;
    if (!node || readOnly) return;
    onCommit({
      transform: {
        translateX: node.x(),
        translateY: node.y(),
        scaleX: node.scaleX(),
        scaleY: node.scaleY(),
        rotation: node.rotation()
      }
    });
  };
  const strokeColor = element.override?.strokeColor ?? element.strokeColor ?? themeColor("fixture-editor-selected");
  const fillColor = element.override?.fillColor ?? element.fillColor ?? undefined;
  const strokeWidth = (element.override?.strokeWidth ?? element.strokeWidth) / Math.max(zoom, 0.1);
  const width = Math.max(1, element.bounds.maxX - element.bounds.minX);
  const height = Math.max(1, element.bounds.maxY - element.bounds.minY);

  return (
    <>
      <Group
        ref={nodeRef}
        name="cad-element-overlay"
        x={transform.translateX}
        y={transform.translateY}
        scaleX={transform.scaleX}
        scaleY={transform.scaleY}
        rotation={transform.rotation}
        draggable={!readOnly}
        onDragEnd={commitTransform}
        onTransformEnd={commitTransform}
      >
        {element.text !== null && element.textGeometry ? (
          <Text
            name="cad-element-text"
            x={element.textGeometry.position.x}
            y={element.textGeometry.position.y}
            offsetY={element.textGeometry.height}
            rotation={element.textGeometry.rotation}
            text={element.override?.text ?? element.text}
            width={element.textGeometry.width}
            height={element.textGeometry.height}
            fontSize={element.fontSize ?? Math.max(10, height)}
            fill={strokeColor}
          />
        ) : element.fragments.length > 0 ? (
          element.fragments.map((fragment, index) => (
            <Line
              key={`${element.elementId}:${index}`}
              name="cad-element-fragment"
              points={fragment.points.flatMap((point) => [point.x, point.y])}
              closed={fragment.closed}
              stroke={strokeColor}
              fill={fillColor}
              strokeWidth={strokeWidth}
              lineJoin="round"
              lineCap="round"
            />
          ))
        ) : (
          <Rect x={element.bounds.minX} y={element.bounds.minY} width={width} height={height} stroke={strokeColor} strokeWidth={strokeWidth} />
        )}
      </Group>
      {!readOnly ? (
        <Transformer
          ref={transformerRef}
          name="cad-element-transformer"
          rotateEnabled
          flipEnabled={false}
          enabledAnchors={["top-left", "top-center", "top-right", "middle-left", "middle-right", "bottom-left", "bottom-center", "bottom-right"]}
          boundBoxFunc={(previous, next) => next.width < 2 || next.height < 2 ? previous : next}
        />
      ) : null}
    </>
  );
}
