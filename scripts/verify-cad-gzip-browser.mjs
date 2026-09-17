#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const root = resolve(import.meta.dirname, "..");
const apiRequire = createRequire(join(root, "apps/api/package.json"));
const webRequire = createRequire(join(root, "apps/web/package.json"));
const { DeleteObjectCommand, S3Client } = apiRequire("@aws-sdk/client-s3");
const { chromium } = webRequire("@playwright/test");
const { ObjectStorageService } = apiRequire("./dist/src/storage/object-storage.service.js");

const endpoint = process.env.OBJECT_STORAGE_ENDPOINT ?? "http://localhost:9000";
const bucket = process.env.OBJECT_STORAGE_BUCKET ?? "floor-assets";
const client = new S3Client({
  region: process.env.OBJECT_STORAGE_REGION ?? "us-east-1", endpoint, forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY ?? "led-floor-assets",
    secretAccessKey: process.env.OBJECT_STORAGE_SECRET_KEY ?? "change-this-local-secret"
  }
});
const service = new ObjectStorageService(client, { bucket, publicBaseUrl: `${endpoint}/${bucket}` });
const directory = await mkdtemp(join(tmpdir(), "cad-gzip-browser-"));
const objectKey = `floors/browser-contract/${Date.now()}.svg`;
let browser;
try {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="37" height="23" viewBox="0 0 37 23"><rect width="37" height="23" fill="#fff"/><text x="2" y="16">한글 CAD</text></svg>');
  const compressed = gzipSync(svg, { level: 9 });
  const path = join(directory, "rendered.svg");
  await writeFile(path, compressed);
  const rendered = {
    sizeBytes: compressed.length, sha256: createHash("sha256").update(compressed).digest("hex"),
    contentEncoding: "gzip", viewport: { width: 37, height: 23 }
  };
  await service.putFloorRenderedObjectFile(objectKey, path, rendered, rendered.viewport);
  await service.verifyFloorRenderedObject(objectKey, {
    sizeBytes: rendered.sizeBytes, sha256: rendered.sha256, mimeType: "image/svg+xml",
    contentEncoding: "gzip", ...rendered.viewport
  });
  await service.readFloorRenderedMetadata(objectKey, {
    sizeBytes: rendered.sizeBytes, sha256: rendered.sha256, mimeType: "image/svg+xml", contentEncoding: "gzip"
  });
  const signedUrl = await service.createFloorAssetDownloadUrl(objectKey);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const responsePromise = page.waitForResponse(response => response.url().startsWith(endpoint) && response.url().includes(objectKey));
  await page.setContent('<img id="cad" alt="CAD gzip contract">');
  await page.evaluate(url => { (document.querySelector("#cad")).src = url; }, signedUrl);
  await page.waitForFunction(() => (document.querySelector("#cad")).complete && (document.querySelector("#cad")).naturalWidth > 0);
  const response = await responsePromise;
  const dimensions = await page.$eval("#cad", image => ({ width: image.naturalWidth, height: image.naturalHeight }));
  if (response.headers()["content-encoding"] !== "gzip" || dimensions.width !== 37 || dimensions.height !== 23) {
    throw new Error("Chrome did not decode the gzip CAD SVG with the recorded metadata");
  }
  process.stdout.write(`${JSON.stringify({ objectKey, storedBytes: compressed.length, contentEncoding: "gzip", dimensions })}\n`);
} finally {
  await browser?.close();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey })).catch(() => undefined);
  client.destroy();
  await rm(directory, { recursive: true, force: true });
}
