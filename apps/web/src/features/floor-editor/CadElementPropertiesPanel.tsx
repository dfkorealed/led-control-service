import { useEffect, useState } from "react";
import type { CadElementOverridePatch } from "@led-control/shared";
import { Button, FormField, Heading, NumberField, Text, TextField, themeColor } from "../../components/ui";
import type { CadEditorSelection } from "./editor-types";

export function CadElementPropertiesPanel({
  selection,
  readOnly,
  isSaving,
  onChange
}: {
  selection: CadEditorSelection;
  readOnly: boolean;
  isSaving: boolean;
  onChange: (patch: Omit<CadElementOverridePatch, "elementId">) => void;
}) {
  if (selection.mode === "group") {
    return (
      <aside className="grid content-start gap-3 p-3" aria-label="CAD 그룹 속성">
        <Text variant="overline" tone="secondary">CAD 그룹</Text>
        <Heading as="h3" variant="card-title">{selection.layerName}</Heading>
        <Text variant="caption" tone="secondary">{selection.groupId}</Text>
      </aside>
    );
  }
  if (!selection.element) return null;
  return (
    <CadElementForm
      key={selection.element.elementId}
      element={selection.element}
      readOnly={readOnly}
      isSaving={isSaving}
      onChange={onChange}
    />
  );
}

function CadElementForm({ element, readOnly, isSaving, onChange }: {
  element: NonNullable<Extract<CadEditorSelection, { mode: "element" }>["element"]>;
  readOnly: boolean;
  isSaving: boolean;
  onChange: (patch: Omit<CadElementOverridePatch, "elementId">) => void;
}) {
  const [strokeColor, setStrokeColor] = useState(element.override?.strokeColor ?? element.strokeColor ?? themeColor("fixture-editor-label"));
  const [fillColor, setFillColor] = useState(element.override?.fillColor ?? element.fillColor ?? themeColor("surface-panel"));
  const [strokeWidth, setStrokeWidth] = useState(element.override?.strokeWidth ?? element.strokeWidth);
  const [text, setText] = useState(element.override?.text ?? element.text ?? "");

  useEffect(() => {
    setStrokeColor(element.override?.strokeColor ?? element.strokeColor ?? themeColor("fixture-editor-label"));
    setFillColor(element.override?.fillColor ?? element.fillColor ?? themeColor("surface-panel"));
    setStrokeWidth(element.override?.strokeWidth ?? element.strokeWidth);
    setText(element.override?.text ?? element.text ?? "");
  }, [element]);

  const hidden = element.override?.hidden ?? false;
  return (
    <aside className="grid content-start gap-3 p-3" aria-label="CAD 요소 속성">
      <Text variant="overline" tone="secondary">CAD 요소</Text>
      <Heading as="h3" variant="card-title">{element.layerName}</Heading>
      <Text variant="caption" tone="secondary">{element.elementId}</Text>
      <div className="grid grid-cols-2 gap-2">
        <ColorField label="선 색상" value={strokeColor} disabled={readOnly || isSaving} onChange={setStrokeColor} />
        {element.closed ? <ColorField label="채우기 색상" value={fillColor} disabled={readOnly || isSaving} onChange={setFillColor} /> : null}
      </div>
      <NumberField
        label="선 두께"
        isDisabled={readOnly || isSaving}
        minValue={0}
        maxValue={512}
        value={strokeWidth}
        onChange={(value) => value !== null && setStrokeWidth(value)}
      />
      {element.text !== null ? (
        <TextField label="텍스트" isDisabled={readOnly || isSaving} value={text} onChange={setText} />
      ) : null}
      <Button
        variant="primary"
        disabled={readOnly || isSaving}
        onClick={() => onChange({
          strokeColor,
          ...(element.closed ? { fillColor } : {}),
          strokeWidth,
          ...(element.text !== null ? { text } : {})
        })}
      >
        CAD 속성 적용
      </Button>
      <Button
        variant={hidden ? "secondary" : "danger"}
        disabled={readOnly || isSaving}
        onClick={() => onChange({ hidden: !hidden })}
      >
        {hidden ? "요소 표시" : "요소 숨기기"}
      </Button>
    </aside>
  );
}

function ColorField({ label, value, disabled, onChange }: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <FormField label={label} isDisabled={disabled}>
      {(attributes) => <input {...attributes} type="color" value={normalizeColor(value)} onChange={(event) => onChange(event.target.value)} />}
    </FormField>
  );
}

function normalizeColor(value: string) {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : themeColor("fixture-editor-label");
}
