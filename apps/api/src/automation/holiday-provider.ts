/** Only this normalized boundary reaches the cache; keys and raw source envelopes never do. */
export type HolidayProviderPage = {
  year: number; month: number; page: number; numOfRows: number; totalCount: number;
  items: Array<{ date: string; name: string; isHoliday: boolean }>;
};
export interface HolidayProvider {
  fetchMonth(input: { year: number; month: number; page: number }, signal: AbortSignal): Promise<HolidayProviderPage>;
}
export const HOLIDAY_PROVIDER = Symbol("HOLIDAY_PROVIDER");
type HolidayFetch = (url: URL, options: { signal: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
const endpoint = "https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo";

/** Explicit construction is the credential boundary. No environment lookup or default live provider. */
export class KasiHolidayProvider implements HolidayProvider {
  constructor(private readonly serviceKey: string, private readonly fetcher: HolidayFetch = globalThis.fetch) {}

  async fetchMonth(input: { year: number; month: number; page: number }, signal: AbortSignal): Promise<HolidayProviderPage> {
    if (!this.serviceKey.trim() || signal.aborted) throw new Error("holiday_provider_unavailable");
    if (!validYear(input.year) || !integer(input.month, 1, 12) || !integer(input.page, 1, 10_000)) {
      throw new Error("holiday_provider_invalid_request");
    }
    const url = new URL(endpoint);
    url.search = new URLSearchParams({ ServiceKey: this.serviceKey, solYear: String(input.year).padStart(4, "0"),
      solMonth: String(input.month).padStart(2, "0"), pageNo: String(input.page), numOfRows: "100", _type: "json" }).toString();
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    const timeout = setTimeout(cancel, 10_000);
    let rejectAbort: (() => void) | undefined;
    try {
      const request = (async () => {
        const response = await this.fetcher(url, { signal: abort.signal });
        if (!response.ok || abort.signal.aborted) throw new Error("holiday_provider_unavailable");
        let body: unknown;
        try { body = await response.json(); } catch { throw new Error("holiday_provider_invalid_response"); }
        if (abort.signal.aborted) throw new Error("holiday_provider_unavailable");
        return parseResponse(body, input);
      })();
      // Bound both fetch and body parsing even when an injected transport ignores AbortSignal.
      return await Promise.race([request, new Promise<never>((_resolve, reject) => {
        rejectAbort = () => reject(new Error("holiday_provider_unavailable"));
        abort.signal.addEventListener("abort", rejectAbort, { once: true });
        if (abort.signal.aborted) rejectAbort();
      })]);
    } catch (error) {
      // Never propagate a transport error: fetch errors may include the credential-bearing URL.
      throw new Error(error instanceof Error && error.message === "holiday_provider_invalid_response"
        ? "holiday_provider_invalid_response" : "holiday_provider_unavailable");
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", cancel);
      if (rejectAbort) abort.signal.removeEventListener("abort", rejectAbort);
    }
  }
}

function parseResponse(raw: unknown, input: { year: number; month: number; page: number }): HolidayProviderPage {
  const invalid = () => { throw new Error("holiday_provider_invalid_response"); };
  const response = record(record(raw)?.response);
  if (record(response?.header)?.resultCode !== "00") invalid();
  const body = record(response?.body);
  if (!body || !integer(body.totalCount, 0, 10_000) || !integer(body.numOfRows, 1, 1000)
    || body.pageNo !== input.page || !Object.hasOwn(body, "items")) return invalid();
  const totalCount = body.totalCount as number;
  const numOfRows = body.numOfRows as number;
  const items = record(body.items);
  let rows: unknown[];
  if (body.items === "" || (items && Object.keys(items).length === 0)) rows = [];
  else if (items && Object.hasOwn(items, "item")) rows = Array.isArray(items.item) ? items.item : [items.item];
  else return invalid();
  const expectedCount = Math.min(numOfRows, Math.max(0, totalCount - (input.page - 1) * numOfRows));
  if (input.page > Math.max(1, Math.ceil(totalCount / numOfRows)) || rows.length !== expectedCount) invalid();
  const monthPrefix = `${String(input.year).padStart(4, "0")}-${String(input.month).padStart(2, "0")}-`;
  return { ...input, numOfRows, totalCount, items: rows.map(value => {
    const row = record(value);
    if (!row || (row.isHoliday !== "Y" && row.isHoliday !== "N") || typeof row.dateName !== "string"
      || !row.dateName.trim() || !integer(row.seq, 1, Number.MAX_SAFE_INTEGER)
      || typeof row.dateKind !== "string" || !row.dateKind.trim()) return invalid();
    if (typeof row.locdate !== "string" && typeof row.locdate !== "number") return invalid();
    const date = String(row.locdate);
    if (!/^\d{8}$/.test(date)) return invalid();
    const normalized = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
    if (!validCivilDate(normalized) || !normalized.startsWith(monthPrefix)) return invalid();
    return { date: normalized, name: row.dateName.trim(), isHoliday: row.isHoliday === "Y" };
  }) };
}
export function validCivilDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const instant = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === value;
}
export function validYear(year: unknown): year is number { return integer(year, 1, 9999); }
export function integer(value: unknown, from: number, to: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= from && value <= to;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
