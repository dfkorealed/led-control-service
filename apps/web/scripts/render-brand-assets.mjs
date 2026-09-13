import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "@playwright/test";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const brandDir = path.join(webRoot, "public", "brand");
const svg = await readFile(path.join(brandDir, "kinda-mark.svg"), "utf8");
const outputs = [
  { size: 32, name: "favicon-32.png" },
  { size: 512, name: "kinda-mark-512.png" }
];

const browser = await chromium.launch();
try {
  for (const output of outputs) {
    const page = await browser.newPage({ viewport: { width: output.size, height: output.size } });
    await page.setContent(`<!doctype html><style>
      html, body { margin: 0; width: ${output.size}px; height: ${output.size}px; background: transparent; }
      svg { display: block; width: ${output.size}px; height: ${output.size}px; }
    </style>${svg}`);
    await page.locator("svg").screenshot({
      path: path.join(brandDir, output.name),
      omitBackground: true
    });
    await page.close();
  }
} finally {
  await browser.close();
}
