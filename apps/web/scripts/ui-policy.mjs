import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { execFileSync } from "node:child_process";

// Updating this reviewed trust anchor is a policy change, never a baseline edit.
const approvedSourceRef = "b1b500793ad8e4be394d3b2467fe35e0f2631197";
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function approvedSource(path) {
  return execFileSync("git", ["show", `${approvedSourceRef}:apps/web/${path}`], { cwd: webRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
// Normalize formatting, not CSS meaning: token values remain owned by the
// reviewed Git source. Preserve separators between numbers/identifiers.
const normalizeThemeValue = value => value.trim().replace(/\s+/g, " ").replace(/\s*([(),/])\s*/g, "$1");
const approvedThemeValues = new Map([...maskComments(approvedSource("src/styles/theme.css"), "theme.css").matchAll(/(--[\w*-]+)\s*:\s*([^;]+);/g)].map(match => [match[1], normalizeThemeValue(match[2])]));
// Previously reviewed additions are now covered by the immutable token commit.
const themeValues = approvedThemeValues;
const themeTokens = new Set(themeValues.keys());

// These values are runtime geometry/data consumed by Konva or Recharts, not
// document spacing or palette CSS. exceptions.css records why each path cannot
// be represented by static utilities. Exact counts keep the allowlist closed.
const reviewedRuntimeExceptions = new Map([
  ["src/styles/exceptions.css", new Map([
    ["css-selector\0.floor-scene-canvas .konvajs-content, .floor-scene-canvas canvas", 1],
    ["css-selector\0.floor-scene-canvas .konvajs-content", 1]
  ])],
  ["src/features/floor-editor/geometry.ts", new Map([
    ["raw-color\0#2563eb\0variable:base/property:strokeColor", 1],
    ["raw-color\0#dbeafe\0variable:base/property:fillColor", 1],
    ["literal-typography\0fontSize: 16\0variable:base/property:fontSize", 1]
  ])],
  ["src/features/statistics/EnergyComparisonChart.tsx", new Map([
    ["literal-spacing\0top: 12\0jsx:ComposedChart/attribute:margin/property:top", 1],
    ["literal-spacing\0right: 12\0jsx:ComposedChart/attribute:margin/property:right", 1],
    ["literal-spacing\0bottom: 8\0jsx:ComposedChart/attribute:margin/property:bottom", 1]
  ])],
  ["src/features/statistics/StatisticsOverviewPage.tsx", new Map([
    ["literal-spacing\0top: 12\0jsx:LineChart/attribute:margin/property:top", 1],
    ["literal-spacing\0right: 12\0jsx:LineChart/attribute:margin/property:right", 1],
    ["literal-spacing\0bottom: 8\0jsx:LineChart/attribute:margin/property:bottom", 1]
  ])],
  ["src/features/statistics/analysis/EnergyRankingDetailPanel.tsx", new Map([
    ["literal-spacing\0top: 8\0jsx:LineChart/attribute:margin/property:top", 1],
    ["literal-spacing\0right: 10\0jsx:LineChart/attribute:margin/property:right", 1],
    ["literal-spacing\0left: -18\0jsx:LineChart/attribute:margin/property:left", 1]
  ])]
]);

const spacing = new Set(["0", "0.5", "1", "1.5", "2", "2.5", "3", "3.5", "4", "4.5", "5", "6", "7", "8", "10", "12", "16"]);
const approvedCss = new Set(["src/styles.css", "src/styles/theme.css", "src/styles/base.css", "src/styles/exceptions.css"]);
const entryImports = new Set(["tailwindcss", "./styles/theme.css", "./styles/base.css", "./styles/exceptions.css"]);
// CAD browser harnesses and codec golden data are test-only, with exact suffixes.
// The same classification below forbids production imports of these files.
const testPath = /(?:^|\/)(?:test|tests|__tests__|e2e)(?:\/|$)|\.(?:test|spec)\.[^.]+$|(?:\.smoke\.ts|-smoke\.tsx|\.golden\.ts)$/;
const nativeFormElements = new Set(["input", "select", "textarea", "button"]);
const reviewedUtilities = new Map([
  ["pb-shell-navigation-safe", "padding-bottom: calc(var(--spacing) * 17 + env(safe-area-inset-bottom));"],
  ["h-shell-navigation-safe", "height: calc(var(--spacing) * 17 + env(safe-area-inset-bottom));"],
  ["pb-safe-area-bottom", "padding-bottom: env(safe-area-inset-bottom);"]
]);
// These preserve the inclusive boundaries of the reviewed landing CSS. They
// are exact contracts, not permission for arbitrary custom media variants.
const approvedLandingVariants = new Map([
  ["landing-narrow", "(@media(max-width:430px))"],
  ["landing-stack", "(@media(max-width:720px))"],
  ["landing-wide", "(@media(max-width:1050px))"]
]);
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

function staticString(node) {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
    || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const expression = staticString(span.expression);
      if (expression === undefined) return undefined;
      value += expression + span.literal.text;
    }
    return value;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(node.left);
    const right = staticString(node.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
}

function queryFingerprints(source, path) {
  // TypeScript is already the app's compiler dependency. Its existing parser
  // preserves nested/template selector arguments without a second parser package.
  const file = parseScript(source, path);
  const printer = ts.createPrinter({ removeComments: true });
  const calls = [];
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const method = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : ts.isElementAccessExpression(node.expression) && node.expression.argumentExpression
          ? staticString(node.expression.argumentExpression)
          : undefined;
      if (/^(?:querySelector|querySelectorAll)$/.test(method ?? "")) {
        calls.push({ index: node.expression.getStart(file), match: printer.printNode(ts.EmitHint.Expression, node, file) });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return calls;
}

function moduleSpecifiers(source, path) {
  const file = parseScript(source, path);
  const specifiers = [];
  function visit(node) {
    let literal;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) literal = node.moduleSpecifier;
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) literal = node.arguments[0];
    if (literal && (ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal))) {
      specifiers.push({ specifier: literal.text, index: literal.getStart(file) });
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return specifiers;
}

function barePackageRequest(specifier) {
  const resource = specifier.split(/[?#]/, 1)[0];
  if (!resource || resource.startsWith(".") || resource.startsWith("/") || resource.startsWith("#") || resource.startsWith("node:")) return null;
  const segments = resource.split("/");
  const scoped = resource.startsWith("@");
  if (scoped && segments.length < 2) return null;
  const packageName = scoped ? segments.slice(0, 2).join("/") : segments[0];
  const remainder = segments.slice(scoped ? 2 : 1).join("/");
  return { packageName, exportKey: remainder ? `./${remainder}` : "." };
}

function cssExportTarget(target) {
  if (typeof target === "string") return target.split(/[?#]/, 1)[0].endsWith(".css");
  if (Array.isArray(target)) return target.some(cssExportTarget);
  return target !== null && typeof target === "object" && Object.values(target).some(cssExportTarget);
}

function exportedPackageTarget(exports, exportKey) {
  if (exportKey === "." && (typeof exports === "string" || Array.isArray(exports))) return exports;
  if (!exports || typeof exports !== "object") return undefined;
  const keys = Object.keys(exports);
  if (!keys.some(key => key.startsWith("."))) return exportKey === "." ? exports : undefined;
  if (Object.hasOwn(exports, exportKey)) return exports[exportKey];
  const patterns = keys.filter(key => {
    const star = key.indexOf("*");
    if (star < 0) return false;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    return exportKey.startsWith(prefix) && exportKey.endsWith(suffix);
  });
  // Match Node's exports pattern precedence: the longest base before `*`
  // wins, then the longest complete pattern (the more specific suffix).
  patterns.sort((left, right) => {
    const leftBaseLength = left.indexOf("*") + 1;
    const rightBaseLength = right.indexOf("*") + 1;
    return rightBaseLength - leftBaseLength || right.length - left.length;
  });
  if (patterns.length) return exports[patterns[0]];
}

async function packageRequestExportsCss(root, specifier, manifestCache) {
  const request = barePackageRequest(specifier);
  if (!request) return false;
  let manifest = manifestCache.get(request.packageName);
  if (manifest === undefined) {
    let directory = resolve(root);
    manifest = null;
    while (true) {
      try {
        manifest = JSON.parse(await readFile(resolve(directory, "node_modules", request.packageName, "package.json"), "utf8"));
        break;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    manifestCache.set(request.packageName, manifest);
  }
  if (!manifest) return false;
  if (request.exportKey === "." && [manifest.style, manifest.main, manifest.module].some(cssExportTarget)) return true;
  return cssExportTarget(exportedPackageTarget(manifest.exports, request.exportKey));
}

function exceptionAnchor(source, path, index) {
  if (path.endsWith(".css")) return "";
  const file = parseScript(source, path);
  let property;
  function visit(node) {
    if (node.getStart(file) <= index && index < node.end) {
      if (ts.isPropertyAssignment(node)) property = node;
      ts.forEachChild(node, visit);
    }
  }
  visit(file);
  if (!property) return "";
  const propertyName = property.name.getText(file).replace(/^['"]|['"]$/g, "");
  const object = property.parent;
  if (ts.isObjectLiteralExpression(object) && ts.isVariableDeclaration(object.parent)) {
    return `variable:${object.parent.name.getText(file)}/property:${propertyName}`;
  }
  if (ts.isObjectLiteralExpression(object) && ts.isJsxExpression(object.parent) && ts.isJsxAttribute(object.parent.parent)) {
    const attribute = object.parent.parent;
    const opening = attribute.parent?.parent;
    if (opening && (ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening))) {
      return `jsx:${opening.tagName.getText(file)}/attribute:${attribute.name.getText(file)}/property:${propertyName}`;
    }
  }
  return "";
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
  if (!path.endsWith(".css")) {
    for (const { specifier, index } of moduleSpecifiers(text, path)) {
      if ((specifier.startsWith(".") || specifier.startsWith("/"))) {
        const resource = specifier.split(/[?#]/, 1)[0];
        const target = resolve("/", dirname(path), resource).slice(1).replaceAll("\\", "/");
        if (testPath.test(target) || /(?:\.(?:test|spec|smoke|golden)|-smoke)$/.test(target)) add("test-import", specifier, index);
      }
      if (specifier === "tailwindcss" || specifier.startsWith("tailwindcss/")) add("css-import", specifier, index);
    }
  }
  // Responsive candidates in scripts live inside strings/template segments.
  // A CVA size map's sm:/md:/lg: keys (or TypeScript property signatures) are
  // syntax, not utilities. CSS @apply candidates still use the CSS source.
  const responsiveRanges = path.endsWith(".css") ? null : scriptLiteralRanges(text, path);
  scan(/(?<![\w-])(?:(?:max-|min-)\[[^\]\n]+\]|(?:max-|min-)?(?:sm|md|lg|xl|2xl|phone-wide|compact|tablet)|landing-[\w-]+):/g, m => {
    if (responsiveRanges && !responsiveRanges.some(([start, end]) => m.index >= start && m.index + m[0].length <= end)) return;
    const name = m[0].replace(/^(?:max-|min-)/, "").slice(0, -1);
    if (!approvedLandingVariants.has(name) && !themeTokens.has(`--breakpoint-${name}`)) add("unapproved-breakpoint", m[0], m.index);
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
    add("arbitrary-theme-utility", m[0], m.index);
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
  const queries = path.endsWith(".css") ? [] : queryFingerprints(text, path);
  for (const query of queries) add("query-selector", query.match, query.index);
  // Malformed snippets still fail closed even when the parser cannot construct a call.
  scan(/\b(?:querySelector|querySelectorAll)\s*(?:\?\.\s*)?(?:<[^;\n]+?>\s*)?\(/g, m => {
    if (!queries.some(query => query.index <= m.index && m.index < query.index + query.match.length)) {
      add("query-selector", text.slice(m.index).split("\n")[0], m.index);
    }
  });
  scan(/(?:@import\s+(?:url\(\s*)?|\bimport\s*(?:\(\s*)?|\bfrom\s*)["']([^"']+)["']/g, m => {
    if (!m[1].split(/[?#]/, 1)[0].endsWith(".css") && !m[0].startsWith("@import")) return;
    const allowed = path === "src/styles.css" && entryImports.has(m[1])
      || (path === "src/main.tsx" || path === "src/App.tsx") && m[1] === "./styles.css";
    if (!allowed) add("css-import", m[1], m.index);
  });
  scan(/@import\s+url\(\s*([^\s"')]+)\s*\)/g, m => {
    if (!(path === "src/styles.css" && entryImports.has(m[1]))) add("css-import", m[1], m.index);
  });
  if (path === "src/styles.css") {
    scan(/@import\s+(["'])([^"']+)\1([^;]*);/g, m => {
      if (entryImports.has(m[2]) && m[3].trim()) add("css-import", m[2], m.index);
    });
  }
  if (!path.startsWith("src/components/ui/") && !path.endsWith(".css")) {
    const file = parseScript(text, path);
    const printer = ts.createPrinter({ removeComments: true });
    const reactNamespaces = new Set(["React"]);
    const reactCreateElements = new Set();
    const sharedFormFields = new Set();
    for (const statement of file.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const clause = statement.importClause;
      if (statement.moduleSpecifier.text === "react" && clause) {
        if (clause.name) reactNamespaces.add(clause.name.text);
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) reactNamespaces.add(clause.namedBindings.name.text);
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) {
            if ((element.propertyName?.text ?? element.name.text) === "createElement") reactCreateElements.add(element.name.text);
          }
        }
      }
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings) && statement.moduleSpecifier.text.startsWith(".")) {
        const target = resolve("/", dirname(path), statement.moduleSpecifier.text).slice(1).replaceAll("\\", "/");
        if (target === "src/components/ui" || target.startsWith("src/components/ui/")) {
          for (const element of clause.namedBindings.elements) {
            if ((element.propertyName?.text ?? element.name.text) === "FormField") sharedFormFields.add(element.name.text);
          }
        }
      }
    }
    const propertyName = name => ts.isComputedPropertyName(name) ? staticString(name.expression)
      : ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : undefined;
    function visitFormElements(node) {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(file);
        const directStyle = node.attributes.properties.some(attribute =>
          ts.isJsxAttribute(attribute) && /^(?:className|style)$/.test(attribute.name.text)
        );
        const spreadStyle = node.attributes.properties.some(ts.isJsxSpreadAttribute);
        let sharedFieldOwner = false;
        for (let parent = node.parent; parent; parent = parent.parent) {
          if (ts.isJsxElement(parent) && sharedFormFields.has(parent.openingElement.tagName.getText(file))) {
            sharedFieldOwner = true;
            break;
          }
        }
        if (nativeFormElements.has(tag) && (directStyle || spreadStyle && !sharedFieldOwner)) {
          add("raw-form-style", printer.printNode(ts.EmitHint.Unspecified, node, file).replace(/\s+/g, " "), node.getStart(file));
        }
      } else if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const createElement = ts.isIdentifier(callee) && reactCreateElements.has(callee.text)
          || ts.isPropertyAccessExpression(callee) && reactNamespaces.has(callee.expression.getText(file)) && callee.name.text === "createElement"
          || ts.isElementAccessExpression(callee) && reactNamespaces.has(callee.expression.getText(file)) && staticString(callee.argumentExpression) === "createElement";
        if (!createElement) {
          ts.forEachChild(node, visitFormElements);
          return;
        }
        const tag = node.arguments[0] && staticString(node.arguments[0]);
        const props = node.arguments[1];
        if (tag && nativeFormElements.has(tag) && props && props.kind !== ts.SyntaxKind.NullKeyword) {
          const mayStyle = !ts.isObjectLiteralExpression(props) || props.properties.some(property =>
            ts.isSpreadAssignment(property) || (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
              && /^(?:className|style)$/.test(propertyName(property.name) ?? "")
          );
          if (mayStyle) add("raw-form-style", printer.printNode(ts.EmitHint.Expression, node, file), node.getStart(file));
        }
      }
      ts.forEachChild(node, visitFormElements);
    }
    visitFormElements(file);
  }
  const customVariantCounts = new Map();
  scan(/@custom-variant\b([^;{}]*)(?:;|(?=[{}])|$)/g, m => {
    const declaration = m[1].trim();
    const parts = declaration.match(/^([\w-]+)\s+(.+)$/);
    const name = parts?.[1];
    const count = (customVariantCounts.get(name) ?? 0) + 1;
    customVariantCounts.set(name, count);
    const media = parts?.[2].replace(/\s+/g, " ").replace(/\s*([():])\s*/g, "$1");
    if (path !== "src/styles.css" || count !== 1 || !m[0].endsWith(";")
      || !approvedLandingVariants.has(name) || approvedLandingVariants.get(name) !== media) {
      add("unapproved-custom-variant", m[0], m.index);
    }
  });
  const approvedUtilityStarts = new Set();
  const utilityCounts = new Map();
  scan(/@utility\s+([^\s{]+)\s*\{([^{}]*)\}/g, m => {
    const body = m[2].trim().replace(/\s+/g, " ");
    const count = (utilityCounts.get(m[1]) ?? 0) + 1;
    utilityCounts.set(m[1], count);
    if (path === "src/styles/base.css" && reviewedUtilities.get(m[1]) === body && count === 1) approvedUtilityStarts.add(m.index);
  });
  scan(/@utility\s+[^\s{]+/g, m => {
    if (!approvedUtilityStarts.has(m.index)) add("css-utility", m[0], m.index);
  });
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
  const exceptionCounts = new Map();
  return violations.sort((a, b) => a.index - b.index).filter((violation) => {
    const basicKey = `${violation.rule}\0${violation.match}`;
    const anchor = exceptionAnchor(text, path, violation.index);
    const key = anchor ? `${basicKey}\0${anchor}` : basicKey;
    const count = (exceptionCounts.get(key) ?? 0) + 1;
    exceptionCounts.set(key, count);
    return count > (reviewedRuntimeExceptions.get(path)?.get(key) ?? 0);
  }).map(({ index, ...violation }) => violation);
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

export async function inspectWorkspace({ root = webRoot, baseline = {} } = {}) {
  if (Object.keys(baseline).length > 0) throw new Error("UI policy workspace inspection requires a zero-baseline");
  const violations = [];
  const sources = new Map();
  for (const file of await sourceFiles(resolve(root, "src"))) {
    const path = relative(root, file).replaceAll("\\", "/");
    const source = await readFile(file, "utf8");
    sources.set(path, source);
    violations.push(...inspectUiSource(path, source));
  }

  const manifestCache = new Map();
  for (const [path, source] of sources) {
    if (path.endsWith(".css") || testPath.test(path)) continue;
    for (const { specifier } of moduleSpecifiers(source, path)) {
      if (await packageRequestExportsCss(root, specifier, manifestCache)
        && !violations.some(violation => violation.path === path && violation.rule === "css-import" && violation.match === specifier)) {
        violations.push({ rule: "css-import", path, match: specifier });
      }
    }
  }

  const stylesheet = sources.get("src/styles.css") ?? "";
  const stylesheetText = maskComments(stylesheet, "src/styles.css");
  const stylesheetImports = [...stylesheetText.matchAll(/@import\s+(["'])([^"']+)\1\s*;/g)].map(match => match[2]);
  for (const required of entryImports) {
    const count = stylesheetImports.filter(specifier => specifier === required).length;
    if (count === 0) violations.push({ rule: "missing-css-import", path: "src/styles.css", match: required });
    else if (count > 1) violations.push({ rule: "duplicate-css-import", path: "src/styles.css", match: required });
  }

  for (const name of approvedLandingVariants.keys()) {
    if (!new RegExp(`@custom-variant\\s+${name}(?![\\w-])`).test(stylesheetText)) {
      violations.push({ rule: "missing-custom-variant", path: "src/styles.css", match: name });
    }
  }

  const entryOwners = [];
  for (const [path, source] of sources) {
    if (!path.endsWith(".css") && !testPath.test(path)) {
      for (const { specifier } of moduleSpecifiers(source, path)) if (specifier === "./styles.css") entryOwners.push(path);
    }
  }
  if (entryOwners.length === 0) violations.push({ rule: "missing-css-entry", path: "src/styles.css", match: "./styles.css" });
  else if (entryOwners.length > 1) violations.push({ rule: "duplicate-css-entry", path: "src/styles.css", match: entryOwners.join(", ") });

  try {
    const html = await readFile(resolve(root, "index.html"), "utf8");
    const attribute = (tag, name) => {
      const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\u0060]+))`, "i"));
      return match?.[1] ?? match?.[2] ?? match?.[3];
    };
    for (const link of html.matchAll(/<link\b[^>]*>/gi)) {
      const rel = attribute(link[0], "rel");
      const href = attribute(link[0], "href");
      if (rel?.toLowerCase().split(/\s+/).includes("stylesheet") || href?.split(/[?#]/, 1)[0].endsWith(".css")) {
        violations.push({ rule: "html-css-entry", path: "index.html", match: href ?? link[0] });
      }
    }
    if (/<style\b/i.test(html)) violations.push({ rule: "html-css-entry", path: "index.html", match: "<style>" });
    for (const script of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) {
      const target = script[1].split(/[?#]/, 1)[0].replace(/^\//, "");
      if (testPath.test(target)) violations.push({ rule: "test-import", path: "index.html", match: script[1] });
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  try {
    for (const file of await sourceFiles(resolve(root, "public"))) {
      const path = relative(root, file).replaceAll("\\", "/");
      if (path.endsWith(".css")) violations.push({ rule: "public-css", path, match: path });
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return { count: violations.length, violations };
}

async function check(root) {
  const baseline = JSON.parse(await readFile(resolve(root, "scripts/ui-policy-baseline.json"), "utf8"));
  if (baseline.version !== 1 || !baseline.files) throw new Error("Unsupported UI policy baseline");
  const actualRef = execFileSync("git", ["rev-parse", "--verify", `${approvedSourceRef}^{commit}`], { cwd: webRoot, encoding: "utf8" }).trim();
  if (baseline.sourceRef !== approvedSourceRef || actualRef !== approvedSourceRef) throw new Error("UI baseline sourceRef is not the reviewed Git commit");
  if (Object.keys(baseline.files).length > 0) throw new Error("UI policy baseline violation map must be empty");
  const result = await inspectWorkspace({ root, baseline: baseline.files });
  for (const v of result.violations) console.error(`${v.path}: ${v.rule}: ${v.match}`);
  console.log(`UI policy: ${result.count} existing violations; ${result.violations.length} new/increased violations.`);
  process.exitCode = result.violations.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--root")) throw new Error("Usage: ui-policy.mjs [--root WEB_ROOT]");
  await check(args[1] ? resolve(args[1]) : resolve(dirname(fileURLToPath(import.meta.url)), ".."));
}
