import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const spacing = new Set(["0", "0.5", "1", "1.5", "2", "2.5", "3", "3.5", "4", "4.5", "5", "6", "7", "8", "10", "12", "16"]);
const approvedCss = new Set(["src/styles.css", "src/styles/theme.css", "src/styles/base.css", "src/styles/exceptions.css"]);
const entryImports = new Set(["tailwindcss", "./styles/theme.css", "./styles/base.css", "./styles/exceptions.css"]);
const testPath = /(?:^|\/)(?:test|tests|__tests__|e2e)(?:\/|$)|\.(?:test|spec)\.[^.]+$/;
const colorLiteral = /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lch|lab|color)\([^;{}]*?\)/gi;
const namedColors = new Set(("aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen").split(" "));

/** A lexical migration guard, not a CSS/JS type checker. Exact debt matches keep
 * a removed legacy violation from silently authorizing a different new one. */
export function inspectUiSource(path, source) {
  path = path.replaceAll("\\", "/").replace(/^.*\/apps\/web\//, "");
  if (testPath.test(path)) return [];
  const violations = [];
  const add = (rule, match, index = 0) => violations.push({ rule, path, match, index });
  let text = source.replace(/\/\*[\s\S]*?\*\//g, value => " ".repeat(value.length))
    .replace(/^\s*\/\/[^\n]*/gm, value => " ".repeat(value.length));
  // Only declarations inside the canonical @theme block own raw palette and
  // typed scale values. Ordinary rules in this file still pass through policy.
  if (path === "src/styles/theme.css") {
    text = text.replace(/@theme(?:\s+static)?\s*\{[^{}]*\}/g, block => block.replace(
      /--(?:color-(?:(?:brand|surface|content|border|action|status|chart|fixture)-[\w-]+|\*)|text-[\w*-]+|radius-[\w*-]+|shadow-[\w*-]+|breakpoint-[\w*-]+|spacing)\s*:[^;]+;/g,
      value => " ".repeat(value.length)
    ));
  }
  const scan = (regex, callback) => { for (const match of text.matchAll(regex)) callback(match); };
  const spacePrefix = "(?:p[trblxyse]?|m[trblxyse]?|gap(?:-[xy])?|space-[xy]|inset(?:-[xy])?|top|right|bottom|left|start|end|scroll-[pm][trblxyse]?)";
  scan(new RegExp(`(?<![\\w-])-?${spacePrefix}-(?:\\[[^\\]\\n]+\\]|\\([^\\)\\n]+\\))`, "g"), m => add("arbitrary-spacing", m[0], m.index));
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
  scan(/(?<![\w-])(?:bg|text|border|ring|outline|fill|stroke|decoration|accent|caret|from|via|to)-(?:[a-z]+-\d{2,3}|black|white)(?![\w-])/g, m => add("unapproved-color", m[0], m.index));
  scan(/\b(?:querySelector|querySelectorAll)\s*(?:<[^;\n]+?>\s*)?\(/g, m => add("query-selector", m[0], m.index));
  scan(/(?:@import\s+(?:url\(\s*)?|\bimport\s*(?:\(\s*)?|\bfrom\s*)["']([^"']+)["']/g, m => {
    if (!m[1].endsWith(".css") && !m[0].startsWith("@import")) return;
    const allowed = path === "src/styles.css" && entryImports.has(m[1]) || path === "src/main.tsx" && m[1] === "./styles.css";
    if (!allowed) add("css-import", m[1], m.index);
  });
  scan(/@import\s+url\(\s*([^\s"')]+)\s*\)/g, m => {
    if (!(path === "src/styles.css" && entryImports.has(m[1]))) add("css-import", m[1], m.index);
  });
  if (!path.startsWith("src/components/ui/")) {
    scan(/<(?:input|select|textarea|button)\b[^>]*?\b(?:className|style)\s*=/g, m => add("raw-form-style", m[0].replace(/\s+/g, " "), m.index));
  }
  scan(/\b(padding(?:-[\w]+|[A-Z]\w*)?|margin(?:-[\w]+|[A-Z]\w*)?|gap|row-gap|column-gap|rowGap|columnGap|top|right|bottom|left|inset)\s*:\s*([^;,\n}]+)/g, m => {
    const value = m[2].split(/,(?![^()]*\))/)[0];
    if (/(?:\d*\.)?\d+(?:px|rem)\b/.test(value) || /^\s*["']?-?(?!0(?:\s|["']|$))\d+(?:\.\d+)?\s*(?:["']|$)/.test(value)) {
      // Percentage, viewport and runtime calc()/var() geometry are separately
      // reviewed exceptions; they do not authorize literal static spacing.
      if (!/^(?:calc|clamp|var)\(/.test(value.trim())) add("literal-spacing", `${m[1]}: ${value.trim()}`, m.index);
    }
  });
  scan(/\b(font-size|fontSize|line-height|lineHeight|letter-spacing|letterSpacing)\s*:\s*([^;,\n}]+)/g, m => {
    const value = m[2].split(/,(?![^()]*\))/)[0].trim();
    if (/^['"]?-?(?:\d|\.\d)/.test(value) && !/^['"]?0['"]?$/.test(value)) add("literal-typography", `${m[1]}: ${value}`, m.index);
  });
  scan(/\b(?:color|background(?:-color|Color)?|border(?:-[\w]+|[A-Z]\w*)?|fill|stroke|outline(?:-color|Color)?)\s*[:=]\s*["']?([^;\n}"']+)/g, m => {
    for (const word of m[1].matchAll(/\b[a-z]+\b/gi)) if (namedColors.has(word[0].toLowerCase())) add("raw-color", word[0], m.index + word.index);
  });
  if (path.endsWith(".css")) {
    if (!approvedCss.has(path)) add("css-file", path);
    scan(/(?:^|[{};])\s*([^{};]+)\{/g, m => {
      const selector = m[1].trim().replace(/\s+/g, " ");
      if (selector.startsWith("@")) return;
      const baseAllowed = path === "src/styles/base.css" && ["html", "body", "button, input, select, textarea", ":focus-visible"].includes(selector);
      if (!baseAllowed) add("css-selector", selector, m.index);
      if (/(?:^|[\s,>+~])(?:input|select|textarea|button)(?=[\s.#[:>+~,]|$)/.test(selector) && !baseAllowed) add("raw-form-style", selector, m.index);
    });
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
