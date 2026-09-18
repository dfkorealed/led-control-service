import { apiPost, apiRequest } from "./client";

const statuses = ["pending", "completed", "partial", "failed", "expired"] as const;
type MonitoringRefreshStatus = typeof statuses[number];

interface MonitoringRefreshStarted {
  id: string;
  status: MonitoringRefreshStatus;
  totalFixtures: number;
}

export interface MonitoringRefreshResult extends MonitoringRefreshStarted {
  onlineFixtures: number;
  offlineFixtures: number;
  unverifiedFixtures: number;
  completedAt: string | null;
}

interface WaitForMonitoringRefreshInput {
  siteId: string;
  floorId: string;
  clientRequestId: string;
  signal?: AbortSignal;
  pollMs?: number;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid monitoring refresh response");
  return value as Record<string, unknown>;
}

function counter(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid monitoring refresh counter");
  return value;
}

function parseStarted(value: unknown): MonitoringRefreshStarted {
  const data = record(value);
  if (typeof data.id !== "string" || !data.id.trim() || !statuses.includes(data.status as MonitoringRefreshStatus)) {
    throw new Error("Invalid monitoring refresh identity or status");
  }
  return { id: data.id, status: data.status as MonitoringRefreshStatus, totalFixtures: counter(data.totalFixtures) };
}

export async function startMonitoringRefresh(siteId: string, floorId: string, clientRequestId: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const response = await apiPost<unknown>(`/sites/${encodeURIComponent(siteId)}/floors/${encodeURIComponent(floorId)}/monitoring-refreshes`, { clientRequestId }, { signal });
  signal?.throwIfAborted();
  return parseStarted(response);
}

export async function getMonitoringRefresh(siteId: string, refreshId: string, signal?: AbortSignal): Promise<MonitoringRefreshResult> {
  signal?.throwIfAborted();
  // Derive the authenticated same-origin route locally; a response URL is not a trusted navigation target.
  const response = await apiRequest<unknown>(`/sites/${encodeURIComponent(siteId)}/monitoring-refreshes/${encodeURIComponent(refreshId)}`, { signal });
  signal?.throwIfAborted();
  const data = record(response);
  const started = parseStarted(data);
  if (started.id !== refreshId || !(data.completedAt === null || (typeof data.completedAt === "string" && Number.isFinite(Date.parse(data.completedAt))))) {
    throw new Error("Invalid monitoring refresh result");
  }
  return {
    ...started,
    onlineFixtures: counter(data.onlineFixtures),
    offlineFixtures: counter(data.offlineFixtures),
    unverifiedFixtures: counter(data.unverifiedFixtures),
    completedAt: data.completedAt as string | null
  };
}

function abortableDelay(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function waitForMonitoringRefresh(input: WaitForMonitoringRefreshInput): Promise<MonitoringRefreshResult> {
  input.signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", abort, { once: true });
  // Bound both polling and a stalled fetch even if the server never returns its terminal aggregate.
  const timeout = setTimeout(() => controller.abort(new DOMException("Monitoring refresh timed out", "TimeoutError")), 30_000);
  try {
    const started = await startMonitoringRefresh(input.siteId, input.floorId, input.clientRequestId, controller.signal);
    let status = started.status;
    while (true) {
      if (status === "pending") await abortableDelay(input.pollMs ?? 500, controller.signal);
      // POST can reuse a terminal job, but only GET contains its detailed counters.
      const current = await getMonitoringRefresh(input.siteId, started.id, controller.signal);
      if (current.status !== "pending") return current;
      status = current.status;
    }
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abort);
  }
}
