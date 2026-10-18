import { once } from "node:events";
import { Agent, createServer, get, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { clearTimeout, setTimeout } from "node:timers";
import { describe, expect, it } from "vitest";
import { closeOwnedHttpServer, runFoundationLifetime } from "./design-memory-lifetime";

describe("foundation memory lifetime", () => {
  it("closes the page before the memory server after a successful body", async () => {
    const events: string[] = [];
    const lifetime = runFoundationLifetime(async () => { events.push("body"); }, async () => { events.push("page"); }, async () => { events.push("server"); });
    // Existing three-argument callers start their body before the first await.
    const initialEvents = [...events];
    await lifetime;
    expect(initialEvents).toEqual(["body"]);
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

  it("retains setup and both cleanup errors, closes page first, and never runs the body", async () => {
    const events: string[] = [], setup = new Error("setup"), page = new Error("page"), server = new Error("server");
    const error = await runFoundationLifetime(
      async () => { events.push("body"); },
      async () => { events.push("page"); throw page; },
      async () => { events.push("server"); throw server; },
      async () => { events.push("setup"); throw setup; }
    ).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual([setup, page, server]);
    expect(error.errors[0]).toBe(setup);
    expect(error.errors[1]).toBe(page);
    expect(error.errors[2]).toBe(server);
    expect(events).toEqual(["setup", "page", "server"]);
  });
});

describe("owned memory HTTP server cleanup", () => {
  it("closes preconnected and keep-alive sockets without closing another server's connection", async () => {
    const owned = createServer((_request, response) => response.end("owned"));
    const other = createServer((_request, response) => response.end("other"));
    const accepted = new Map<Server, Socket[]>([[owned, []], [other, []]]);
    for (const server of [owned, other]) server.on("connection", socket => accepted.get(server)!.push(socket));
    const agent = new Agent({ keepAlive: true });
    let preconnected: Socket | undefined, unrelated: Socket | undefined;
    let closing: Promise<void> | undefined, watchdog: ReturnType<typeof setTimeout> | undefined;
    const listen = (server: Server) => new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") return reject(new Error("Missing test server address"));
        resolve(address.port);
      });
    });
    const connections = (server: Server) => new Promise<number>((resolve, reject) => server.getConnections((error, count) => error ? reject(error) : resolve(count)));
    try {
      const ownedPort = await listen(owned), otherPort = await listen(other);
      const ownedAccepted = once(owned, "connection"), otherAccepted = once(other, "connection");
      preconnected = connect(ownedPort, "127.0.0.1");
      unrelated = connect(otherPort, "127.0.0.1");
      // Subscribe before awaiting acceptance: connect can fire while the server
      // event is being delivered, so observing it afterwards can miss it.
      await Promise.all([once(preconnected, "connect"), once(unrelated, "connect"), ownedAccepted, otherAccepted]);
      await new Promise<void>((resolve, reject) => {
        get({ host: "127.0.0.1", port: ownedPort, agent }, response => {
          response.resume();
          response.once("end", resolve);
          response.once("error", reject);
        }).once("error", reject);
      });
      expect(accepted.get(owned)).toHaveLength(2);
      expect(accepted.get(owned)![0].bytesRead).toBe(0);
      expect(accepted.get(owned)![1].bytesRead).toBeGreaterThan(0);
      const clientClosed = once(preconnected, "close");
      closing = closeOwnedHttpServer(owned);
      // A bounded watchdog makes the old drain hang an assertion failure while
      // finally still releases only these test-owned resources on RED.
      const outcome = await Promise.race([
        closing.then(() => "closed"),
        new Promise<string>(resolve => { watchdog = setTimeout(() => resolve("pending"), 1000); })
      ]);
      expect(outcome, "Owned cleanup must not wait for the no-data client to close").toBe("closed");
      await clientClosed;
      expect(owned.listening).toBe(false);
      expect(await connections(owned)).toBe(0);
      expect(accepted.get(owned)!.every(socket => socket.destroyed)).toBe(true);
      expect(other.listening).toBe(true);
      expect(await connections(other)).toBe(1);
      expect(unrelated.destroyed).toBe(false);
      expect(accepted.get(other)![0].destroyed).toBe(false);
    } finally {
      clearTimeout(watchdog);
      preconnected?.destroy(); unrelated?.destroy(); agent.destroy();
      for (const sockets of accepted.values()) for (const socket of sockets) socket.destroy();
      if (closing) await closing;
      for (const server of [owned, other]) if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("rejects an actual HTTP close callback error", async () => {
    await expect(closeOwnedHttpServer(createServer())).rejects.toMatchObject({ code: "ERR_SERVER_NOT_RUNNING" });
  });
});
