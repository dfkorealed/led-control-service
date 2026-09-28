import ts from "typescript";

// These are the reviewed JSX ownership paths of the two incidental roles. This
// complements DOM checks; React delegates handlers without DOM on* attributes.
export function landingDecorationSourceIssues(sources: Record<string, string>): string[] {
  const issues: string[] = [];
  const inspect = (path: string, choose: (node: ts.JsxElement | ts.JsxSelfClosingElement) => boolean, descendants = false) => {
    const text = sources[path];
    if (!text) { issues.push(`${path}: missing source`); return; }
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const owners: (ts.JsxElement | ts.JsxSelfClosingElement)[] = [];
    const visit = (node: ts.Node) => {
      if ((ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) && choose(node)) owners.push(node);
      ts.forEachChild(node, visit);
    };
    visit(file);
    if (!owners.length) { issues.push(`${path}: missing owned JSX`); return; }
    const checked = new Set<ts.Node>();
    const check = (node: ts.Node) => {
      if (checked.has(node)) return;
      checked.add(node);
      if (!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) return;
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      for (const attr of opening.attributes.properties) {
        // Card's reviewed rest forwarding is handled separately below. The exact
        // DemoCard call passes only variant/className/aria-label, never a spread.
        const cardForward = path === "components/ui/Card.tsx" && opening.tagName.getText(file) === "section" &&
          ts.isJsxSpreadAttribute(attr) && attr.expression.getText(file) === "props";
        // Existing custom component callback flows only into Hero/closing inquiry
        // buttons, not a native owned ancestor. All actual React event props block.
        const inquiryCallback = opening.tagName.getText(file) === "LandingStory" && ts.isJsxAttribute(attr) &&
          attr.name.getText(file) === "onInquiry" && attr.initializer?.getText(file) === "{onInquiry}" &&
          ["features/landing/LandingPage.tsx", "features/landing/FieldDayConceptPage.tsx"].includes(path);
        if (ts.isJsxSpreadAttribute(attr) ? !cardForward : /^on[A-Z]/.test(attr.name.getText(file)) && !inquiryCallback) {
          issues.push(`${path}: ${opening.tagName.getText(file)} ${attr.getText(file)}`);
        }
      }
    };
    for (const owner of owners) {
      for (let node: ts.Node | undefined = owner; node; node = node.parent) check(node);
      if (descendants) {
        const walk = (node: ts.Node) => { check(node); ts.forEachChild(node, walk); };
        walk(owner);
      }
    }
    if (path === "components/ui/Card.tsx") {
      // Pin the existing direct rest-prop flow, so a newly constructed handler
      // object cannot hide behind the one existing common-component spread.
      const functions: ts.FunctionExpression[] = [];
      const find = (node: ts.Node) => { if (ts.isFunctionExpression(node) && node.name?.text === "Card") functions.push(node); ts.forEachChild(node, find); };
      find(file);
      const fn = functions[0];
      if (functions.length !== 1 || fn.parameters[0].getText(file) !== '{ tone = "default", variant = tone, className, children, ...props }' ||
        fn.body.statements.length !== 1 || fn.body.statements[0].getText(file) !==
        'return <section {...props} ref={ref} data-variant={variant} className={cn(card({ variant }), className)}>{children}</section>;') {
        issues.push(`${path}: changed owned rest-prop flow`);
      }
    }
  };
  const opening = (node: ts.JsxElement | ts.JsxSelfClosingElement) => ts.isJsxElement(node) ? node.openingElement : node;
  const tag = (names: string[]) => (node: ts.JsxElement | ts.JsxSelfClosingElement) => names.includes(opening(node).tagName.getText());
  const classToken = (token: string) => (node: ts.JsxElement | ts.JsxSelfClosingElement) => opening(node).attributes.properties.some(attr =>
    ts.isJsxAttribute(attr) && attr.name.getText() === "className" && !!attr.initializer &&
    new RegExp(`(?:[\\s\"\x60]|^)${token}(?:[\\s\"\x60]|$)`).test(attr.initializer.getText()));
  inspect("features/landing/field-day/ControlDemo.tsx", classToken("control-visual"), true);
  inspect("features/landing/field-day/Scene.tsx", classToken("scene-watermark"));
  inspect("features/landing/field-day/Scene.tsx", tag(["ConceptPresentation.Provider", "Card"]));
  inspect("features/landing/LandingPage.tsx", tag(["Scene", "ControlDemo", "PublicSiteLayout", "LandingStory"]));
  inspect("features/landing/FieldDayConceptPage.tsx", tag(["PublicSiteLayout", "LandingStory"]));
  inspect("features/landing/PublicSiteLayout.tsx", classToken("field-day"));
  inspect("components/ui/Card.tsx", tag(["section"]));
  return issues;
}
