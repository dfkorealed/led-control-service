/**
 * JSDOM cannot parse cascade layers. Compatibility rules in styles.css are
 * indented inside top-level components blocks, so remove only those wrappers
 * and unsupported imports for legacy DOM/color/layout tests. Preserve nested
 * media rules. This does not emulate cascade priorities: ui-cascade.test.ts
 * verifies the untouched production CSS in real Chromium instead.
 */
export function prepareLegacyStylesheetForJsdom(source: string): string {
  return source
    .replace(/@import\s+[^;]+;/g, "")
    .replace(/@layer components \{\n([\s\S]*?)^\}/gm, "$1");
}
