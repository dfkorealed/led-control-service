export async function waitForObservedValue({
  observe,
  subscribe,
  producer,
  signal,
  description = "condition"
}) {
  const producerOutcome = producer && Promise.resolve(producer).then(
    (value) => ({ kind: "producer", value }),
    (error) => ({ kind: "producer-error", error })
  );
  const initial = await observe();
  if (initial !== undefined) return initial;

  const abort = createAbortOutcome(signal);
  const watchController = new AbortController();
  let iterator;

  try {
    const watcher = subscribe(watchController.signal);
    iterator = watcher[Symbol.asyncIterator]();
    const race = (primary) => Promise.race([
      primary,
      ...(producerOutcome ? [producerOutcome] : []),
      ...(abort ? [abort.promise] : [])
    ]);
    let outcome = await race(observeOutcome(observe));
    while (true) {
      if (outcome.kind === "producer") return outcome.value;
      if (outcome.kind === "producer-error") throw outcome.error;
      if (outcome.kind === "abort") throw outcome.error;
      if (outcome.kind === "observed" && outcome.value !== undefined) return outcome.value;

      outcome = await race(Promise.resolve(iterator.next()).then((result) => ({
        kind: "event",
        result
      })));
      if (outcome.kind === "producer") return outcome.value;
      if (outcome.kind === "producer-error") throw outcome.error;
      if (outcome.kind === "abort") throw outcome.error;
      if (outcome.result.done) {
        throw new Error(`watch ended before ${description} was observed`);
      }
      outcome = await race(observeOutcome(observe));
    }
  } finally {
    abort?.dispose();
    watchController.abort();
    try {
      await iterator?.return?.();
    } catch (error) {
      if (!isAbortError(error)) throw error;
    }
  }
}

function observeOutcome(observe) {
  return Promise.resolve().then(observe).then((value) => ({ kind: "observed", value }));
}

function createAbortOutcome(signal) {
  if (!signal) return undefined;
  let onAbort;
  const promise = new Promise((resolve) => {
    onAbort = () => resolve({ kind: "abort", error: abortError(signal) });
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  return {
    promise,
    dispose() {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  };
}

function abortError(signal) {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException("The operation was aborted", "AbortError");
}

function isAbortError(error) {
  return error instanceof Error && error.name === "AbortError";
}
