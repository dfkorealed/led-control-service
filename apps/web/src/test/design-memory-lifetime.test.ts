import { describe, expect, it } from "vitest";
import { runFoundationLifetime } from "./design-memory-lifetime";

describe("foundation memory lifetime", () => {
  it("closes the page before the memory server after a successful body", async () => {
    const events: string[] = [];
    await runFoundationLifetime(async () => { events.push("body"); }, async () => { events.push("page"); }, async () => { events.push("server"); });
    expect(events).toEqual(["body", "page", "server"]);
  });

  it("retains the original body Error identity while attempting both cleanups", async () => {
    const events: string[] = [], body = new Error("body");
    const result = runFoundationLifetime(async () => { throw body; }, async () => { events.push("page"); }, async () => { events.push("server"); });
    await expect(result).rejects.toBe(body);
    expect(events).toEqual(["page", "server"]);
  });

  it("retains one cleanup Error identity and still attempts the server after page failure", async () => {
    const events: string[] = [], page = new Error("page");
    const result = runFoundationLifetime(async () => {}, async () => { events.push("page"); throw page; }, async () => { events.push("server"); });
    await expect(result).rejects.toBe(page);
    expect(events).toEqual(["page", "server"]);
  });

  it("retains body and both cleanup Error identities in their original order", async () => {
    const events: string[] = [], body = new Error("body"), page = new Error("page"), server = new Error("server");
    const error = await runFoundationLifetime(async () => { throw body; }, async () => { events.push("page"); throw page; }, async () => { events.push("server"); throw server; }).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toHaveLength(3);
    expect(error.errors[0]).toBe(body);
    expect(error.errors[1]).toBe(page);
    expect(error.errors[2]).toBe(server);
    expect(events).toEqual(["page", "server"]);
  });
});
