const PARAMETER_COMMANDS = new Set("fFACcHWTQpS");
const TOGGLE_COMMANDS = new Set("LlOoKk");

/** Decode raw MTEXT once, never an already-decoded string or a TEXT entity. */
export function decodeCadMText(value: string): string {
  const output: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === "{" || character === "}") continue;
    if (character !== "\\" || index + 1 === value.length) {
      output.push(character);
      continue;
    }
    const command = value[index + 1];
    if (command === "\\" || command === "{" || command === "}") {
      output.push(command);
      index++;
    } else if (command === "P" || command === "X" || command === "~") {
      output.push(command === "~" ? "\u00a0" : "\n");
      index++;
    } else if (TOGGLE_COMMANDS.has(command)) {
      index++;
    } else if (command === "U" && value[index + 2] === "+" && /^[0-9a-f]{4}$/i.test(value.slice(index + 3, index + 7))) {
      // DXF escapes encode UTF-16 units; adjacent surrogate escapes must stay
      // together until the normal layout sanitizer validates Unicode scalars.
      output.push(String.fromCharCode(Number.parseInt(value.slice(index + 3, index + 7), 16)));
      index += 6;
    } else if (PARAMETER_COMMANDS.has(command)) {
      let end = index + 2;
      while (end < value.length && !";\\{}\r\n".includes(value[end])) end++;
      if (value[end] === ";") {
        // The current plain-text contract cannot represent stacked fractions
        // or tolerances; retain both values with a readable separator instead.
        if (command === "S") output.push(value.slice(index + 2, end).replace(/[#^]/g, "/"));
        index = end;
      } else {
        // Do not swallow the remaining label on malformed/unterminated codes.
        // Advance through the inspected span to keep adversarial input linear.
        output.push(value.slice(index, end));
        index = end - 1;
      }
    } else {
      output.push(character);
    }
  }
  return output.join("");
}
