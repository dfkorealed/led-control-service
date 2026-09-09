import { Body, Controller, INestApplication, Put } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { EDITOR_MAX_BODY_BYTES, saveEditorStateSchema } from "@led-control/shared";
import { NestExpressApplication } from "@nestjs/platform-express";
import { configureApiBodyParser } from "../api-body-parser";
import { request } from "node:http";

@Controller("floors/:floorId")
class BodyLimitController {
  @Put("editor-state")
  save(@Body() input: unknown) { return { fixtures: saveEditorStateSchema.parse(input).fixtureUpdates.length }; }
  @Put("other")
  other(@Body() input: unknown) { return input; }
}

describe("editor HTTP body budget", () => {
  let app: INestApplication;
  let url: string;
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [BodyLimitController] }).compile();
    app = module.createNestApplication<NestExpressApplication>();
    configureApiBodyParser(app as NestExpressApplication);
    await app.listen(0, "127.0.0.1");
    url = `${await app.getUrl()}/floors/test/editor-state`;
  });
  afterAll(async () => { await app.close(); });
  const send = (body: string) => fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body });

  it("accepts 1,000 full fixture patches and 2,000 map objects below 1 MiB", async () => {
    const body = JSON.stringify({ expectedRevision: 0, leaseToken: "lease", leaseFence: 1,
      fixtureUpdates: Array.from({ length: 1000 }, (_, i) => ({ id: `fixture-${i}`, name: `Light-${i}`,
        x: 200, y: 100, size: 24, ratedWatt: 40, placementStatus: "placed", positionVerified: false })),
      objectCreates: Array.from({ length: 2000 }, () => ({ type: "rectangle", x: 10, y: 10, width: 30, height: 30,
        rotation: 0, points: null, text: null, strokeColor: "#ffffff", fillColor: null, strokeWidth: 1,
        fontSize: null, zIndex: 0, locked: false, visible: true })), objectUpdates: [], objectDeletes: [] });
    expect(Buffer.byteLength(body)).toBeLessThan(EDITOR_MAX_BODY_BYTES);
    const response = await send(body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ fixtures: 1000 });
  });

  it("rejects overlimit UTF-8 bodies with a JSON 413 then continues serving", async () => {
    const response = await send(JSON.stringify({ text: "한".repeat(EDITOR_MAX_BODY_BYTES / 3 + 1) }));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ statusCode: 413 });
    const valid = await send(JSON.stringify({ expectedRevision: 0, leaseToken: "lease", leaseFence: 1,
      fixtureUpdates: [], objectCreates: [], objectUpdates: [], objectDeletes: [] }));
    expect(valid.status).toBe(200);
  });

  it("enforces streamed bodies without Content-Length and keeps non-editor limits unchanged", async () => {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(url, { method: "PUT", headers: { "content-type": "application/json" } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject);
      req.write('{"text":"');
      for (let i = 0; i < 17; i++) req.write("a".repeat(65536));
      req.end('"}');
    });
    expect(status).toBe(413);
    const other = await fetch(url.replace("editor-state", "other"), { method: "PUT",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "a".repeat(110000) }) });
    expect(other.status).toBe(413);
    const small = await fetch(url.replace("editor-state", "other"), { method: "PUT",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "retained" }) });
    expect(await small.json()).toEqual({ name: "retained" });
  });
});
