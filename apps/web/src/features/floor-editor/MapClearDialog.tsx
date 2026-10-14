import { useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button, ModalDialog, RadioGroup, Text } from "../../components/ui";
import type { FloorEditorClearMode } from "../../api/floor-editor-reset";

export function MapClearDialog({ floorName, isPending, disabled, error, onCancel, onConfirm }: {
  floorName: string; isPending: boolean; disabled: boolean; error: string | null;
  onCancel: () => void; onConfirm: (mode: FloorEditorClearMode) => void;
}) {
  const [mode, setMode] = useState<FloorEditorClearMode>("elements_only");
  const cancel = useRef<HTMLButtonElement>(null);
  return <ModalDialog isOpen title="맵 초기화" isPending={isPending} initialFocusRef={cancel}
    onClose={() => { if (!isPending) onCancel(); }} actions={<>
      <Button ref={cancel} variant="secondary" disabled={isPending} onClick={onCancel}>취소</Button>
      <Button variant="danger" disabled={disabled || isPending} isLoading={isPending} loadingLabel="초기화 중"
        onClick={() => onConfirm(mode)}><RotateCcw size={16} aria-hidden="true" />초기화 실행</Button>
    </>}>
    <div className="grid gap-3">
      <Text>{floorName}의 현재 층 맵만 초기화합니다. 저장하지 않은 변경사항은 폐기됩니다.</Text>
      <RadioGroup label="초기화 범위" value={mode} isDisabled={isPending || disabled}
        onChange={value => setMode(value as FloorEditorClearMode)} items={[
          { value: "elements_only", label: "요소만 초기화", description: "도형, 문자, CAD 요소와 슬롯을 제거하고 현재 조명 위치를 유지합니다." },
          { value: "elements_and_placement", label: "요소와 조명 배치 초기화", description: "맵 요소와 슬롯을 제거하고 조명을 미배치 상태로 변경합니다." }
        ]} />
      <Text>등록 조명과 제어 설정은 유지됩니다. 초기화 전 맵은 기록에서 복구할 수 있습니다.</Text>
      {error ? <Text role="alert" tone="danger">{error}</Text> : null}
    </div>
  </ModalDialog>;
}
