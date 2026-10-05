import { Focus, Maximize, ZoomIn, ZoomOut } from "lucide-react";
import type { ReactElement } from "react";
import { Button } from "../Button";
import { IconTooltipButton } from "../IconTooltipButton";
import { cn } from "../utils/cn";

export interface MapCameraControlsProps {
  zoomPercent: number;
  onZoomIn(): void;
  onZoomOut(): void;
  onResetZoom(): void;
  onFit(): void;
  onFitSelection?(): void;
  isDisabled?: boolean;
  canZoomIn?: boolean;
  canZoomOut?: boolean;
  fitLabel?: string;
  className?: string;
}

/** Callers own camera limits and reset/fit policies; this group only presents actions. */
export function MapCameraControls({ zoomPercent, onZoomIn, onZoomOut, onResetZoom, onFit, onFitSelection,
  isDisabled = false, canZoomIn = true, canZoomOut = true, fitLabel = "지도 화면 맞춤", className }: MapCameraControlsProps): ReactElement {
  return <div className={cn("flex min-w-0 flex-wrap items-center gap-1", className)} role="group" aria-label="지도 확대 축소">
    <IconTooltipButton size="sm" icon={ZoomOut} label="축소" disabled={isDisabled || !canZoomOut} onClick={onZoomOut} />
    <Button type="button" variant="secondary" className="h-11 min-w-16 shrink-0 px-1" aria-label="100%" title="100%" disabled={isDisabled} onClick={onResetZoom}>{zoomPercent}%</Button>
    <IconTooltipButton size="sm" icon={ZoomIn} label="확대" disabled={isDisabled || !canZoomIn} onClick={onZoomIn} />
    <IconTooltipButton size="sm" icon={Maximize} label={fitLabel} disabled={isDisabled} onClick={onFit} />
    {onFitSelection ? <IconTooltipButton size="sm" icon={Focus} label="선택 맞춤" disabled={isDisabled} onClick={onFitSelection} /> : null}
  </div>;
}
