import { mockGet, mockPost } from "./mock";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000";
const USE_MOCK_API = import.meta.env.VITE_USE_MOCK_API === "true";

export async function apiGet<T>(path: string): Promise<T> {
  if (USE_MOCK_API) return mockGet<T>(path);

  const response = await fetch(`${API_BASE_URL}${path}`, { credentials: "include" });
  if (!response.ok) throw new Error(`GET ${path} failed with ${response.status}`);
  return response.json() as Promise<T>;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  if (USE_MOCK_API) return mockPost<T>(path);

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`POST ${path} failed with ${response.status}`);
  return response.json() as Promise<T>;
}
