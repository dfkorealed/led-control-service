import { expect, expectTypeOf, it } from "vitest";
import * as UI from "./index";

it("publishes the shared producer contract with typed row keys and controller props", () => {
  expectTypeOf<UI.DatePickerProps["draftController"]>().toEqualTypeOf<UI.DateDraftController | undefined>();
  expectTypeOf<UI.DateRangePickerProps["draftController"]>().toEqualTypeOf<UI.DateRangeDraftController | undefined>();
  expectTypeOf<UI.DataGridColumn<{ id: number }>["renderCell"]>().parameters.toEqualTypeOf<[row: { id: number }, surface: "table" | "card"]>();
  const menu = <UI.RowActions rowLabel="조명" items={[{ id: 0, label: "수정" }]} onAction={(key: 0) => void key} />;
  // @ts-expect-error Numeric menu keys do not become strings at the callback boundary.
  const wrong = <UI.RowActions rowLabel="조명" items={[{ id: 0, label: "수정" }]} onAction={(key: "0") => void key} />;
  expect(menu).toBeDefined(); expect(wrong).toBeDefined();
});
