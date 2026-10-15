import { BadRequestException, ConflictException, Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional, ServiceUnavailableException } from "@nestjs/common";
import { holidayDatasetSnapshotSchema, type HolidayDatasetSnapshot } from "@led-control/shared";
import { type HolidayDataset, Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { AutomationClock } from "./automation-clock";
import { AutomationSnapshotService } from "./automation-snapshot.service";
import { canonicalPayloadHash } from "./automation-payload-hash";
import { HOLIDAY_PROVIDER, type HolidayProvider, type HolidayProviderPage, integer, validCivilDate, validYear } from "./holiday-provider";

export type HolidayRefreshResult = { status: "promoted" | "unchanged" | "failed"; revision: string | null; reason: string | null };
export const HOLIDAY_DATASET_PROMOTION = Symbol("HOLIDAY_DATASET_PROMOTION");
/** Task4 supplies this hook. It runs under the existing lock, and must use this transaction. */
export interface HolidayDatasetPromotion {
  onPromoted(tx: Prisma.TransactionClient, dataset: HolidayDatasetSnapshot): Promise<void>;
}
type MonthProof = { month: number; totalCount: number; pageCount: number; numOfRows: number;
  pages: Array<{ page: number; itemCount: number }> };
type SemanticDataset = Pick<HolidayDatasetSnapshot, "country" | "source" | "year" | "coverageFrom" | "coverageUntil" | "dates">;

/** Dates/names use JavaScript UTF-16 lexicographic ordering. Revision/fetchedAt are deliberately excluded. */
export function holidayDatasetPayloadHash(dataset: SemanticDataset): string {
  return canonicalPayloadHash({ country: dataset.country, source: dataset.source, year: dataset.year,
    coverageFrom: dataset.coverageFrom, coverageUntil: dataset.coverageUntil, dates: dataset.dates });
}

@Injectable()
export class HolidayDatasetService implements OnModuleInit, OnModuleDestroy {
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private cycle: Promise<void> | undefined;
  private readonly inFlight = new Map<number, Promise<HolidayRefreshResult>>();
  private readonly aborts = new Set<AbortController>();

  constructor(private readonly prisma: PrismaService, private readonly clock: AutomationClock,
    private readonly snapshots: AutomationSnapshotService,
    @Optional() @Inject(HOLIDAY_PROVIDER) private readonly provider?: HolidayProvider,
    @Optional() @Inject(HOLIDAY_DATASET_PROMOTION) private readonly promotion?: HolidayDatasetPromotion) {}

  async onModuleInit(): Promise<void> { if (!this.stopped && !this.cycle && !this.timer) await this.runCycle(); }
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const abort of this.aborts) abort.abort();
    await Promise.allSettled([...this.inFlight.values(), ...(this.cycle ? [this.cycle] : [])]);
  }

  refreshYear(year: number): Promise<HolidayRefreshResult> {
    if (!validYear(year)) return Promise.resolve({ status: "failed", revision: null, reason: "holiday_year_invalid" });
    const existing = this.inFlight.get(year);
    if (existing) return existing;
    const refresh = this.refresh(year).finally(() => { this.inFlight.delete(year); });
    this.inFlight.set(year, refresh);
    return refresh;
  }

  /** Optional transaction lets snapshot consumers share a consistent locked revision without nested DI. */
  async loadCoverage(from: string, to: string, tx?: Prisma.TransactionClient): Promise<HolidayDatasetSnapshot[]> {
    coverageYears(from, to);
    try {
      return await (tx ? loadHolidayCoverage(tx, from, to) : this.prisma.$transaction(client => loadHolidayCoverage(client, from, to),
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }));
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof ConflictException || error instanceof ServiceUnavailableException) throw error;
      throw storageUnavailable();
    }
  }

  private async runCycle(): Promise<void> {
    const cycle = (async () => {
      // Korean public holidays follow the Korean civil year, independently of server timezone.
      const year = Number(new Intl.DateTimeFormat("en", { timeZone: "Asia/Seoul", year: "numeric" }).format(this.clock.now()));
      for (const target of [year, year + 1]) { if (!this.stopped) await this.refreshYear(target); }
    })();
    this.cycle = cycle;
    try { await cycle; } finally {
      this.cycle = undefined;
      if (!this.stopped) {
        this.timer = setTimeout(() => { this.timer = undefined; void this.runCycle(); }, 86_400_000);
        this.timer.unref?.();
      }
    }
  }

  private async refresh(year: number): Promise<HolidayRefreshResult> {
    const abort = new AbortController();
    this.aborts.add(abort);
    try {
      if (this.stopped) throw new Error("holiday_refresh_stopped");
      if (!this.provider) throw new Error("holiday_provider_unavailable");
      const dates = new Map<string, Set<string>>();
      const proof: MonthProof[] = [];
      for (let month = 1; month <= 12; month++) {
        const seenRows = new Set<string>();
        let first: HolidayProviderPage | undefined;
        const pages: MonthProof["pages"] = [];
        let pageCount = 1;
        for (let page = 1; page <= pageCount; page++) {
          if (abort.signal.aborted || this.stopped) throw new Error("holiday_refresh_stopped");
          const result = await abortable(this.provider.fetchMonth({ year, month, page }, abort.signal), abort.signal);
          validatePage(result, year, month, page, first);
          first ??= result;
          pageCount = Math.max(1, Math.ceil(first.totalCount / first.numOfRows));
          pages.push({ page, itemCount: result.items.length });
          for (const row of result.items) {
            const identity = JSON.stringify([row.date, row.name.trim(), row.isHoliday]);
            if (seenRows.has(identity)) throw new Error("holiday_provider_invalid_response");
            seenRows.add(identity);
            if (!row.isHoliday) continue;
            const names = dates.get(row.date) ?? new Set<string>();
            names.add(row.name.trim());
            dates.set(row.date, names);
          }
        }
        if (!first || seenRows.size !== first.totalCount) throw new Error("holiday_provider_invalid_response");
        proof.push({ month, totalCount: first.totalCount, pageCount, numOfRows: first.numOfRows, pages });
      }
      // KR has public holidays every year. A completely empty future/source year
      // cannot prove coverage even if all twelve individual empty months are valid.
      if (dates.size === 0) throw new Error("holiday_provider_unavailable");
      const prefix = String(year).padStart(4, "0");
      const semantic: SemanticDataset = { country: "KR", source: "kasi", year, coverageFrom: `${prefix}-01-01`, coverageUntil: `${prefix}-12-31`,
        dates: [...dates].sort(([a], [b]) => compare(a, b)).map(([date, names]) => ({ date, names: [...names].sort(compare) })) };
      const dataset = holidayDatasetSnapshotSchema.parse({ ...semantic, revision: randomUUID(), fetchedAt: this.clock.now().toISOString(),
        payloadHash: holidayDatasetPayloadHash(semantic) });
      return await this.prisma.$transaction(async tx => {
        // Always acquire the shared mutation lock before any holiday row/pointer locks.
        await this.snapshots.lockMutation(tx);
        if (abort.signal.aborted || this.stopped) throw new Error("holiday_refresh_stopped");
        const current = await tx.holidayYearCoverage.findUnique({ where: { country_year: { country: "KR", year } }, include: { dataset: true } });
        const verified = current && verifiedSnapshot(current.dataset);
        if (verified?.payloadHash === dataset.payloadHash) return { status: "unchanged", revision: verified.revision, reason: null };
        const row = await tx.holidayDataset.create({ data: { ...dataset, coverageFrom: new Date(`${dataset.coverageFrom}T00:00:00Z`),
          coverageUntil: new Date(`${dataset.coverageUntil}T00:00:00Z`), fetchedAt: new Date(dataset.fetchedAt),
          dates: dataset.dates, completenessProof: proof, complete: true } });
        await tx.holidayYearCoverage.upsert({ where: { country_year: { country: "KR", year } },
          create: { country: "KR", year, datasetId: row.id, complete: true }, update: { datasetId: row.id, complete: true } });
        await this.promotion?.onPromoted(tx, dataset);
        if (abort.signal.aborted || this.stopped) throw new Error("holiday_refresh_stopped");
        return { status: "promoted", revision: dataset.revision, reason: null };
      });
    } catch (error) {
      // Return only allowlisted reasons, including when database/hook errors contain sensitive data.
      const message = error instanceof Error ? error.message : "";
      const reason = ["holiday_refresh_stopped", "holiday_provider_unavailable", "holiday_provider_invalid_response"].includes(message)
        ? message : "holiday_refresh_failed";
      let revision: string | null = null;
      try {
        const current = await this.prisma.holidayYearCoverage.findUnique({ where: { country_year: { country: "KR", year } }, include: { dataset: true } });
        revision = current ? verifiedSnapshot(current.dataset)?.revision ?? null : null;
      } catch { /* An unavailable DB cannot turn an unverified pointer into a verified cache. */ }
      return { status: "failed", revision, reason };
    } finally { this.aborts.delete(abort); }
  }
}

