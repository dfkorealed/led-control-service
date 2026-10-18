/** Close only the HTTP server owned by a memory fixture. */
export async function closeOwnedHttpServer(server: Pick<import("node:http").Server, "close" | "closeAllConnections">): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    // A context can retain a preconnected socket after page.close. It has not
    // sent HTTP data, so Node does not classify it as idle. Stop accepting first
    // to avoid an accept race, then end only this fixture's owned connections.
    server.closeAllConnections();
  });
}

/** Test-only lifetime of a foundation page and its memory HTTP server. */
export async function runFoundationLifetime(run: () => Promise<void>, closePage: () => Promise<void>, closeServer: () => Promise<void>, setup?: () => Promise<void>) {
  const failures: unknown[] = [];
  try {
    // Preserve the original immediate body start for three-argument callers.
    if (setup) await setup();
    await run();
  } catch (error) { failures.push(error); } finally {
    // A live page can keep the HTTP connection open. Neither cleanup failure
    // may prevent the other cleanup or replace the original assertion error.
    try { await closePage(); } catch (error) { failures.push(error); }
    try { await closeServer(); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Foundation assertions and cleanup failed");
}
