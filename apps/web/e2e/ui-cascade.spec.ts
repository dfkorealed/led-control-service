import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";

interface ControlStyle { minHeight: string; padding: string; fontSize: string; lineHeight: string; width: string; height: string }
interface Observations {
  controls: Record<string, ControlStyle>;
  sidebar: { width: string; padding: string };
  tooltipAlignment: { right: string; transform: string };
  keyboard: { key: string; x: number; y: number; width: number; height: number }[];
}

// Run the production build and its browser fixture in an isolated Node process;
// neither the application's dev server nor the unit suite's JSDOM is involved.
const measureProduction = String.raw`
import {readFile} from "node:fs/promises";
import {createServer} from "node:http";
import {build} from "vite";
import {chromium} from "@playwright/test";

const entry = "virtual:ui-cascade-fixture";
const fixture = [
  'import React from "react";',
  'import {createRoot} from "react-dom/client";',
  'import {LogOut} from "lucide-react";',
  'import {Button, IconTooltipButton} from "/src/components/ui/index.ts";',
  'import "/src/styles.css";',
  'const el = React.createElement;',
  'window.uiPressCoordinates = [];',
  'createRoot(document.getElementById("root")).render(el("div", null,',
  '...[ "sm", "md", "lg" ].map(size => el(Button, {key:size,size,"data-testid":size}, size)),',
  'el(Button,{size:"lg",className:"px-3","data-testid":"override"},"override"),',
  'el(IconTooltipButton,{icon:LogOut,label:"기본 도움말","data-testid":"tooltip-default"}),',
  'el(IconTooltipButton,{icon:LogOut,label:"크기 도움말",className:"p-2 w-16 h-16 min-w-16 min-h-16","data-testid":"tooltip-override"}),',
  'el("div",{className:"sidebar","data-testid":"legacy-sidebar"},"legacy"),',
  'el("div",{className:"operator-row-actions"},el(Button,{"data-testid":"legacy-row-action"},"행 동작")),',
  'el("div",{className:"topbar-actions"},el(IconTooltipButton,{icon:LogOut,label:"상단 도움말"})),',
  'el(Button,{type:"button","data-testid":"keyboard",onPress:event=>window.uiPressCoordinates.push({x:event.x,y:event.y,key:event.key})},"키보드")));'
].join("\n");

const result = await build({
  logLevel:"silent",
  build:{write:false,rollupOptions:{input:entry}},
  plugins:[{
    name:"ui-cascade-production-fixture",enforce:"pre",
    resolveId(id){if(id===entry)return "\0"+entry;},
    async load(id){
      // Tests are excluded from production candidate scanning; register only
      // this fixture's caller utilities in the real production CSS build.
      if(id.endsWith("/src/styles.css"))return await readFile(id,"utf8")+'\n@source inline("p-2 px-3 w-16 h-16 min-w-16 min-h-16");';
      if(id==="\0"+entry)return fixture;
    }
  }]
});
if(Array.isArray(result)||!("output" in result))throw Error("Expected one production build");
const assets=new Map(result.output.map(asset=>[asset.fileName,asset.type==="asset"?asset.source:asset.code]));
const script=result.output.find(asset=>asset.type==="chunk"&&asset.isEntry);
if(!script)throw Error("Missing production fixture entry");
const links=result.output.filter(asset=>asset.fileName.endsWith(".css")).map(asset=>'<link rel="stylesheet" href="/'+asset.fileName+'">').join("");
const html='<!doctype html><html lang="ko"><head><title>UI cascade</title>'+links+'</head><body><div id="root"></div><script type="module" src="/'+script.fileName+'"></script></body></html>';
const server=createServer((request,response)=>{
  const name=request.url?.slice(1)??"";
  response.setHeader("Content-Type",name.endsWith(".css")?"text/css":name.endsWith(".js")?"application/javascript":"text/html");
  response.end(assets.get(name)??html);
});
let browser;
try {
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  await page.goto("http://127.0.0.1:"+server.address().port);
  await page.getByTestId("sm").waitFor();
  const observations={controls:{},keyboard:[]};
  for(const id of ["sm","md","lg","override","tooltip-default","tooltip-override","legacy-row-action"]){
    observations.controls[id]=await page.getByTestId(id).evaluate(element=>{
      const style=getComputedStyle(element);
      return {minHeight:style.minHeight,padding:style.padding,fontSize:style.fontSize,lineHeight:style.lineHeight,width:style.width,height:style.height};
    });
  }
  observations.sidebar=await page.getByTestId("legacy-sidebar").evaluate(element=>{
    const style=getComputedStyle(element);return {width:style.width,padding:style.padding};
  });
  await page.getByRole("button",{name:"상단 도움말"}).focus();
  observations.tooltipAlignment=await page.getByRole("tooltip").evaluate(element=>{
    const style=getComputedStyle(element);return {right:style.right,transform:style.transform};
  });
  const keyboard=page.getByTestId("keyboard");
  for(const key of ["Enter","Space"]){
    await keyboard.press(key);
    const bounds=await keyboard.boundingBox();
    const event=await page.evaluate(()=>window.uiPressCoordinates.at(-1));
    observations.keyboard.push({...event,key,width:bounds.width,height:bounds.height});
  }
  console.log(JSON.stringify(observations));
} finally {
  await browser?.close();
  await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
}
`;

test.describe("production primitive CSS cascade", () => {
  test.setTimeout(35_000);
  let observed: Observations;
  test.beforeAll(() => {
    observed = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", measureProduction], { encoding: "utf8", timeout: 30_000 }));
  });

  for (const [id, minHeight, padding, fontSize, lineHeight] of [
    ["sm", "44px", "0px 12px", "13px", "20px"],
    ["md", "44px", "0px 16px", "14px", "22px"],
    ["lg", "48px", "8px 24px", "16px", "24px"]
  ]) test(`applies ${id} size from the production utilities`, () => {
    expect(observed.controls[id]).toMatchObject({ minHeight, padding, fontSize, lineHeight });
  });

  test("lets caller padding override the large button padding", () => {
    expect(observed.controls.override.padding).toBe("8px 12px");
  });

  test("lets callers size and pad the tooltip's actual button", () => {
    expect(observed.controls["tooltip-override"]).toMatchObject({ padding: "8px", width: "64px", height: "64px" });
  });

  test("preserves the default tooltip touch area and unrelated legacy layout rules", () => {
    expect(observed.controls["tooltip-default"]).toMatchObject({ width: "52px", height: "52px" });
    expect(observed.sidebar).toEqual({ width: "92px", padding: "16px 10px 14px" });
    expect(observed.controls["legacy-row-action"].minHeight).toBe("36px");
    expect(observed.tooltipAlignment).toEqual({ right: "0px", transform: "none" });
  });

  for (const key of ["Enter", "Space"]) test(`uses element-center coordinates for a real ${key} activation`, () => {
    const event = observed.keyboard.find(event => event.key === key)!;
    expect(event.x).toBeCloseTo(event.width / 2);
    expect(event.y).toBeCloseTo(event.height / 2);
  });
});
