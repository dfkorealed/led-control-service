/** Test-only lifetime of a foundation page and its memory HTTP server. */
export async function runFoundationLifetime(run: () => Promise<void>, closePage: () => Promise<void>, closeServer: () => Promise<void>) {
  const failures: unknown[] = [];
  try { await run(); } catch (error) { failures.push(error); } finally {
    // A live page can keep the HTTP connection open. Neither cleanup failure
    // may prevent the other cleanup or replace the original assertion error.
    try { await closePage(); } catch (error) { failures.push(error); }
    try { await closeServer(); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Foundation assertions and cleanup failed");
}
