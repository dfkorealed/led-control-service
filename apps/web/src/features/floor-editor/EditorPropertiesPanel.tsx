import { useMemo } from "react";
import { useFloorEditorStore } from "./editor-store";

export function EditorPropertiesPanel({ readOnly = false }: { readOnly?: boolean }) {
  const { state, selection, updateFixture, updateObject } = useFloorEditorStore();
  const selected = useMemo(() => {
    if (!state || !selection) return null;
    if (selection.kind === "fixture") {
      return { kind: "fixture" as const, value: state.fixtures.find((fixture) => fixture.id === selection.id) ?? null };
    }
    return { kind: "object" as const, value: state.objects.find((object) => object.id === selection.id) ?? null };
  }, [state, selection]);

  if (!state || !selected?.value) {
    return (
      <aside className="editor-properties-panel" aria-label="속성 패널">
        <span className="eyebrow">속성</span>
        <h3>선택 없음</h3>
        <p className="muted-text">조명 또는 도형을 선택하면 좌표와 스타일을 조정할 수 있습니다.</p>
      </aside>
    );
  }

  if (selected.kind === "fixture") {
    const fixture = selected.value;
    return (
      <aside className="editor-properties-panel" aria-label="속성 패널">
        <span className="eyebrow">조명 속성</span>
        <h3>{fixture.name}</h3>
        <label>
          조명명
          <input disabled={readOnly} value={fixture.name} onChange={(event) => updateFixture(fixture.id, { name: event.target.value })} />
        </label>
        <label>
          정격 전력
          <input
            type="number"
            disabled={readOnly}
            value={fixture.ratedWatt}
            onChange={(event) => updateFixture(fixture.id, { ratedWatt: Number(event.target.value) })}
          />
        </label>
        <div className="editor-property-grid">
          <label>
            X
            <input type="number" disabled={readOnly} value={Math.round(fixture.x)} onChange={(event) => updateFixture(fixture.id, { x: Number(event.target.value) })} />
          </label>
          <label>
            Y
            <input type="number" disabled={readOnly} value={Math.round(fixture.y)} onChange={(event) => updateFixture(fixture.id, { y: Number(event.target.value) })} />
          </label>
          <label>
            크기
            <input type="number" disabled={readOnly} value={Math.round(fixture.size ?? 20)} onChange={(event) => updateFixture(fixture.id, { size: Number(event.target.value) })} />
          </label>
        </div>
      </aside>
    );
  }

  const object = selected.value;
  return (
    <aside className="editor-properties-panel" aria-label="속성 패널">
      <span className="eyebrow">도형 속성</span>
      <h3>{object.type}</h3>
      <label>
        선 색상
        <input type="color" disabled={readOnly} value={normalizeColorValue(object.strokeColor)} onChange={(event) => updateObject(object.id, { strokeColor: event.target.value })} />
      </label>
      <label>
        채우기 색상
        <input type="color" disabled={readOnly} value={normalizeColorValue(object.fillColor ?? "")} onChange={(event) => updateObject(object.id, { fillColor: event.target.value })} />
      </label>
      <label>
        선 두께
        <input type="number" disabled={readOnly} value={object.strokeWidth} onChange={(event) => updateObject(object.id, { strokeWidth: Number(event.target.value) })} />
      </label>
      <label>
        텍스트
        <input disabled={readOnly} value={object.text} onChange={(event) => updateObject(object.id, { text: event.target.value })} />
      </label>
      <label>
        글자 크기
        <input type="number" disabled={readOnly} value={object.fontSize ?? 16} onChange={(event) => updateObject(object.id, { fontSize: Number(event.target.value) })} />
      </label>
    </aside>
  );
}

function normalizeColorValue(color: string) {
  return /^#[0-9a-f]{6}$/i.test(color) ? color : "#2563eb";
}
