import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    dateEvents: Record<string, unknown[]>;
    dateRefs: Record<string, { element: HTMLElement | null; focus(): void }>;
  }
}
const require = createRequire(import.meta.url);
const fixture = String.raw`
import React,{useState} from "react";
import {createRoot} from "react-dom/client";
import {Calendar,DatePicker,DateRangePicker,TimePicker} from "/src/components/ui/index.ts";
import "/src/styles.css";
const el=React.createElement;
window.dateEvents={}; window.dateRefs={};
const record=name=>value=>(window.dateEvents[name]??=[]).push(value);
function Field({kind=DatePicker,id,value:initial=null,...props}){
  const [value,setValue]=useState(initial);
  return el(kind,{...props,id,label:id,value,ref:ref=>{if(ref)window.dateRefs[id]=ref;},onChange:next=>{record(id)(next);setValue(next);}});
}
createRoot(document.getElementById("root")).render(el("main",{className:"flex flex-col gap-4"},
  el("p",{id:"external"},"외부 도움"),
  ...[DatePicker,DateRangePicker,TimePicker].flatMap((kind,index)=>["sm","md","lg"].map(size=>el(Field,{kind,id:"field-"+index+"-"+size,key:index+size,size,description:"설명","aria-describedby":"external","aria-controls":"external"}))),
  el(Field,{id:"filled",variant:"filled"}),el(Field,{id:"ghost",variant:"ghost"}),
  el(Field,{id:"error",isInvalid:true,errorMessage:"입력 확인",description:"설명","aria-describedby":"external"}),
  ...[DatePicker,DateRangePicker,TimePicker].flatMap((kind,index)=>["isDisabled","isReadOnly"].map(state=>el(Field,{kind,id:"state-"+index+"-"+state,key:index+state,[state]:true}))),
  el(Field,{id:"date",value:"2024-02-29",minValue:"2024-02-28",maxValue:"2024-03-02"}),
  el(Field,{kind:DateRangePicker,id:"range",value:{start:"2024-02-28",end:"2024-02-29"},minValue:"2024-02-28",maxValue:"2024-03-02",validationBehavior:"aria"}),
  el(Field,{kind:TimePicker,id:"time",value:"23:58",minValue:"00:00",maxValue:"23:59"}),
  ...[DatePicker,DateRangePicker,TimePicker].flatMap((kind,index)=>["Backspace","Delete"].map(key=>el(Field,{kind,id:"clear-"+index+"-"+key,key:index+key,value:index===2?"01:01":index===1?{start:"0001-01-01",end:"0001-01-01"}:"0001-01-01"}))),
  el(Calendar,{id:"calendar",label:"캘린더",value:"2024-02-29",minValue:"2024-02-28",maxValue:"2024-03-02",onChange:record("calendar")}),
  ...[DatePicker,DateRangePicker,TimePicker].flatMap((kind,index)=>[undefined,"native","aria"].map(validationBehavior=>{
    const id="validation-"+index+"-"+(validationBehavior??"default");
    return el("form",{key:id,"aria-label":id,onSubmit:event=>{event.preventDefault();record(id)("submitted");}},el(Field,{id,kind,isRequired:true,validationBehavior}));
  }))
));
`;
const compile = String.raw`
import {readFileSync} from "node:fs"; import {build} from "vite";
const source=readFileSync(0,"utf8"), entry="virtual:ui-dates-fixture";
const result=await build({logLevel:"silent",build:{write:false,rollupOptions:{input:entry}},plugins:[{name:"ui-dates-production-fixture",enforce:"pre",resolveId(id){if(id===entry)return "\0"+entry;},load(id){if(id==="\0"+entry)return source;}}]});
if(Array.isArray(result)||!("output" in result))throw Error("Expected production build");
const script=result.output.find(asset=>asset.type==="chunk"&&asset.isEntry);
const links=result.output.filter(asset=>asset.fileName.endsWith(".css")).map(asset=>'<link rel="stylesheet" href="/'+asset.fileName+'">').join("");
const html='<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Date contracts</title>'+links+'</head><body><div id="root"></div><script type="module" src="/'+script.fileName+'"></script></body></html>';
console.log(JSON.stringify({html,assets:result.output.map(asset=>[asset.fileName,asset.type==="asset"?String(asset.source):asset.code])}));
`;

