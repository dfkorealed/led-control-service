import { createServer } from "node:http";
import { test as base, expect, type BrowserContext, type Page, type Route } from "@playwright/test";
import { build } from "vite";
import { installMockApiBoundary } from "./mock-api-boundary";
import { installSettingsApiRoutes } from "./settings-api";
import { runFoundationLifetime } from "../../src/test/design-memory-lifetime";

export type DesignScenario = {
  principal: "admin" | "viewer" | "operator" | "anonymous";
  state: "ready" | "pending" | "paused" | "empty" | "error";
  theme?: "light" | "dark";
};

type RouteHandler = (route: Route) => Promise<void>;

// The existing boundary owns the fallback behavior. Capture only its route so
// the memory fixture can remove its own boundary without touching page mocks.
async function scopedBoundary(context: BrowserContext, origin: string, sentinels: string[]) {
  const handlers: RouteHandler[] = [];
  await installMockApiBoundary({ route: async (_pattern: string, handler: RouteHandler) => {
    const observed: RouteHandler = async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === origin && url.pathname.startsWith("/api/")) sentinels.push(`API ${request.method()} ${url.pathname}`);
      if (url.origin !== origin && !["GET", "HEAD", "OPTIONS"].includes(request.method())) sentinels.push(`EXTERNAL ${request.method()} ${url.href}`);
      await handler(route);
    };
    handlers.push(observed);
    await context.route("**/*", observed);
  } } as unknown as BrowserContext, origin);
  return async () => { for (const handler of handlers) await context.unroute("**/*", handler); };
}

async function denyLiveChannels(context: BrowserContext, sentinels: string[], allowDevHmr = true) {
    await context.exposeBinding("__designBoundaryBlocked", (_source, kind: string) => { sentinels.push(kind); });
    await context.addInitScript(({ allowDevHmr }) => {
      const report = (kind: string) => { void (window as unknown as { __designBoundaryBlocked(kind: string): Promise<void> }).__designBoundaryBlocked(kind); };
      // Vite's same-origin HMR handshake is also denied, but is expected runner
      // infrastructure rather than an attempted product live channel.
      window.WebSocket = class { constructor(url: string | URL, protocols?: string | string[]) {
        const target = new URL(url, location.href);
        // Match Vite's actual dev handshake, not every same-host product
        // socket. The handshake remains denied before any transport opens.
        const hmr = allowDevHmr && target.host === location.host
          && target.protocol === (location.protocol === "https:" ? "wss:" : "ws:")
          && target.pathname === "/" && protocols === "vite-hmr"
          && [...target.searchParams.keys()].join(",") === "token" && Boolean(target.searchParams.get("token"));
        if (!hmr) report("WebSocket");
        throw new Error("Design fixture blocks WebSocket");
      } } as unknown as typeof WebSocket;
      navigator.sendBeacon = () => { report("sendBeacon"); return false; };
    }, { allowDevHmr });
}

// Production memory fixtures have no HMR channel. Every attempted socket is
// observable, including same-origin ones, and cleanup checks attempts on failure.
export async function installDesignMemoryBoundary(context: BrowserContext, origin: string) {
  const sentinels: string[] = [];
  const remove = await scopedBoundary(context, origin, sentinels);
  await denyLiveChannels(context, sentinels, false);
  return async () => {
    await remove();
    expect(sentinels, "Memory fixture attempted an unconfigured API or external write").toEqual([]);
  };
}

export const test = base.extend<{ designScenario: (scenario: DesignScenario) => Promise<void>; _designBoundary: void }>({
  _designBoundary: [async ({ browser, context, baseURL }, use, info) => {
    const sentinels: string[] = [];
    const close = await scopedBoundary(context, baseURL!, sentinels);
    await denyLiveChannels(context, sentinels);
    const contexts: Array<{ context: BrowserContext; close(): Promise<void> }> = [];
    const newContext = browser.newContext.bind(browser);
    // Some existing responsive journeys create their own touch context. Own
    // the same boundary before those contexts can create a page or request.
    browser.newContext = async options => {
      const owned = await newContext({ ...options, serviceWorkers: "block" });
      const removeBoundary = await scopedBoundary(owned, baseURL!, sentinels);
      await denyLiveChannels(owned, sentinels);
      contexts.push({ context: owned, close: removeBoundary });
      return owned;
    };
    try { await use(); } finally {
      browser.newContext = newContext;
      for (const owned of contexts) {
        if (browser.contexts().includes(owned.context)) { await owned.close(); await owned.context.close(); }
      }
      await close();
      const expected = info.annotations.find(annotation => annotation.type === "boundary-sentinels");
      expect(sentinels.slice().sort(), "Unexpected unconfigured API or external write").toEqual(expected ? (JSON.parse(expected.description!) as string[]).sort() : []);
    }
  }, { auto: true }],
  designScenario: async ({ page }, use) => {
    let installed = false;
    let release: (() => void) | undefined;
    await use(async scenario => {
      if (scenario.theme && !["light", "dark"].includes(scenario.theme)) throw new Error("Unsupported design theme");
      if (scenario.theme && ["operator", "anonymous"].includes(scenario.principal)) throw new Error("Customer themes require a customer principal");
      if (installed) throw new Error("Use a fresh page for each design scenario");
      installed = true;
      if (scenario.theme) await page.addInitScript(theme => localStorage.setItem("led-control.customer-theme.v1", theme), scenario.theme);
      await installSettingsApiRoutes(page, scenario.principal === "anonymous" ? "viewer" : scenario.principal,
        scenario.state === "empty" ? { fixtures: [], includeFloor: false, includeGateway: false } : { readyMapDocument: true });
      if (scenario.principal === "anonymous") await page.route("**/api/auth/me", route => route.fulfill({ status: 401, json: { message: "unauthorized" } }));
      if (scenario.state === "error") await page.route("**/api/auth/me", route => route.fulfill({ status: 503, json: { message: "fixture unavailable" } }));
      if (scenario.state === "pending") {
        const pending = new Promise<void>(resolve => { release = resolve; });
        await page.route("**/api/auth/me", async route => { await pending; await route.fulfill({ status: 503, json: { message: "fixture released" } }).catch(() => {}); });
      }
      if (scenario.state === "paused") await page.addInitScript(() => { Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false }); });
    });
    release?.();
  }
});
export { expect };

