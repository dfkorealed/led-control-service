import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { TextField, TextArea } from "../../components/ui/fields/TextField";
afterEach(cleanup);
it("forwards keyboard capitalization/correction/spelling policy to editable controls", () => {
  render(<><TextField label="아이디" autoCapitalize="none" autoCorrect="off" spellCheck={false} /><TextArea label="메모" autoCapitalize="sentences" autoCorrect="on" spellCheck /></>);
  expect(screen.getByLabelText("아이디")).toHaveAttribute("autocapitalize", "none");
  expect(screen.getByLabelText("아이디")).toHaveAttribute("autocorrect", "off");
  expect(screen.getByLabelText("아이디")).toHaveAttribute("spellcheck", "false");
  expect(screen.getByLabelText("메모")).toHaveAttribute("autocapitalize", "sentences");
  expect(screen.getByLabelText("메모")).toHaveAttribute("spellcheck", "true");
});
