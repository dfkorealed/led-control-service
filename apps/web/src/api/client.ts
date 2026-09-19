const API_BASE_URL = "/api";

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly body: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

class ApiTransportError extends Error {}

export function isApiStatus(error: unknown, status: number) {
  return error instanceof ApiError && error.status === status;
}

export function isTransientApiError(error: unknown) {
  return error instanceof ApiTransportError || (error instanceof ApiError && error.status >= 500 && error.status < 600);
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { ...init, credentials: "include" });
  } catch (error) {
    // fetch 단계만 분류한다. 응답 JSON 파싱/화면의 TypeError와 호출자가 취소한 요청은 재시도하지 않는다.
    if (!init.signal?.aborted && (error instanceof TypeError || (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name)))) {
      throw new ApiTransportError("Service connection failed");
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

export async function apiGet<T>(path: string, options: { signal?: AbortSignal } = {}): Promise<T> {
  return apiRequest<T>(path, { signal: options.signal });
}

export async function apiPost<T>(
  path: string,
  body: unknown,
  options: { signal?: AbortSignal } = {}
): Promise<T> {
  return apiRequest<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options.signal
  });
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  return apiRequest<T>(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return apiRequest<T>(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

export async function apiDelete<T>(path: string, body?: unknown): Promise<T> {
  return apiRequest<T>(path, {
    method: "DELETE",
    ...(body === undefined ? {} : {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
  });
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
