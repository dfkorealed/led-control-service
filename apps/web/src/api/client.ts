const API_BASE_URL = "/api";

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly body: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

export class ApiTransportError extends Error {
  constructor(message = "Service connection failed") {
    super(message);
    this.name = "ApiTransportError";
  }
}

export class ApiTimeoutError extends Error {
  constructor(message = "Request deadline exceeded") {
    super(message);
    this.name = "ApiTimeoutError";
  }
}

export interface ApiRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type ApiFailureKind = "unauthorized" | "forbidden" | "rate_limited" | "server" | "transport" | "timeout" | "other";

export function isApiStatus(error: unknown, status: number) {
  return error instanceof ApiError && error.status === status;
}

export function classifyApiFailure(error: unknown): ApiFailureKind {
  if (error instanceof ApiTimeoutError) return "timeout";
  if (error instanceof ApiTransportError) return "transport";
  if (!(error instanceof ApiError)) return "other";
  if (error.status === 401) return "unauthorized";
  if (error.status === 403) return "forbidden";
  if (error.status === 429) return "rate_limited";
  if (error.status >= 500 && error.status < 600) return "server";
  return "other";
}

export function isTransientApiError(error: unknown) {
  return error instanceof ApiTransportError
    || error instanceof ApiTimeoutError
    || (error instanceof ApiError && error.status >= 500 && error.status < 600);
}

export async function apiRequest<T>(path: string, init: RequestInit = {}, options: ApiRequestOptions = {}): Promise<T> {
  const callerSignal = options.signal ?? init.signal ?? undefined;
  const lifetime = createRequestLifetime(callerSignal, options.timeoutMs);
  try {
    return await lifetime.race(performRequest<T>(path, init, lifetime.signal, callerSignal, lifetime.didTimeout));
  } finally {
    lifetime.cleanup();
  }
}

async function performRequest<T>(
  path: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  callerSignal: AbortSignal | undefined,
  didTimeout: () => boolean
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { ...init, signal, credentials: "include" });
  } catch (error) {
    // fetch 단계만 분류한다. 응답 JSON 파싱/화면의 TypeError와 호출자가 취소한 요청은 재시도하지 않는다.
    if (didTimeout()) throw new ApiTimeoutError();
    if (!callerSignal?.aborted && (error instanceof TypeError || (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name)))) {
      throw new ApiTransportError();
    }
    throw error;
  }
  if (!response.ok) {
    throw new ApiError(
      `${init.method ?? "GET"} ${path} failed with ${response.status}`,
      response.status,
      await readErrorBody(response)
    );
  }
  if (response.status === 204) return { ok: true } as T;
  return response.json() as Promise<T>;
}

export async function apiGet<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  return apiRequest<T>(path, {}, options);
}

export async function apiPost<T>(
  path: string,
  body: unknown,
  options: ApiRequestOptions = {}
): Promise<T> {
  return apiRequest<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }, options);
}

export async function apiPut<T>(path: string, body: unknown, options: ApiRequestOptions = {}): Promise<T> {
  return apiRequest<T>(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }, options);
}

export async function apiPatch<T>(path: string, body: unknown, options: ApiRequestOptions = {}): Promise<T> {
  return apiRequest<T>(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }, options);
}

export async function apiDelete<T>(path: string, body?: unknown, options: ApiRequestOptions = {}): Promise<T> {
  return apiRequest<T>(path, {
    method: "DELETE",
    ...(body === undefined ? {} : {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
  }, options);
}

function createRequestLifetime(callerSignal: AbortSignal | undefined, timeoutMs: number | undefined) {
  const shouldComposeSignal = Boolean(callerSignal) || timeoutMs !== undefined;
  const controller = shouldComposeSignal ? new AbortController() : null;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let removeCallerListener: () => void = () => undefined;
  const interruptions: Promise<never>[] = [];

  if (callerSignal && controller) {
    let rejectCaller: (reason: unknown) => void = () => undefined;
    const callerInterruption = new Promise<never>((_resolve, reject) => { rejectCaller = reject; });
    const abortFromCaller = () => {
      const reason = callerSignal.reason ?? new DOMException("Request cancelled", "AbortError");
      controller.abort(reason);
      rejectCaller(reason);
    };
    if (callerSignal.aborted) abortFromCaller();
    else {
      callerSignal.addEventListener("abort", abortFromCaller, { once: true });
      removeCallerListener = () => callerSignal.removeEventListener("abort", abortFromCaller);
    }
    interruptions.push(callerInterruption);
  }

  if (timeoutMs !== undefined && controller) {
    const timeoutInterruption = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        const error = new ApiTimeoutError();
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    interruptions.push(timeoutInterruption);
  }

  return {
    signal: controller?.signal ?? callerSignal,
    didTimeout: () => timedOut,
    race<T>(request: Promise<T>) {
      return interruptions.length > 0 ? Promise.race<T>([request, ...interruptions]) : request;
    },
    cleanup() {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      removeCallerListener();
    }
  };
}

async function readErrorBody(response: Response): Promise<unknown> {
  const contentType = response.headers?.get("Content-Type") ?? "";
  try {
    if (contentType.includes("json") && typeof response.json === "function") return await response.json();
    if (typeof response.text === "function") return await response.text();
  } catch {
    return null;
  }
  return null;
}
