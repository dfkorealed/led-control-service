import { memo, useCallback } from "react";
import Konva from "konva";
import { Circle, Group, Text } from "react-konva";
import type { EditorFixture } from "./editor-types";

export interface EditorFixturePalette {
  status: Record<EditorFixture["status"], string>;
  selected: string;
  border: string;
  label: string;
}

export const EditorFixtureNode = memo(function EditorFixtureNode({ fixture, selected, interactive, showName, colors, register, onSelect, onDragStart, onDragMove, onDragEnd, onTransform }: {
  fixture: EditorFixture; selected: boolean; interactive: boolean; showName: boolean;
  colors: EditorFixturePalette;
  register: (id: string, node: Konva.Node | null) => void;
  onSelect: (id: string, additive: boolean) => void;
  onDragStart: (id: string) => void;
  onDragMove: (id: string, node: Konva.Node) => void;
  onDragEnd: (id: string, node: Konva.Node) => void;
  onTransform: (id: string, node: Konva.Node) => void;
}) {
  const ref = useCallback((node: Konva.Group | null) => register(fixture.id, node), [fixture.id, register]);
  return <Group name={`fixture-${fixture.id}`} ref={ref} x={fixture.x} y={fixture.y} draggable={interactive}
    onClick={(e) => { e.cancelBubble = true; onSelect(fixture.id, e.evt.shiftKey); }} onTap={() => onSelect(fixture.id, false)}
    onDragStart={() => onDragStart(fixture.id)} onDragMove={(e) => onDragMove(fixture.id, e.target)}
    onDragEnd={(e) => onDragEnd(fixture.id, e.target)} onTransformEnd={(e) => onTransform(fixture.id, e.target)}>
    <Circle radius={(fixture.size ?? 20) / 2} fill={colors.status[fixture.status]} stroke={selected ? colors.selected : colors.border} strokeWidth={selected ? 3 : 2} perfectDrawEnabled={false} shadowEnabled={false} />
    {showName && <Text name="fixture-name" x={(fixture.size ?? 20) / 2 + 5} y={-7} text={fixture.name} width={150} ellipsis wrap="none" fontSize={12} fontStyle="bold" fill={colors.label} listening={false} />}
  </Group>;
});
