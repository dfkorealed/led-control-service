import { expectTypeOf, it } from "vitest";
import type { FloorLightSlotDto } from "@led-control/shared";
import type { FloorEditorState, FloorImportApplyResult } from "./editor-types";

it("exposes slots and the complete atomic CAD apply result", () => {
  expectTypeOf<FloorEditorState["lightSlots"]>().toEqualTypeOf<FloorLightSlotDto[]>();
  expectTypeOf<FloorImportApplyResult["deletedObjectCount"]>().toEqualTypeOf<number>();
  expectTypeOf<FloorImportApplyResult["unplacedFixtureCount"]>().toEqualTypeOf<number>();
  expectTypeOf<FloorImportApplyResult["deletedSlotCount"]>().toEqualTypeOf<number>();
  expectTypeOf<FloorImportApplyResult["createdSlotCount"]>().toEqualTypeOf<number>();
});
