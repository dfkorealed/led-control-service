import { expectTypeOf, it } from "vitest";
import type { FloorLightSlotDto, MapElement } from "@led-control/shared";
import type { EditorTool, FloorEditorState, FloorImportApplyResult } from "./editor-types";

it("offers every common shape as an editor tool", () => {
  expectTypeOf<EditorTool>().toEqualTypeOf<"select" | "pan" | MapElement["type"]>();
});

it("exposes slots and the complete atomic CAD apply result", () => {
  expectTypeOf<FloorEditorState["lightSlots"]>().toEqualTypeOf<FloorLightSlotDto[]>();
  expectTypeOf<FloorImportApplyResult["deletedObjectCount"]>().toEqualTypeOf<number>();
  expectTypeOf<FloorImportApplyResult["unplacedFixtureCount"]>().toEqualTypeOf<number>();
  expectTypeOf<FloorImportApplyResult["deletedSlotCount"]>().toEqualTypeOf<number>();
  expectTypeOf<FloorImportApplyResult["createdSlotCount"]>().toEqualTypeOf<number>();
});