/** Pure transaction reader: SnapshotService can consume this without reverse service injection. */
export async function loadHolidayCoverage(tx: Prisma.TransactionClient, from: string, to: string): Promise<HolidayDatasetSnapshot[]> {
  const { first, last } = coverageYears(from, to);
  const coverage = await tx.holidayYearCoverage.findMany({ where: { country: "KR", year: { gte: first, lte: last }, complete: true },
    include: { dataset: true }, orderBy: { year: "asc" } }).catch(() => { throw storageUnavailable(); });
  if (coverage.length !== last - first + 1) throw unavailable();
  return coverage.map(entry => {
    const dataset = verifiedSnapshot(entry.dataset);
    if (!dataset || dataset.year !== entry.year) throw unavailable();
    return dataset;
  });
}

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function unavailable() { return new ConflictException({ code: "holiday_coverage_unavailable", message: "verified Korean holiday coverage required" }); }
function storageUnavailable() { return new ServiceUnavailableException({ code: "holiday_storage_unavailable", message: "holiday coverage storage unavailable" }); }
function coverageYears(from: string, to: string) {
  if (!validCivilDate(from) || !validCivilDate(to) || from > to) throw new BadRequestException("invalid holiday coverage range");
  const first = Number(from.slice(0, 4)), last = Number(to.slice(0, 4));
  if (first < 1 || last > 9999) throw new BadRequestException("invalid holiday coverage range");
  return { first, last };
}
function validatePage(result: HolidayProviderPage, year: number, month: number, page: number, first?: HolidayProviderPage) {
  const invalid = () => { throw new Error("holiday_provider_invalid_response"); };
  if (!result || result.year !== year || result.month !== month || result.page !== page
    || !integer(result.numOfRows, 1, 1000) || !integer(result.totalCount, 0, 10_000) || !Array.isArray(result.items)
    || (first && (result.numOfRows !== first.numOfRows || result.totalCount !== first.totalCount))) invalid();
  const expected = Math.min(result.numOfRows, Math.max(0, result.totalCount - (page - 1) * result.numOfRows));
  if (result.items.length !== expected) invalid();
  const prefix = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-`;
  for (const row of result.items) if (!row || !validCivilDate(row.date) || !row.date.startsWith(prefix)
    || typeof row.name !== "string" || !row.name.trim() || typeof row.isHoliday !== "boolean") invalid();
}
function verifiedSnapshot(row: HolidayDataset): HolidayDatasetSnapshot | null {
  try {
    const snapshot = holidayDatasetSnapshotSchema.parse({ country: row.country, source: row.source, year: row.year,
      revision: row.revision, fetchedAt: row.fetchedAt.toISOString(), coverageFrom: row.coverageFrom.toISOString().slice(0, 10),
      coverageUntil: row.coverageUntil.toISOString().slice(0, 10), payloadHash: row.payloadHash, dates: row.dates });
    const proof = row.completenessProof as unknown as MonthProof[];
    if (!row.complete || snapshot.dates.length === 0 || !Array.isArray(proof) || proof.length !== 12 || holidayDatasetPayloadHash(snapshot) !== snapshot.payloadHash
      || snapshot.dates.some((entry, index) => (index > 0 && compare(snapshot.dates[index - 1].date, entry.date) >= 0)
        || entry.names.some((name, i) => i > 0 && compare(entry.names[i - 1], name) >= 0))) return null;
    for (let index = 0; index < 12; index++) {
      const month = proof[index];
      if (!month || month.month !== index + 1 || !integer(month.totalCount, 0, 10_000) || !integer(month.numOfRows, 1, 1000)
        || month.pageCount !== Math.max(1, Math.ceil(month.totalCount / month.numOfRows))
        || !Array.isArray(month.pages) || month.pages.length !== month.pageCount) return null;
      if (month.pages.some((page, i) => page.page !== i + 1
        || page.itemCount !== Math.min(month.numOfRows, Math.max(0, month.totalCount - i * month.numOfRows)))) return null;
      const namesInMonth = snapshot.dates.filter(entry => Number(entry.date.slice(5, 7)) === month.month)
        .reduce((count, entry) => count + entry.names.length, 0);
      if (namesInMonth > month.totalCount) return null;
    }
    return snapshot;
  } catch { return null; }
}
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel: (() => void) | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      cancel = () => reject(new Error("holiday_refresh_stopped"));
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
    })]);
  } finally { if (cancel) signal.removeEventListener("abort", cancel); }
}
