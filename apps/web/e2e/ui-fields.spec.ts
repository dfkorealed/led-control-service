import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    fieldEvents: Record<string, unknown[]>;
    fieldRefs: Record<string, HTMLElement | null>;
    fileIdentity: boolean[];
  }
}
const require = createRequire(import.meta.url);
const fixture = String.raw`
import React from "react";
import {createRoot} from "react-dom/client";
import {TextField, NumberField, FileField, SelectBox, ComboBox, Checkbox, CheckboxGroup, RadioGroup, Switch, Slider} from "/src/components/ui/index.ts";
import "/src/styles.css";
const el = React.createElement;
window.fieldEvents = {};
window.fieldRefs = {};
window.fileIdentity = [];
const record = name => value => (window.fieldEvents[name] ??= []).push(value);
const ref = name => element => window.fieldRefs[name] = element;
const items = [{id:0,label:"1층",description:"입구"},{id:2,label:"금지",isDisabled:true},{id:3,label:"3층",description:"사무실"}];
const choices = items.map(({id,label,description,isDisabled})=>({value:String(id),label,description,isDisabled}));
createRoot(document.getElementById("root")).render(el("main", {className:"flex flex-col gap-4 p-6"},
  ...["sm","md","lg"].map(size=>el(TextField,{key:size,label:size,size,ref:ref(size),defaultValue:"입력"})),
  el(TextField,{label:"채움",variant:"filled",defaultValue:"입력"}),
  el(TextField,{label:"투명",variant:"ghost",defaultValue:"입력"}),
  el(TextField,{label:"간격",className:"gap-4",description:"설명"}),
  el(TextField,{label:"오류",isInvalid:true,errorMessage:"입력 확인",defaultValue:"입력"}),
  el(NumberField,{label:"수량",defaultValue:2,minValue:0,maxValue:4,step:2,onChange:record("number"),ref:ref("number")}),
  el(SelectBox,{label:"층 선택",items,defaultSelectedKey:0,onSelectionChange:record("select"),ref:ref("select")}),
  el(ComboBox,{label:"층 검색",items,onSelectionChange:record("combo"),ref:ref("combo")}),
  el(Checkbox,{label:"체크",onChange:record("checkbox"),ref:ref("checkbox")}),
  el(Switch,{label:"전환",onChange:record("switch"),ref:ref("switch")}),
  el(CheckboxGroup,{label:"복수 층",items:choices,defaultValue:["0"],onChange:record("group")}),
  el(RadioGroup,{label:"단일 층",items:choices,defaultValue:"0",onChange:record("radio")}),
  el(Slider,{label:"밝기",defaultValue:90,minValue:0,maxValue:100,step:10,onChange:record("slider"),ref:ref("slider")}),
  el("form",null,el(FileField,{label:"도면",accept:"image/png",multiple:true,ref:ref("file"),onChange:files=>{window.fileIdentity.push(files === window.fieldRefs.file.files);record("files")(files ? Array.from(files).map(file=>file.name) : null);}}),el("button",{type:"reset"},"초기화"))
));
`;
const compile = String.raw`
import {readFileSync} from "node:fs";
import {build} from "vite";
const source=readFileSync(0,"utf8");
const entry="virtual:ui-fields-fixture";
const result=await build({logLevel:"silent",build:{write:false,rollupOptions:{input:entry}},plugins:[{name:"ui-fields-production-fixture",enforce:"pre",resolveId(id){if(id===entry)return "\0"+entry;},load(id){if(id==="\0"+entry)return source;}}]});
if(Array.isArray(result)||!("output" in result))throw Error("Expected one production build");
const script=result.output.find(asset=>asset.type==="chunk"&&asset.isEntry);
if(!script)throw Error("Missing fixture entry");
const links=result.output.filter(asset=>asset.fileName.endsWith(".css")).map(asset=>'<link rel="stylesheet" href="/'+asset.fileName+'">').join("");
const html='<!doctype html><html lang="ko"><head><title>Field contracts</title>'+links+'</head><body><div id="root"></div><script type="module" src="/'+script.fileName+'"></script></body></html>';
console.log(JSON.stringify({html,assets:result.output.map(asset=>[asset.fileName,asset.type==="asset"?String(asset.source):asset.code])}));
`;

