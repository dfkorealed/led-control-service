import { useQueryClient } from "@tanstack/react-query";
import { Hand, Minus, MousePointer2, Save, Square, Triangle, Type, Undo2, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect } from "react";
import { createFloorMapObject, updateEditorFixture, updateFloorMapObject, updateFloorPlan } from "../../api/floor-editor";
import { EditorPropertiesPanel } from "./EditorPropertiesPanel";
import { FloorAssetUploader } from "./FloorAssetUploader";
import { FloorEditorCanvas } from "./FloorEditorCanvas";
import { useFloorEditorStore } from "./editor-store";
import type { EditorFixture, EditorTool, FloorEditorState, FloorMapObject, FloorMapObjectDraft } from "./editor-types";

interface FloorEditorViewProps {
  initialState: FloorEditorState;
  onCancel: () => void;
  onSaved: (state: FloorEditorState) => void | Promise<void>;
}

const tools: Array<{ key: EditorTool; label: string; icon: typeof MousePointer2 }> = [
  { key: "select", label: "선택", icon: MousePointer2 },
  { key: "pan", label: "이동", icon: Hand },
  { key: "rectangle", label: "사각형", icon: Square },
  { key: "triangle", label: "삼각형", icon: Triangle },
  { key: "line", label: "선", icon: Minus },
  { key: "text", label: "텍스트", icon: Type }
];

export function FloorEditorView({ initialState, onCancel, onSaved }: FloorEditorViewProps) {
  const queryClient = useQueryClient();
  const { state, activeTool, zoom, initialize, setActiveTool, setZoom, resetZoom } = useFloorEditorStore();

  useEffect(() => {
    initialize(initialState);
  }, [initialState, initialize]);

  async function handleSave() {
    if (!state) return;
    await persistEditorState(initialState, state);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
      queryClient.invalidateQueries({ queryKey: ["floor-editor", state.floor.id] })
    ]);
    await onSaved(state);
  }

  return (
    <section className="floor-editor-shell">
      <header className="floor-editor-topbar">
        <div>
          <span className="eyebrow">층별 도면 에디터</span>
          <h2>{initialState.floor.name} 도면 편집</h2>
        </div>
        <div className="floor-editor-actions">
          <button className="icon-button" aria-label="축소" onClick={() => setZoom(zoom - 0.1)}>
            <ZoomOut size={18} />
          </button>
          <button className="zoom-reset-button" onClick={resetZoom}>100%</button>
          <button className="icon-button" aria-label="확대" onClick={() => setZoom(zoom + 0.1)}>
            <ZoomIn size={18} />
          </button>
          <button className="secondary-button" onClick={onCancel}>
            <Undo2 size={16} />
            취소
          </button>
          <button className="primary-button" onClick={handleSave}>
            <Save size={16} />
            저장
          </button>
        </div>
      </header>

      <div className="floor-editor-layout">
        <aside className="floor-editor-toolbar" role="toolbar" aria-label="도면 편집 도구">
          {tools.map((tool) => {
            const Icon = tool.icon;
            return (
              <button
                key={tool.key}
                className={activeTool === tool.key ? "active" : ""}
                aria-label={tool.label}
                title={tool.label}
                onClick={() => setActiveTool(tool.key)}
              >
                <Icon size={18} />
              </button>
            );
          })}
        </aside>
        <main className="floor-editor-stage">
          <FloorEditorCanvas />
        </main>
        <div className="floor-editor-side-panel">
          <FloorAssetUploader />
          <EditorPropertiesPanel />
        </div>
      </div>
    </section>
  );
}

async function persistEditorState(initialState: FloorEditorState, state: FloorEditorState) {
  const initialFixtureIds = new Set(initialState.fixtures.map((fixture) => fixture.id));
  const initialObjectIds = new Set(initialState.objects.map((object) => object.id));
  const operations: Array<Promise<unknown>> = [];

  if (state.floor.floorPlan) {
    operations.push(updateFloorPlan(state.floor.id, state.floor.floorPlan));
  }

  for (const fixture of state.fixtures) {
    if (!initialFixtureIds.has(fixture.id)) continue;
    operations.push(updateEditorFixture(fixture.id, toFixturePayload(fixture)));
  }

  for (const object of state.objects) {
    const draft = toObjectDraft(object);
    if (object.id.startsWith("draft-") || !initialObjectIds.has(object.id)) {
      operations.push(createFloorMapObject(state.floor.id, draft));
    } else {
      operations.push(updateFloorMapObject(object.id, draft));
    }
  }

  await Promise.all(operations);
}

function toFixturePayload(fixture: EditorFixture) {
  return {
    name: fixture.name,
    ratedWatt: fixture.ratedWatt,
    x: fixture.x,
    y: fixture.y
  };
}

function toObjectDraft(object: FloorMapObject): FloorMapObjectDraft {
  return {
    type: object.type,
    x: object.x,
    y: object.y,
    width: object.width,
    height: object.height,
    points: object.points,
    rotation: object.rotation,
    strokeColor: object.strokeColor,
    fillColor: object.fillColor,
    strokeWidth: object.strokeWidth,
    text: object.text,
    fontSize: object.fontSize,
    zIndex: object.zIndex,
    locked: object.locked,
    visible: object.visible
  };
}