test.describe("production date and time contracts", () => {
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
  test.beforeEach(async ({ page }) => { await page.goto(url); await page.locator("#field-0-sm").waitFor(); });

  test("applies sizes and variants to the actual control with visible segment focus", async ({ page }) => {
    for (const index of [0, 1, 2]) for (const [size, minHeight, font] of [["sm", "44px", "13px"], ["md", "44px", "14px"], ["lg", "48px", "16px"]]) {
      const control = page.locator(`#field-${index}-${size}`);
      await expect(control).toHaveCSS("min-height", minHeight);
      await expect(control).toHaveCSS("font-size", font);
      await page.evaluate((id) => window.dateRefs[id].focus(), `field-${index}-${size}`);
      await expect(control.getByRole("spinbutton").first()).toBeFocused();
      expect(await control.getByRole("spinbutton").first().evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe("none");
    }
    expect(await page.locator("#filled").evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(await page.locator("#field-0-md").evaluate((el) => getComputedStyle(el).backgroundColor));
    await expect(page.locator("#ghost")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  });
  test("preserves root IDs, handles, caller ARIA and non-editable states", async ({ page }) => {
    for (const index of [0, 1, 2]) {
      const id = `field-${index}-md`;
      expect(await page.evaluate((id) => window.dateRefs[id].element === document.getElementById(id), id)).toBe(true);
      await expect(page.locator(`#${id}`)).toHaveAttribute("aria-controls", "external");
      await expect(page.locator(`#${id}`).getByRole("spinbutton").first()).toHaveAccessibleDescription(/설명.*외부 도움/);
      for (const state of ["isDisabled", "isReadOnly"]) {
        await page.evaluate((id) => window.dateRefs[id].focus(), id);
        await page.evaluate((id) => window.dateRefs[id].focus(), `state-${index}-${state}`);
        await expect(page.locator(`#${id}`).getByRole("spinbutton").first()).toBeFocused();
      }
    }
    await expect(page.locator("#error").getByRole("spinbutton").first()).toHaveAccessibleDescription(/설명.*입력 확인.*외부 도움/);
    await expect(page.locator("#error").getByRole("spinbutton").first()).toHaveAttribute("aria-invalid", "true");
  });
  test("opens by keyboard, closes on Escape and returns focus; pointer selection emits once", async ({ page }) => {
    const trigger = page.locator("#date").getByRole("button");
    await trigger.focus(); await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.getByRole("dialog").getByRole("button", { name: /2024년 2월 28일/ }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await page.evaluate(() => window.dateEvents.date)).toEqual(["2024-02-28"]);
    expect(await page.evaluate(() => window.dateRefs.date.element === document.getElementById("date"))).toBe(true);
  });
  test("prevents out-of-bounds selection and navigates across the leap-day month boundary", async ({ page }) => {
    await page.locator("#date").getByRole("button").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: /2024년 2월 27일/ })).toHaveAttribute("aria-disabled", "true");
    await dialog.locator("header").getByRole("button", { name: "다음", exact: true }).click();
    await expect(dialog.getByRole("heading")).toHaveText("2024년 3월");
    await expect(dialog.getByRole("button", { name: /2024년 3월 3일/ })).toHaveAttribute("aria-disabled", "true");
    await dialog.getByRole("button", { name: /2024년 3월 1일/ }).click();
    expect(await page.evaluate(() => window.dateEvents.date)).toEqual(["2024-03-01"]);
  });
  test("selects an ordered range and emits only its completed string pair", async ({ page }) => {
    await page.locator("#range").getByRole("button").click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: /2024년 2월 29일/ }).click();
    expect(await page.evaluate(() => window.dateEvents.range ?? [])).toEqual([]);
    await dialog.getByRole("button", { name: /2024년 2월 28일/ }).click();
    expect(await page.evaluate(() => window.dateEvents.range)).toEqual([{ start: "2024-02-28", end: "2024-02-29" }]);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const startYear = page.locator("#range").getByRole("spinbutton").first();
    await startYear.focus(); await page.keyboard.press("ArrowUp");
    await expect(startYear).toHaveText("2025");
    await expect(startYear).toHaveAttribute("aria-invalid", "true");
    expect(await page.evaluate(() => window.dateEvents.range)).toEqual([
      { start: "2024-02-28", end: "2024-02-29" }, { start: "2025-02-28", end: "2024-02-29" }
    ]);
  });
  test("selects the next day across leap-day with calendar arrow keys and Enter", async ({ page }) => {
    await page.locator("#date").getByRole("button").click();
    await page.getByRole("dialog").getByRole("button", { name: /2024년 2월 29일/ }).focus();
    await page.keyboard.press("ArrowRight"); await page.keyboard.press("Enter");
    expect(await page.evaluate(() => window.dateEvents.date)).toEqual(["2024-03-01"]);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
  test("edits 24-hour time and clears every family with Backspace and Delete exactly once", async ({ page }) => {
    const minutes = page.locator("#time").getByRole("spinbutton").nth(1);
    await minutes.focus(); await page.keyboard.press("ArrowUp");
    expect(await page.evaluate(() => window.dateEvents.time)).toEqual(["23:59"]);
    await expect(page.locator("#time").getByRole("spinbutton")).toHaveCount(2);
    for (const index of [0, 1, 2]) for (const key of ["Backspace", "Delete"]) {
      const id = `clear-${index}-${key}`;
      const segments = page.locator(`#${id}`).getByRole("spinbutton");
      for (let i = 0; i < await segments.count(); i++) {
        await segments.nth(i).focus(); await page.keyboard.press(key);
      }
      expect(await page.evaluate((id) => window.dateEvents[id], id)).toEqual([null]);
      await page.evaluate((id) => window.dateRefs[id].focus(), id);
      await expect(segments.first()).toBeFocused();
    }
  });
  test("preserves default/native/aria form validation semantics", async ({ page }) => {
    for (const index of [0, 1, 2]) for (const mode of ["default", "native", "aria"]) {
      const id = `validation-${index}-${mode}`;
      const valid = await page.getByRole("form", { name: id }).evaluate((form: HTMLFormElement) => { const valid = form.checkValidity(); form.requestSubmit(); return valid; });
      expect(valid).toBe(mode === "aria");
      expect(await page.evaluate((id) => window.dateEvents[id] ?? [], id)).toEqual(mode === "aria" ? ["submitted"] : []);
    }
  });
  test("fits 320px and provides 44px calendar, trigger and segment touch targets", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    await page.locator("#date").getByRole("button").click();
    const targets = page.getByRole("dialog").locator('[role="button"]:visible, button:visible');
    for (const target of await targets.all()) {
      const bounds = await target.boundingBox();
      expect(bounds!.width).toBeGreaterThanOrEqual(44);
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
    }
    const bounds = await page.getByRole("dialog").boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
    await page.keyboard.press("Escape");
    for (const target of await page.locator('#date [role="spinbutton"], #date button').all()) {
      const bounds = await target.boundingBox();
      expect(bounds!.width).toBeGreaterThanOrEqual(44); expect(bounds!.height).toBeGreaterThanOrEqual(44);
    }
  });
  test("has zero serious/critical axe violations in fields and open date/range calendars", async ({ page }) => {
    await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
    for (const id of [null, "date", "range"]) {
      if (id) await page.locator(`#${id}`).getByRole("button").click();
      const violations = await page.evaluate(async () => {
        const axe = (window as unknown as { axe: { run(): Promise<{ violations: { id: string; impact: string; nodes: unknown[] }[] }> } }).axe;
        return (await axe.run()).violations.filter(({ impact }) => impact === "serious" || impact === "critical");
      });
      expect(violations).toEqual([]);
      if (id) await page.keyboard.press("Escape");
    }
  });
});