const foundationSource = `
import React from "react";
import {createRoot} from "react-dom/client";
import {Plus} from "lucide-react";
import {PageStack,CardGrid,Card,SidePanel,PageHeader,Button,IconButton,IconTooltipButton} from "/src/components/ui/index.ts";
import "/src/styles.css";
const el=React.createElement;
window.foundationClicks=0;
createRoot(document.getElementById("root")).render(el(PageStack,{"data-testid":"page-stack"},
 el(PageHeader,{title:"페이지",titleRole:"page",headingLevel:1}),
 el(PageHeader,{title:"구역",titleRole:"section",headingLevel:3}),
 el(PageHeader,{title:"작은 카드",titleRole:"card",headingLevel:4}),
 el(CardGrid,{"data-testid":"card-grid"},
  el(Card,{padding:"regular","data-testid":"regular-panel"},"일반"),
  el(Card,{padding:"customer","data-testid":"customer-panel"},"고객"),
  el(Card,{padding:"compact","data-testid":"compact-panel"},"압축"),
  el(Card,{"data-testid":"none-panel"},"없음")),
 el(SidePanel,{padding:"regular","data-testid":"side-panel"},"패널"),
 ...["sm","md","lg"].map(size=>el(Button,{key:size,size,"aria-label":size==="sm"?"확인":size,className:"justify-self-start",onClick:()=>window.foundationClicks++},"+")),
 el(Button,{className:"min-w-16 min-h-13"},"큰 버튼"),
 el(IconButton,{"aria-label":"아이콘",className:"justify-self-start"},"+"),
 el(IconTooltipButton,{label:"큰 아이콘",icon:Plus}),
 el(Button,{variant:"landingMapMarker","aria-label":"브랜드 점"},"")));
`;

export async function mountFoundationFixture(page: Page): Promise<{ close(): Promise<void> }> {
  const entry = "virtual:design-system-foundation";
  const result = await build({ logLevel: "silent", build: { write: false, rollupOptions: { input: entry } }, plugins: [{
    name: "design-system-foundation", enforce: "pre",
    resolveId(id) { if (id === entry) return `\0${entry}`; },
    load(id) { if (id === `\0${entry}`) return foundationSource; }
  }] });
  if (Array.isArray(result) || !("output" in result)) throw new Error("Expected memory production build");
  const assets = new Map(result.output.map(asset => [asset.fileName, asset.type === "asset" ? asset.source : asset.code]));
  const script = result.output.find(asset => asset.type === "chunk" && asset.isEntry);
  if (!script) throw new Error("Missing memory fixture entry");
  const styles = result.output.filter(asset => asset.fileName.endsWith(".css")).map(asset => `<link rel="stylesheet" href="/${asset.fileName}">`).join("");
  const html = `<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width,initial-scale=1">${styles}</head><body><div id="root"></div><script type="module" src="/${script.fileName}"></script></body></html>`;
  const server = createServer((request, response) => {
    const name = request.url?.slice(1) ?? "";
    response.setHeader("Content-Type", name.endsWith(".css") ? "text/css" : name.endsWith(".js") ? "application/javascript" : "text/html");
    response.end(assets.get(name) ?? html);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing memory fixture address");
  const sentinels: string[] = [];
  const removeBoundary = await scopedBoundary(page.context(), `http://127.0.0.1:${address.port}`, sentinels);
  const close = async () => {
    await removeBoundary();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    expect(sentinels, "Memory fixture attempted an unconfigured API or external write").toEqual([]);
  };
  try {
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.getByTestId("page-stack").waitFor();
    return { close };
  } catch (error) { await close(); throw error; }
}

// Both foundation consumers own the same page + memory HTTP lifetime. Close
// the page first so server.close cannot wait on its live connection. Attempt
// both cleanups even on assertion failure and retain every original error.
export async function withFoundationFixture(page: Page, run: () => Promise<void>) {
  const fixture = await mountFoundationFixture(page);
  await runFoundationLifetime(run, () => page.close(), () => fixture.close());
}
