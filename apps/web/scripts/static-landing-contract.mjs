export const publicRoutes = Object.freeze(["/", "/features", "/pricing"]);
export const landingPageFiles = Object.freeze({ "/": "index.html", "/features": "features.html", "/pricing": "pricing.html" });
export const landingSeoFiles = Object.freeze(["robots.txt", "sitemap.xml"]);
export const brandAssets = Object.freeze([
  "brand/favicon-32.png", "brand/kinda-mark-512.png", "brand/kinda-mark.svg",
  "brand/kinda-mark-monochrome.svg", "brand/kinda-mark-reversed.svg"
]);

const forbiddenModule = /(?:\/src\/(?:api|features\/(?:auth|control|monitoring|operator|mobile|settings|floor-editor|statistics|setup|registration|sites|shells))\/|\/src\/App(?:Root)?\.|\/src\/main\.tsx|\/concepts\/|(?:FieldDayConceptPage|ConceptSiteLayout|InquiryForm|NativeInquiryField|NativeDialog)\.|\/packages\/)/;

/** Every resolved module is checked, including tree-shaken and dynamic imports. */
export function assertLandingModules(ids, webRoot, entry = "src/landing-main.tsx") {
  const root = webRoot.replaceAll("\\", "/");
  const localModules = [];
  for (const raw of ids) {
    const id = raw.replaceAll("\\", "/").split("?")[0];
    if (forbiddenModule.test(id)) throw new Error(`Forbidden landing module: ${id}`);
    if (!id.startsWith(`${root}/src/`)) continue;
    const relative = id.slice(root.length + 1);
    if (!/^src\/(?:landing-main\.tsx|styles(?:\.css|\/)|components\/(?:ui|brand)\/|features\/landing\/)/.test(relative)) {
      throw new Error(`Unapproved landing source: ${relative}`);
    }
    if (/(?:\/test\/|\.(?:test|spec)\.)/.test(relative)) throw new Error(`Test in landing graph: ${relative}`);
    localModules.push(relative);
  }
  if (!localModules.includes(entry)) throw new Error("Missing standalone landing entry");
  return [...new Set(localModules)].sort();
}

export function assertLandingOutput(bundle) {
  for (const [name, output] of Object.entries(bundle)) {
    if (![...Object.values(landingPageFiles), "404.html", ...landingSeoFiles, ...brandAssets].includes(name) && !/^assets\/[\w.-]+-[\w-]+\.(?:js|css)$/.test(name)) {
      throw new Error(`Unapproved landing artifact: ${name}`);
    }
    if (output.type === "chunk") {
      const decoded = output.code.replace(/\\u([a-f0-9]{4})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
      for (const marker of ["현장의 하루 · 킨다 랜딩 시안", "이 페이지는 디자인 방향을 검토하기 위한 시안입니다.", "킨다 시안 맨 위로"]) {
        if (decoded.includes(marker)) throw new Error(`Internal concept code in landing artifact: ${name}`);
      }
    }
    if (output.type === "chunk" && /(?:\/api\/|AppRoot|landing\/inquiries|NativeInquiryField)/.test(output.code)) {
      throw new Error(`Internal code in landing artifact: ${name}`);
    }
  }
  for (const name of ["index.html", "404.html"]) {
    if (!bundle[name]) throw new Error(`Missing landing artifact: ${name}`);
  }
}