test.describe("production field browser contracts", () => {
  let server: Server;
  let url: string;
  test.beforeAll(async () => {
    const built = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", compile], { input: fixture, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })) as { html: string; assets: [string, string][] };
    const assets = new Map(built.assets);
    server = createServer((request, response) => {
      const name = request.url?.slice(1) ?? "";
      response.setHeader("Content-Type", name.endsWith(".css") ? "text/css" : name.endsWith(".js") ? "application/javascript" : "text/html");
      response.end(assets.get(name) ?? built.html);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Missing fixture address");
    url = `http://127.0.0.1:${address.port}`;
  });
  test.afterAll(async () => { if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });
  test.beforeEach(async ({ page }) => { await page.goto(url); await page.getByRole("textbox", { name: "sm", exact: true }).waitFor(); });

  test("applies real size, variant, invalid and caller layout utilities", async ({ page }) => {
    for (const [size, height, padding, font] of [["sm", "44px", "8px 12px", "13px"], ["md", "44px", "10px 12px", "14px"], ["lg", "48px", "12px 16px", "16px"]]) {
      const input = page.getByRole("textbox", { name: size, exact: true });
      await expect(input).toHaveCSS("min-height", height);
      await expect(input).toHaveCSS("padding", padding);
      await expect(input).toHaveCSS("font-size", font);
    }
    const filled = await page.getByRole("textbox", { name: "채움" }).evaluate((element) => getComputedStyle(element).backgroundColor);
    const outline = await page.getByRole("textbox", { name: "md", exact: true }).evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(filled).not.toBe(outline);
    await expect(page.getByRole("textbox", { name: "투명" })).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(page.getByRole("textbox", { name: "간격" }).locator("xpath=ancestor::*[@data-field]")).toHaveCSS("gap", "16px");
    const border = await page.getByRole("textbox", { name: "오류" }).evaluate((element) => getComputedStyle(element).borderColor);
    expect(border).not.toBe(await page.getByRole("textbox", { name: "md", exact: true }).evaluate((element) => getComputedStyle(element).borderColor));
  });
  test("keyboard focus lands on the actual ref and displays the focus ring", async ({ page }) => {
    await page.keyboard.press("Tab");
    const input = page.getByRole("textbox", { name: "sm", exact: true });
    await expect(input).toBeFocused();
    expect(await page.evaluate(() => document.activeElement === window.fieldRefs.sm)).toBe(true);
    expect(await input.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");
  });
  test("native Space toggles checkbox and switch once each", async ({ page }) => {
    for (const [role, label, name] of [["checkbox", "체크", "checkbox"], ["switch", "전환", "switch"]] as const) {
      const input = page.getByRole(role, { name: label, exact: true });
      await input.focus();
      await input.press("Space");
      await expect(input).toBeChecked();
      expect(await page.evaluate((key) => window.fieldEvents[key], name)).toEqual([true]);
      expect(await page.evaluate((key) => document.activeElement === window.fieldRefs[key], name)).toBe(true);
      const box = await input.locator("xpath=ancestor::label").boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
  });
  test("popup keyboard selection skips disabled keys and restores the exact control focus", async ({ page }) => {
    const select = page.getByRole("button", { name: "층 선택", exact: true });
    await select.press("ArrowDown");
    await expect(page.getByRole("option", { name: "금지" })).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await expect(select).toBeFocused();
    expect(await page.evaluate(() => window.fieldEvents.select)).toEqual([3]);
    const combo = page.getByRole("combobox", { name: "층 검색", exact: true });
    await combo.fill("3");
    await expect(page.getByRole("option")).toHaveCount(1);
    await combo.press("ArrowDown");
    await combo.press("Enter");
    await expect(combo).toBeFocused();
    await expect(combo).toHaveValue("3층");
    expect(await page.evaluate(() => window.fieldEvents.combo)).toEqual([3]);
    await select.press("ArrowDown");
    await page.keyboard.press("Escape");
    await expect(select).toBeFocused();
    await expect(page.getByRole("listbox")).toHaveCount(0);
  });
  test("number, radio and slider keyboard changes preserve numeric/string contracts", async ({ page }) => {
    await page.getByRole("textbox", { name: "수량" }).press("ArrowUp");
    await page.getByRole("textbox", { name: "수량" }).press("ArrowUp");
    expect(await page.evaluate(() => window.fieldEvents.number)).toEqual([4]);
    await page.getByRole("radiogroup", { name: "단일 층" }).getByRole("radio", { name: "1층" }).press("ArrowRight");
    expect(await page.evaluate(() => window.fieldEvents.radio)).toEqual(["3"]);
    const slider = page.getByRole("slider", { name: "밝기" });
    await slider.press("ArrowRight");
    await slider.press("ArrowRight");
    expect(await page.evaluate(() => window.fieldEvents.slider)).toEqual([100]);
    expect(await page.evaluate(() => document.activeElement === window.fieldRefs.slider)).toBe(true);
  });
  test("delivers the real FileList unchanged and allows reset then same-file selection", async ({ page }) => {
    const input = page.getByLabel("도면", { exact: true });
    const file = { name: "plan.png", mimeType: "image/png", buffer: Buffer.from("plan") };
    await input.setInputFiles(file);
    expect(await page.evaluate(() => window.fileIdentity)).toEqual([true]);
    expect(await page.evaluate(() => window.fieldEvents.files)).toEqual([["plan.png"]]);
    await page.getByRole("button", { name: "초기화" }).click();
    await expect(input).toHaveValue("");
    await input.setInputFiles(file);
    expect(await page.evaluate(() => window.fieldEvents.files)).toEqual([["plan.png"], ["plan.png"]]);
    expect(await page.evaluate(() => window.fileIdentity)).toEqual([true, true]);
  });
  test("has no serious or critical axe violations with production CSS and an open popup", async ({ page }) => {
    await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
    const scans = [];
    for (const open of [false, true]) {
      if (open) await page.getByRole("button", { name: "층 선택", exact: true }).press("ArrowDown");
      const violations = await page.evaluate("axe.run(document.body).then(result => result.violations.filter(item => ['serious','critical'].includes(item.impact)))");
      scans.push(violations);
    }
    expect(scans).toEqual([[], []]);
  });
});
