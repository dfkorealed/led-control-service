import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { expect, test } from "@playwright/test";

const require = createRequire(import.meta.url);
const fixture = String.raw`
import React,{useState,useRef} from "react";
import {createRoot} from "react-dom/client";
import {ModalDialog,ConfirmDialog,DropdownMenu,Popover,Button} from "/src/components/ui/index.ts";
import {ConfirmDialog as LegacyConfirm,useDialogFocus} from "/src/components/ConfirmDialog.tsx";
import "/src/styles.css";
import "/src/features/settings/users/SiteUsersView.css";
const el=React.createElement;
window.overlayEvents=[]; window.overlayRoots={};
const record=(...value)=>window.overlayEvents.push(value);
function App(){
 const [open,setOpen]=useState(false),[child,setChild]=useState(false),[pending,setPending]=useState(false),[legacy,setLegacy]=useState(false),[panel,setPanel]=useState(false),[removed,setRemoved]=useState(false),[bridge,setBridge]=useState(false);
 const initial=useRef(null),fallback=useRef(null),anchor=useRef(null);
 const [widthDialog,setWidthDialog]=useState(null);
 return el("main",{className:"flex flex-col gap-4"},
  el("h1",null,"오버레이 검증"),
  ...["default","operator","editor","custom"].map(kind=>el(Button,{key:kind,onClick:()=>setWidthDialog(kind)},"폭 "+kind)),
  widthDialog&&el(widthDialog==="operator"?LegacyConfirm:widthDialog==="editor"?ConfirmDialog:ModalDialog,{title:"폭 검증",className:widthDialog==="custom"?"site-user-dialog-wide":undefined,confirmLabel:"확인",onConfirm:()=>setWidthDialog(null),onCancel:()=>setWidthDialog(null),onClose:()=>setWidthDialog(null)},"내용"),
  !removed&&el(Button,{onClick:()=>setOpen(true)},"부모 열기"),el(Button,{ref:fallback},"안전한 복귀"),
  el(Button,{onClick:()=>{setPending(true);setChild(true);}},"대기 확인 열기"),
  el(Button,{onClick:()=>setLegacy(true)},"이전 확인 열기"),
  el(Button,{onClick:()=>setBridge(true)},"이전 폼 열기"),bridge&&el(LegacyForm,{close:()=>setBridge(false)}),
  ...["sm","md","lg"].map(size=>el(DropdownMenu,{key:size,label:"메뉴 "+size,size,items:[{id:0,label:"첫 항목",description:"숫자 키"},{id:"blocked",label:"차단 항목",isDisabled:true},{id:"0",label:"끝 항목",description:"문자 키"}],onAction:key=>record("action",key)})),
  el(DropdownMenu,{label:"비활성 메뉴",isDisabled:true,items:[{id:1,label:"선택"}],onAction:key=>record("disabled",key)}),
  el(Button,{ref:anchor,onClick:()=>setPanel(true)},"팝오버 열기"),
  el(Popover,{triggerRef:anchor,isOpen:panel,onOpenChange:setPanel,label:"상세 안내",ref:node=>{window.overlayRoots.panel=node;}},el(Button,{onClick:()=>setPanel(false)},"팝오버 닫기")),
  open&&el(ModalDialog,{title:"부모",description:"부모 설명",initialFocusRef:initial,fallbackFocusRef:fallback,onClose:()=>{record("parent-close");setOpen(false);},ref:node=>{window.overlayRoots.parent=node;}},
   el("input",{ref:initial,"aria-label":"초기 입력"}),
   el(Button,{onClick:()=>{setPending(false);setChild(true);}},"자식 열기"),
   el(Button,{onClick:()=>{setRemoved(true);setOpen(false);}},"삭제 후 닫기"),
   child&&el(ConfirmDialog,{title:"자식",description:"자식 설명",confirmLabel:"확인",onCancel:()=>{record("child-close");setChild(false);},onConfirm:()=>{record("confirm");setChild(false);}})),
  !open&&child&&el(ConfirmDialog,{title:"대기",confirmLabel:"실행",isPending:pending,onCancel:()=>{record("pending-close");setChild(false);},onConfirm:()=>record("pending-confirm")}),
  legacy&&el(LegacyConfirm,{open:true,title:"이전 확인",description:"기존 호출",confirmLabel:"삭제",destructive:true,onClose:()=>{record("legacy-close");setLegacy(false);},onConfirm:()=>{record("legacy-confirm");setLegacy(false);}})
 );
}
function LegacyForm({close}){
 const root=useRef(null),initial=useRef(null);
 useDialogFocus({open:true,dialogRef:root,initialFocusRef:initial,onClose:close});
 return el("section",{ref:root,role:"dialog","aria-label":"이전 폼",tabIndex:-1},el(Button,{ref:initial},"첫 제어"),el(Button,null,"마지막 제어"));
}
createRoot(document.getElementById("root")).render(el(App));
`;
const compile = String.raw`
import {readFileSync} from "node:fs"; import {build} from "vite";
const source=readFileSync(0,"utf8"),entry="virtual:ui-overlays-fixture";
const result=await build({logLevel:"silent",build:{write:false,rollupOptions:{input:entry}},plugins:[{name:"ui-overlays-fixture",enforce:"pre",resolveId(id){if(id===entry)return "\0"+entry;},load(id){if(id==="\0"+entry)return source;}}]});
if(Array.isArray(result)||!("output" in result))throw Error("Expected production build");
const modules=result.output.flatMap(asset=>asset.type==="chunk"?Object.keys(asset.modules):[]);
for(const name of ["DropdownMenu","Popover"])if(!modules.some(id=>id.endsWith("/components/ui/overlays/"+name+".tsx")))throw Error("Missing explicit overlay consumer: "+name);
const script=result.output.find(asset=>asset.type==="chunk"&&asset.isEntry);
const links=result.output.filter(asset=>asset.fileName.endsWith(".css")).map(asset=>'<link rel="stylesheet" href="/'+asset.fileName+'">').join("");
const html='<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Overlay contracts</title>'+links+'</head><body><div id="root"></div><script type="module" src="/'+script.fileName+'"></script></body></html>';
console.log(JSON.stringify({html,assets:result.output.map(asset=>[asset.fileName,asset.type==="asset"?String(asset.source):asset.code])}));
`;

