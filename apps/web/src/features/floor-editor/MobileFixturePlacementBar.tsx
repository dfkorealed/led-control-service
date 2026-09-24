import { useEffect, useRef, useState } from "react";
import { Button, NumberField, Text } from "../../components/ui";
import type { Bounds, Point } from "./geometry";

interface MobileFixturePlacementBarProps {
  fixtureName: string;
  point: Point | null;
  bounds: Bounds;
  onPointChange: (point: Point | null) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

export function MobileFixturePlacementBar({ fixtureName, point, bounds, onPointChange, onCancel, onConfirm }: MobileFixturePlacementBarProps) {
  const region = useRef<HTMLElement>(null);
  const [showCoordinates, setShowCoordinates] = useState(false);
  const [x, setX] = useState<number | null>(point?.x ?? null);
  const [y, setY] = useState<number | null>(point?.y ?? null);

  useEffect(() => {
    if (point) { setX(point.x); setY(point.y); }
  }, [point?.x, point?.y]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => region.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, []);

  function updateCoordinate(nextX: number | null, nextY: number | null) {
    setX(nextX);
    setY(nextY);
    onPointChange(nextX !== null && nextY !== null && Number.isFinite(nextX) && Number.isFinite(nextY)
      && nextX >= 0 && nextX <= bounds.width && nextY >= 0 && nextY <= bounds.height
      ? { x: nextX, y: nextY } : null);
  }

  return <section ref={region} tabIndex={-1} className="grid min-w-0 shrink-0 gap-2 border-t border-border-default bg-surface-panel p-2" aria-label="조명 배치">
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-1">
      <Text as="strong" variant="body-sm" weight="semibold" className="min-w-0 truncate">{fixtureName}</Text>
      <Text as="span" variant="caption" tone="secondary" role="status">{point ? `임시 위치 X ${Math.round(point.x)}, Y ${Math.round(point.y)}` : "맵에서 위치를 탭하세요"}</Text>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Button size="sm" variant="ghost" onClick={() => setShowCoordinates((value) => !value)} aria-expanded={showCoordinates}>좌표 입력</Button>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={onCancel}>배치 취소</Button>
        <Button size="sm" variant="primary" disabled={!point} onClick={onConfirm}>이 위치에 배치</Button>
      </div>
    </div>
    {showCoordinates ? <div className="grid min-w-0 grid-cols-2 gap-2">
      <NumberField label="배치 X 좌표" minValue={0} maxValue={bounds.width} value={x} onChange={(value) => updateCoordinate(value, y)} />
      <NumberField label="배치 Y 좌표" minValue={0} maxValue={bounds.height} value={y} onChange={(value) => updateCoordinate(x, value)} />
    </div> : null}
  </section>;
}
