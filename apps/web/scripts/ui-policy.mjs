import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { execFileSync } from "node:child_process";

// Updating this reviewed trust anchor is a policy change, never a baseline edit.
const approvedSourceRef = "24b5ea593e860575f7bf1007781146cf1101beb7";
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function approvedSource(path) {
  return execFileSync("git", ["show", `${approvedSourceRef}:apps/web/${path}`], { cwd: webRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
// Normalize formatting, not CSS meaning: token values remain owned by the
// reviewed Git source. Preserve separators between numbers/identifiers.
const normalizeThemeValue = value => value.trim().replace(/\s+/g, " ").replace(/\s*([(),/])\s*/g, "$1");
const fixtureBrightnessShadowValues = [
  "0 0 0 0 color-mix(in srgb, var(--color-fixture-on) 0%, transparent), inset 0 0 0 1px color-mix(in srgb, var(--color-content-inverse) 24%, transparent)",
  "0 0 2px 0.5px color-mix(in srgb, var(--color-fixture-on) 4%, transparent), inset 0 0 0 1px color-mix(in srgb, var(--color-content-inverse) 24%, transparent)",
  "0 0 3.5px 1px color-mix(in srgb, var(--color-fixture-on) 8%, transparent), inset 0 0 0 1px color-mix(in srgb, var(--color-content-inverse) 24%, transparent)",
  "0 0 5px 1.5px color-mix(in srgb, var(--color-fixture-on) 12%, transparent), inset 0 0 0 1px color-mix(in srgb, var(--color-content-inverse) 24%, transparent)",
  "0 0 6.5px 2px color-mix(in srgb, var(--color-fixture-on) 16%, transparent), inset 0 0 0 1px color-mix(in srgb, var(--color-content-inverse) 24%, transparent)",
  "0 0 8px 2.5px color-mix(in srgb, var(--color-fixture-on) 20%, transparent), inset 0 0 0 1px color-mix(in srgb, var(--color-content-inverse) 24%, transparent)",
  "0 0 9.5px 3px color-mix(in srgb, var(--color-fixture-on) 24%, transparent), inset 0 0 0 1px color-mix(in srgb, var(--color-content-inverse) 24%, transparent)",
  "0 0 11px 3.5px color-mix(in srgb, var(--color-fixture-on) 28%, transparent), inset 0 0 0 1px color-mix(in srgb, var(--color-content-inverse) 24%, transparent)",
  "0 0 12.5px 4.25px color-mix(in srgb, var(--color-fixture-on) 34%, transparent), inset 0 0 0 1px color-mix(in srgb, var(--color-content-inverse) 24%, transparent)",
  "0 0 14px 5px color-mix(in srgb, var(--color-fixture-on) 42%, transparent), inset 0 0 0 1px color-mix(in srgb, var(--color-content-inverse) 24%, transparent)"
];
const reviewedThemeTokenAdditions = new Map([
  ["--radius-fixture-marker", "3px"],
  ...fixtureBrightnessShadowValues.map((value, index) => [`--shadow-fixture-brightness-${index + 1}`, normalizeThemeValue(value)])
]);
const approvedThemeValues = new Map([...maskComments(approvedSource("src/styles/theme.css"), "theme.css").matchAll(/(--[\w*-]+)\s*:\s*([^;]+);/g)].map(match => [match[1], normalizeThemeValue(match[2])]));
for (const name of reviewedThemeTokenAdditions.keys()) {
  if (approvedThemeValues.has(name)) throw new Error(`Reviewed theme addition already exists in the immutable source: ${name}`);
}
const themeValues = new Map([...approvedThemeValues, ...reviewedThemeTokenAdditions]);
const themeTokens = new Set(themeValues.keys());

// FloorScene is migrated by its owning page task. Until that lands, keep the
// exact reviewed occurrences as a shrinking debt budget; any new or duplicated
// arbitrary marker utility is still rejected by the policy.
const reviewedArbitraryThemeDebt = new Map([
  ["src/features/floor-map/FloorScene.tsx", new Map([
    ["rounded-[3px]", 1],
    ...fixtureBrightnessShadowValues.map(value => [`shadow-[${value.replaceAll(", ", ",").replaceAll(" ", "_")}]`, 1])
  ])]
]);

const spacing = new Set(["0", "0.5", "1", "1.5", "2", "2.5", "3", "3.5", "4", "4.5", "5", "6", "7", "8", "10", "12", "16"]);
const approvedCss = new Set(["src/styles.css", "src/styles/theme.css", "src/styles/base.css", "src/styles/exceptions.css"]);
const entryImports = new Set(["tailwindcss", "./styles/theme.css", "./styles/base.css", "./styles/exceptions.css"]);
const testPath = /(?:^|\/)(?:test|tests|__tests__|e2e)(?:\/|$)|\.(?:test|spec)\.[^.]+$/;
const colorLiteral = /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lch|lab|color)\([^;{}]*?\)/gi;
const namedColors = new Set(("aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen").split(" "));

// CSS functions and quoted React style values may contain commas; only a
// delimiter outside them ends the value. This preserves the complete debt match.
function styleValue(source, start, commaDelimiter = true) {
  let depth = 0;
  let quote = "";
  let end = start;
  for (; end < source.length; end++) {
    const char = source[end];
    if (quote) {
      if (char === "\\") end++;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (depth === 0 && (/[;}]/.test(char) || commaDelimiter && /[,\n]/.test(char))) break;
  }
  return source.slice(start, end).trim();
}

function parseScript(source, path) {
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function maskComments(source, path) {
  const spans = new Map();
  const literals = [];
  if (path.endsWith(".css")) {
    let quote = "";
    for (let index = 0; index < source.length; index++) {
      const char = source[index];
      if (quote) {
        if (char === "\\") index++;
        else if (char === quote) quote = "";
      } else if (char === '"' || char === "'") quote = char;
      else if (source.startsWith("/*", index)) {
        const close = source.indexOf("*/", index + 2);
        const end = close < 0 ? source.length : close + 2;
        spans.set(index, end);
        index = end - 1;
      }
    }
  } else {
    const file = parseScript(source, path);
    const collect = position => {
      for (const range of [...ts.getLeadingCommentRanges(source, position) ?? [], ...ts.getTrailingCommentRanges(source, position) ?? []]) spans.set(range.pos, range.end);
    };
    function visit(node) {
      if (ts.isStringLiteral(node) || [ts.SyntaxKind.NoSubstitutionTemplateLiteral, ts.SyntaxKind.TemplateHead, ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail, ts.SyntaxKind.RegularExpressionLiteral, ts.SyntaxKind.JsxText, ts.SyntaxKind.JsxTextAllWhiteSpaces].includes(node.kind)) literals.push([node.getStart(file), node.end]);
      // JSX text is literal content even when it begins with // or /*.
      if (node.kind === ts.SyntaxKind.JsxText || node.kind === ts.SyntaxKind.JsxTextAllWhiteSpaces) return;
      collect(node.pos);
      collect(node.end);
      for (const child of node.getChildren(file)) visit(child);
    }
    visit(file);
  }
  let masked = source;
  for (const [start, end] of spans) {
    // A parent's trailing trivia query can see the next JSX text as a comment;
    // syntax-owned literal ranges override that ambiguous lexical candidate.
    if (!literals.some(([from, to]) => start >= from && start < to)) masked = masked.slice(0, start) + source.slice(start, end).replace(/[^\r\n]/g, " ") + masked.slice(end);
  }
  return masked;
}

function queryFingerprints(source, path) {
  // TypeScript is already the app's compiler dependency. Its existing parser
  // preserves nested/template selector arguments without a second parser package.
  const file = parseScript(source, path);
  const printer = ts.createPrinter({ removeComments: true });
  const calls = new Map();
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && /^(?:querySelector|querySelectorAll)$/.test(node.expression.name.text)) {
      calls.set(node.expression.name.getStart(file), printer.printNode(ts.EmitHint.Expression, node, file));
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return calls;
}

function scriptLiteralRanges(source, path) {
  const file = parseScript(source, path);
  const ranges = [];
  function visit(node) {
    if (ts.isStringLiteral(node) || ts.isTemplateLiteralToken(node)) ranges.push([node.getStart(file), node.end]);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return ranges;
}

/** A lexical migration guard, not a CSS/JS type checker. Exact debt matches keep
 * a removed legacy violation from silently authorizing a different new one. */
export function inspectUiSource(path, source) {
  path = path.replaceAll("\\", "/").replace(/^.*\/apps\/web\//, "");
  if (testPath.test(path)) return [];
  const violations = [];
  const add = (rule, match, index = 0) => violations.push({ rule, path, match, index });
  let text = maskComments(source, path);
  // Only declarations inside the canonical @theme block own raw palette and
  // typed scale values. Ordinary rules in this file still pass through policy.
  if (path === "src/styles/theme.css") {
    const blocks = [...text.matchAll(/@theme\b[^{}]*\{/g)];
    if (blocks.length !== 1 || !/^@theme\s+static\s*\{$/.test(blocks[0]?.[0] ?? "")) add("unapproved-theme-block", "Expected exactly one @theme static block");
    const declarations = new Map();
    text = text.replace(/@theme\s+static\s*\{[^{}]*\}/g, (block, blockIndex) => block.replace(
      /(--[\w*-]+)\s*:\s*([^;}]*)(?:;|(?=\}))/g,
      (value, name, rawValue, offset) => {
        if (themeTokens.has(name)) {
          declarations.set(name, (declarations.get(name) ?? 0) + 1);
          if (declarations.get(name) > 1) add("duplicate-theme-token", name, blockIndex + offset);
          const currentValue = normalizeThemeValue(rawValue);
          if (currentValue !== themeValues.get(name)) add("unapproved-theme-value", `${name}: ${currentValue}`, blockIndex + offset);
          return " ".repeat(value.length);
        }
        add("unapproved-theme-token", name, blockIndex + offset);
        return value;
      }
    ));
    // Removing tokens breaks semantic utilities just as changing their values
    // does. The complete immutable inventory is required, exactly once each.
    for (const name of themeTokens) if (!declarations.has(name)) add("missing-theme-token", name);
  }
  const scan = (regex, callback) => { for (const match of text.matchAll(regex)) callback(match); };
  // Responsive candidates in scripts live inside strings/template segments.
  // A CVA size map's sm:/md:/lg: keys (or TypeScript property signatures) are
  // syntax, not utilities. CSS @apply candidates still use the CSS source.
  const responsiveRanges = path.endsWith(".css") ? null : scriptLiteralRanges(text, path);
  scan(/(?<![\w-])(?:(?:max-|min-)\[[^\]\n]+\]|(?:max-|min-)?(?:sm|md|lg|xl|2xl|compact|tablet)):/g, m => {
    if (responsiveRanges && !responsiveRanges.some(([start, end]) => m.index >= start && m.index + m[0].length <= end)) return;
    const name = m[0].replace(/^(?:max-|min-)/, "").slice(0, -1);
    if (!themeTokens.has(`--breakpoint-${name}`)) add("unapproved-breakpoint", m[0], m.index);
  });
  scan(/(?<![\w-])(?:bg|text|border(?:-[trblxyse])?|ring(?:-offset)?|outline|fill|stroke|decoration|accent|caret|from|via|to)-((?:brand|surface|content|border|action|status|chart|fixture)-[\w-]+)/g, m => {
    if (!themeTokens.has(`--color-${m[1]}`)) add("unapproved-color", m[0], m.index);
  });
  scan(/(?<![\w-])text-([a-z][\w-]*)(?![\w-]|\s*:)/g, m => {
    if (!themeTokens.has(`--text-${m[1]}`) && !/^(?:brand|surface|content|border|action|status|chart|fixture|red|blue|green|gray|slate|zinc|neutral|stone|amber|orange|yellow|purple|pink|rose|indigo|cyan|teal|emerald|lime|sky|violet|fuchsia)-/.test(m[1]) && !/^(?:xs|sm|base|lg|xl|black|white|left|right|center|start|end|justify|wrap|nowrap|balance|pretty|ellipsis|clip)$/.test(m[1])) add("unapproved-typography", m[0], m.index);
  });
  scan(/(?<![\w-])(rounded|shadow)-([a-z][\w-]*)/g, m => {
    if (m[2] !== "none" && !themeTokens.has(`--${m[1] === "rounded" ? "radius" : "shadow"}-${m[2]}`)) add("unapproved-theme-utility", m[0], m.index);
  });
  const arbitraryThemeCounts = new Map();
  scan(/(?<![\w-])(?:rounded|shadow)-\[[^\]\n]+\]/g, m => {
    const count = (arbitraryThemeCounts.get(m[0]) ?? 0) + 1;
    arbitraryThemeCounts.set(m[0], count);
    const allowance = reviewedArbitraryThemeDebt.get(path)?.get(m[0]) ?? 0;
    if (count > allowance) add("arbitrary-theme-utility", m[0], m.index);
  });
  const spacePrefix = "(?:p[trblxyse]?|m[trblxyse]?|gap(?:-[xy])?|space-[xy]|inset(?:-[xy])?|top|right|bottom|left|start|end|scroll-[pm][trblxyse]?)";
  scan(new RegExp(`(?<![\\w-])-?${spacePrefix}-(?:\\[[^\\]\\n]+\\]|\\([^\\)\\n]+\\))`, "g"), m => add("arbitrary-spacing", m[0], m.index));
  scan(new RegExp(`(?<![\\w-])-?${spacePrefix}-px(?![\\w-])`, "g"), m => add("unapproved-spacing", m[0], m.index));
  scan(new RegExp(`(?<![\\w-])-?${spacePrefix}-(\\d+(?:\\.\\d+)?)(?![\\w.])(?:\\/\\d+)?`, "g"), m => {
    const fraction = m[0].includes("/");
    const geometryFraction = /^-?(?:inset(?:-[xy])?|top|right|bottom|left|start|end)-/.test(m[0]);
    if (fraction ? !geometryFraction : !spacing.has(m[1])) add("unapproved-spacing", m[0], m.index);
  });
  scan(colorLiteral, m => add("raw-color", m[0], m.index));
  scan(/(?<![\w-])(?:bg|text|border(?:-[trblxyse])?|ring(?:-offset)?|outline|fill|stroke|decoration|accent|caret|from|via|to)-(?:\[[^\]\n]+\]|\([^\)\n]+\))/g, m => {
    if (/^text-\[(?:length:|[\d.]+(?:px|rem|em))/.test(m[0])) add("arbitrary-typography", m[0], m.index);
    else if (!new RegExp(colorLiteral.source, "i").test(m[0])) add("arbitrary-color", m[0], m.index);
  });
  scan(/(?<![\w-])(?:text-(?:xs|sm|base|lg|xl|\d+xl)|leading-(?:\d+(?:\.\d+)?|none|tight|snug|normal|relaxed|loose)|tracking-(?:tighter|tight|normal|wide|wider|widest))(?![\w-])/g, m => add("unapproved-typography", m[0], m.index));
  scan(/(?<![\w-])(?:leading|tracking)-(?:\[[^\]\n]+\]|\([^\)\n]+\))/g, m => add("arbitrary-typography", m[0], m.index));
  // Each semantic text size owns its paired line height; no slash override is
  // approved. Color opacity modifiers such as text-content-primary/70 differ.
  scan(/(?<![\w-])text-(?:display|page-title|section-title|card-title|body-lg|body-sm|body|label|caption|overline|metric)\/(?:\[[^\]\n]+\]|\([^\)\n]+\)|[^\s"'<>}]+)/g, m => add("unapproved-typography", m[0], m.index));
  scan(/(?<![\w-])(?:bg|text|border|ring|outline|fill|stroke|decoration|accent|caret|from|via|to)-(?:[a-z]+-\d{2,3}|black|white)(?![\w-])/g, m => add("unapproved-color", m[0], m.index));
  let queries;
  scan(/\b(?:querySelector|querySelectorAll)\s*(?:\?\.\s*)?(?:<[^;\n]+?>\s*)?\(/g, m => {
    queries ??= queryFingerprints(text, path);
    // A match in incomplete/invalid source must not inherit a short allowance.
    add("query-selector", queries.get(m.index) ?? text.slice(m.index).split("\n")[0], m.index);
  });
  scan(/(?:@import\s+(?:url\(\s*)?|\bimport\s*(?:\(\s*)?|\bfrom\s*)["']([^"']+)["']/g, m => {
    if (!m[1].split(/[?#]/, 1)[0].endsWith(".css") && !m[0].startsWith("@import")) return;
    const allowed = path === "src/styles.css" && entryImports.has(m[1]) || path === "src/main.tsx" && m[1] === "./styles.css";
    if (!allowed) add("css-import", m[1], m.index);
  });
  scan(/@import\s+url\(\s*([^\s"')]+)\s*\)/g, m => {
    if (!(path === "src/styles.css" && entryImports.has(m[1]))) add("css-import", m[1], m.index);
  });
  if (!path.startsWith("src/components/ui/")) {
    scan(/<(?:input|select|textarea|button)\b[^>]*?\b(?:className|style)\s*=/g, m => add("raw-form-style", m[0].replace(/\s+/g, " "), m.index));
  }
  scan(/(?<![\w-])((?:scroll-)?padding(?:-[\w]+|[A-Z]\w*)?|(?:scroll-)?margin(?:-[\w]+|[A-Z]\w*)?|gap|row-gap|column-gap|rowGap|columnGap|top|right|bottom|left|inset)\s*:\s*/g, m => {
    const value = styleValue(text, m.index + m[0].length);
    if (/(?:\d*\.)?\d+(?:px|rem)\b/.test(value) || /^\s*["']?-?(?!0(?:\s|["']|$))\d+(?:\.\d+)?\s*(?:["']|$)/.test(value)) {
      // Only runtime position calculations receive the geometry exception.
      // Static calc()/clamp() and padding/margin/gap cannot add off-scale values.
      const position = /^(?:top|right|bottom|left|inset)$/.test(m[1]);
      if (!(position && /var\(--|\d(?:%|(?:[sdl]?v[whib]))/.test(value))) add("literal-spacing", `${m[1]}: ${value}`, m.index);
    }
  });
  scan(/\b(font-size|fontSize|line-height|lineHeight|letter-spacing|letterSpacing)\s*:\s*/g, m => {
    const value = styleValue(text, m.index + m[0].length);
    if ((/^['"]?-?(?:\d|\.\d)/.test(value) && !/^['"]?0['"]?$/.test(value)) || /\d(?:px|rem|em)\b/.test(value)) add("literal-typography", `${m[1]}: ${value}`, m.index);
  });
  const colorProperty = "(?:color|background(?:-color|Color|-image|Image)?|(?:box|text)(?:-shadow|Shadow)|border(?:-[\\w]+|[A-Z]\\w*)?|fill|stroke|stop(?:-color|Color)|(?:backdrop-)?filter|backdropFilter|outline(?:-color|Color)?)";
  const inspectNamedColors = (value, index) => {
    // URL payloads are resource identifiers, not CSS color expressions. Keep
    // adjacent gradient/filter functions in the value subject to inspection.
    value = value.replace(/\burl\(\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:\\.|[^)\\])*)\s*\)/gi, url => " ".repeat(url.length));
    // CSS custom properties are one identifier, not separate color words.
    // Fallback values in var(--token, red) remain subject to the color policy.
    for (const word of value.matchAll(/--[\w-]+|[a-z]+/gi)) {
      if (namedColors.has(word[0].toLowerCase())) add("raw-color", word[0], index + word.index);
    }
  };
  if (path.endsWith(".css")) {
    scan(new RegExp(`\\b${colorProperty}\\s*:\\s*`, "g"), m => inspectNamedColors(styleValue(text, m.index + m[0].length, false), m.index + m[0].length));
  } else {
    const file = parseScript(text, path);
    const propertyPattern = new RegExp(`^${colorProperty}$`);
    function visitColorValues(node) {
      if ((ts.isPropertyAssignment(node) || ts.isJsxAttribute(node)) && propertyPattern.test(node.name.text ?? node.name.getText(file))) {
        let value = node.initializer;
        if (value && ts.isJsxExpression(value)) value = value.expression;
        if (value && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))) inspectNamedColors(value.text, node.getStart(file));
        else if (value && ts.isTemplateExpression(value)) {
          // Read only static segments. A separator prevents an expression from
          // merging adjacent words; its identifiers are never CSS color text.
          inspectNamedColors([value.head.text, ...value.templateSpans.map(span => span.literal.text)].join(" "), node.getStart(file));
        }
      }
      ts.forEachChild(node, visitColorValues);
    }
    visitColorValues(file);
  }
  if (path.endsWith(".css")) {
    if (!approvedCss.has(path)) add("css-file", path);
    const selectorPattern = /(?:^|[{};])\s*([^{};]+)\{/g;
    let m;
    while ((m = selectorPattern.exec(text))) {
      const selector = m[1].trim().replace(/\s+/g, " ");
      if (/^@(?:layer|media|supports|container|scope|document|starting-style)\b/.test(selector)) {
        // Every grouping rule's opening brace is also its first child's
        // boundary, recursively. Keep normalization/fingerprints unchanged.
        selectorPattern.lastIndex -= 1;
        continue;
      }
      if (/^@(?:-[\w]+-)?keyframes\b/.test(selector)) {
        // Keyframes contain animation steps, not element selectors. Skip the
        // balanced block only for selector classification; declaration/color
        // policy above still examines its contents. Quoted braces are data.
        let depth = 1;
        let quote = "";
        let end = selectorPattern.lastIndex;
        for (; end < text.length && depth; end++) {
          const char = text[end];
          if (quote) {
            if (char === "\\") end++;
            else if (char === quote) quote = "";
          } else if (char === '"' || char === "'") quote = char;
          else if (char === "{") depth++;
          else if (char === "}") depth--;
        }
        selectorPattern.lastIndex = end - 1;
        continue;
      }
      if (selector.startsWith("@")) continue;
      const baseAllowed = path === "src/styles/base.css" && ["html", "body", "button, input, select, textarea", ":focus-visible"].includes(selector);
      if (!baseAllowed) add("css-selector", selector, m.index);
      if (/(?:^|[\s,>+~])(?:input|select|textarea|button)(?=[\s.#[:>+~,]|$)/.test(selector) && !baseAllowed) add("raw-form-style", selector, m.index);
    }
  }
  return violations.sort((a, b) => a.index - b.index).map(({ index, ...violation }) => violation);
}

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.isFile() && /\.(?:[cm]?[jt]sx?|css)$/.test(entry.name)) files.push(path);
  }
  return files.sort();
}

async function check(root) {
  const baseline = JSON.parse(await readFile(resolve(root, "scripts/ui-policy-baseline.json"), "utf8"));
  if (baseline.version !== 1 || !baseline.files) throw new Error("Unsupported UI policy baseline");
  const actualRef = execFileSync("git", ["rev-parse", "--verify", `${approvedSourceRef}^{commit}`], { cwd: webRoot, encoding: "utf8" }).trim();
  if (baseline.sourceRef !== approvedSourceRef || actualRef !== approvedSourceRef) throw new Error("UI baseline sourceRef is not the reviewed Git commit");
  // Recompute the maximum permitted debt from immutable committed source.
  // Editing sourceRef, rule totals, or match allowances in the same working tree
  // cannot authorize new debt. Missing Git objects/source files fail closed.
  for (const [path, rules] of Object.entries(baseline.files)) {
    if (!path.startsWith("src/") || path.includes("\\") || path.split("/").some(part => !part || part === "." || part === "..")) throw new Error(`Invalid baseline path: ${path}`);
    const committed = inspectUiSource(path, approvedSource(path));
    for (const [rule, debt] of Object.entries(rules)) {
      const allowances = Object.entries(debt.matches ?? {});
      if (!Number.isInteger(debt.count) || debt.count < 0 || debt.count !== allowances.reduce((sum, [, count]) => sum + count, 0)) throw new Error(`Invalid baseline count: ${path}: ${rule}`);
      for (const [match, count] of allowances) {
        if (!Number.isInteger(count) || count <= 0 || count > committed.filter(v => v.rule === rule && v.match === match).length) throw new Error(`Baseline exceeds reviewed source: ${path}: ${rule}: ${match}`);
      }
    }
  }
  let count = 0;
  const failures = [];
  for (const file of await sourceFiles(resolve(root, "src"))) {
    const path = relative(root, file).replaceAll("\\", "/");
    const matches = new Map();
    const rules = new Map();
    for (const violation of inspectUiSource(path, await readFile(file, "utf8"))) {
      count++;
      const key = `${violation.rule}\0${violation.match}`;
      matches.set(key, (matches.get(key) ?? 0) + 1);
      rules.set(violation.rule, (rules.get(violation.rule) ?? 0) + 1);
      const allowance = baseline.files[path]?.[violation.rule];
      if (matches.get(key) > (allowance?.matches?.[violation.match] ?? 0) || rules.get(violation.rule) > (allowance?.count ?? 0)) failures.push(violation);
    }
  }
  for (const v of failures) console.error(`${v.path}: ${v.rule}: ${v.match}`);
  console.log(`UI policy: ${count} existing violations; ${failures.length} new/increased violations.`);
  process.exitCode = failures.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--root")) throw new Error("Usage: ui-policy.mjs [--root WEB_ROOT]");
  await check(args[1] ? resolve(args[1]) : resolve(dirname(fileURLToPath(import.meta.url)), ".."));
}