test.describe("production overlay contracts", () => {
  let server: Server; let url: string;
  test.beforeAll(async () => {
    const built = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", compile], { input: fixture, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })) as { html: string; assets: [string, string][] };
    const assets = new Map(built.assets);
    server = createServer((request, response) => {
      const name = request.url?.slice(1) ?? "";
      response.setHeader("Content-Type", name.endsWith(".css") ? "text/css" : name.endsWith(".js") ? "application/javascript" : "text/html");
      response.end(assets.get(name) ?? built.html);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Missing fixture address");
    url = `http://127.0.0.1:${address.port}`;
  });
  test.afterAll(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  test.beforeEach(async ({ page }) => { await page.goto(url); await page.getByRole("button", { name: "부모 열기" }).waitFor(); });

  test("preserves default, compatibility and public CSS widths without narrow viewport overflow", async ({ page }) => {
    for (const [kind, width] of [["default", 512], ["operator", 480], ["editor", 440], ["custom", 610]] as const) {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.getByRole("button", { name: "폭 " + kind, exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "폭 검증" });
      expect.soft((await dialog.boundingBox())!.width, kind + " desktop width").toBe(width);
      await page.setViewportSize({ width: 320, height: 740 });
      const bounds = (await dialog.boundingBox())!;
      expect.soft(bounds.x, kind + " left containment").toBeGreaterThanOrEqual(0);
      expect.soft(bounds.x + bounds.width, kind + " right containment").toBeLessThanOrEqual(320);
      expect.soft(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.setViewportSize({ width: 1280, height: 800 });
      const desktop = (await dialog.boundingBox())!;
      expect.soft(desktop.x + desktop.width / 2, kind + " centered layout").toBe(640);
      // Beside the visible surface must remain backdrop, not an invisible
      // full-width wrapper that swallows outside dismissal.
      await page.mouse.click(desktop.x - 8, desktop.y + desktop.height / 2);
      await expect(dialog).toHaveCount(0);
    }
  });

  test("portals, contains focus and restores nested child then parent focus", async ({ page }) => {
    const opener = page.getByRole("button", { name: "부모 열기" });
    await opener.click();
    const parent = page.getByRole("dialog", { name: "부모", exact: true });
    await expect(parent).toHaveAccessibleDescription("부모 설명");
    await expect(parent).toHaveAttribute("aria-modal", "true");
    await expect(page.getByRole("textbox", { name: "초기 입력" })).toBeFocused();
    expect(await parent.evaluate(node => !document.getElementById("root")!.contains(node))).toBe(true);
    const root = await parent.elementHandle();
    const trigger = parent.getByRole("button", { name: "자식 열기" });
    await trigger.click();
    const child = page.getByRole("dialog", { name: "자식" });
    await expect(child.getByRole("button", { name: "취소" })).toBeFocused();
    await page.keyboard.press("Shift+Tab"); await expect(child.getByRole("button", { name: "닫기", exact: true })).toBeFocused();
    await page.keyboard.press("Shift+Tab"); await expect(child.getByRole("button", { name: "확인", exact: true })).toBeFocused();
    await page.keyboard.press("Tab"); await expect(child.getByRole("button", { name: "닫기", exact: true })).toBeFocused();
    for (let index = 0; index < 7; index++) {
      await page.keyboard.press(index % 2 ? "Shift+Tab" : "Tab");
      expect(await child.evaluate(node => node.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(child).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(await root!.evaluate(node => node.isConnected)).toBe(true);
    await page.keyboard.press("Shift+Tab"); await expect(parent.getByRole("textbox")).toBeFocused();
    await page.keyboard.press("Shift+Tab"); await expect(parent.getByRole("button", { name: "닫기", exact: true })).toBeFocused();
    await page.keyboard.press("Shift+Tab"); await expect(parent.getByRole("button", { name: "삭제 후 닫기" })).toBeFocused();
    await page.keyboard.press("Tab"); await expect(parent.getByRole("button", { name: "닫기", exact: true })).toBeFocused();
    for (let index = 0; index < 7; index++) {
      await page.keyboard.press("Tab");
      expect(await parent.evaluate(node => node.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(opener).toBeFocused();
    expect(await page.evaluate(() => (window as any).overlayEvents)).toEqual([["child-close"], ["parent-close"]]);
  });

  test("dismisses outside once, handles removed openers and preserves legacy adapter appearance", async ({ page }) => {
    await page.getByRole("button", { name: "부모 열기" }).click();
    await page.getByTestId("modal-backdrop").click({ position: { x: 2, y: 2 } });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).overlayEvents)).toEqual([["parent-close"]]);
    await page.getByRole("button", { name: "부모 열기" }).click();
    await page.getByRole("button", { name: "삭제 후 닫기" }).click();
    await expect(page.getByRole("button", { name: "안전한 복귀" })).toBeFocused();
    await page.getByRole("button", { name: "이전 확인 열기" }).click();
    const dialog = page.getByRole("dialog", { name: "이전 확인" });
    await expect(dialog).toHaveClass(/operator-dialog/);
    await expect(dialog).toHaveCSS("padding", "24px");
    await expect(dialog).toHaveCSS("border-radius", "14px");
    await expect(dialog.getByRole("heading")).toHaveCSS("font-size", "20px");
    await expect(dialog.locator(".operator-dialog-header .icon-button")).toHaveAccessibleName("이전 확인 닫기");
    await dialog.getByRole("button", { name: "이전 확인 닫기" }).click();
    await expect(page.getByRole("button", { name: "이전 확인 열기" })).toBeFocused();
  });

  test("locks pending Escape, outside, close, cancel and confirmation", async ({ page }) => {
    await page.getByRole("button", { name: "대기 확인 열기" }).click();
    const dialog = page.getByRole("dialog", { name: "대기" });
    for (const name of ["닫기", "취소", "처리 중"]) await expect(dialog.getByRole("button", { name, exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await page.getByTestId("modal-backdrop").click({ position: { x: 2, y: 2 } });
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => (window as any).overlayEvents)).toEqual([]);
  });

  test("supports Enter/Space, Arrow/Home/End, disabled skip and exact typed menu actions", async ({ page }) => {
    const trigger = page.getByRole("button", { name: "메뉴 md", exact: true });
    await trigger.focus(); await page.keyboard.press("Enter");
    const first = page.getByRole("menuitem", { name: "첫 항목" });
    const last = page.getByRole("menuitem", { name: "끝 항목" });
    await expect(first).toBeFocused();
    await page.keyboard.press("ArrowDown"); await expect(last).toBeFocused();
    await page.keyboard.press("Home"); await expect(first).toBeFocused();
    await page.keyboard.press("End"); await expect(last).toBeFocused();
    await page.keyboard.press("ArrowUp"); await expect(first).toBeFocused();
    await page.keyboard.press("Enter"); await expect(trigger).toBeFocused();
    await page.keyboard.press("Space"); await expect(first).toBeFocused();
    await page.keyboard.press("End"); await page.keyboard.press("Space");
    await expect(trigger).toBeFocused();
    expect(await page.evaluate(() => (window as any).overlayEvents)).toEqual([["action", 0], ["action", "0"]]);
    await trigger.press("Enter"); await page.keyboard.press("Escape"); await expect(trigger).toBeFocused();
    await trigger.click(); await page.mouse.click(2, 2);
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "비활성 메뉴" })).toBeDisabled();
  });

  test("forwards popover root and returns focus on Escape", async ({ page }) => {
    const trigger = page.getByRole("button", { name: "팝오버 열기" });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "상세 안내" });
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate(node => (window as any).overlayRoots.panel.contains(node))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
    const legacyTrigger = page.getByRole("button", { name: "이전 폼 열기" });
    await legacyTrigger.click();
    const legacy = page.getByRole("dialog", { name: "이전 폼" });
    for (const key of ["Tab", "Tab", "Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab"]) {
      await page.keyboard.press(key);
      expect(await legacy.evaluate(node => node.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(legacy).toHaveCount(0); await expect(legacyTrigger).toBeFocused();
  });

  test("keeps 44px targets, no 320px overflow and zero serious/critical axe violations", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    for (const size of ["sm", "md", "lg"]) {
      const trigger = page.getByRole("button", { name: "메뉴 " + size, exact: true });
      const box = await trigger.boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(44); expect(box!.width).toBeGreaterThanOrEqual(44);
    }
    await page.getByRole("button", { name: "메뉴 sm", exact: true }).click();
    for (const item of await page.getByRole("menuitem").all()) expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
    const scan = () => page.evaluate(async () => (await (window as any).axe.run(document)).violations.filter((item: any) => ["serious", "critical"].includes(item.impact)));
    expect(await scan()).toEqual([]);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "부모 열기" }).click();
    for (const button of await page.getByRole("dialog").getByRole("button").all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await scan()).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const bounds = await page.getByRole("dialog").boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
  });
});
