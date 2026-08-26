import { Prisma } from "@prisma/client";

const KNOWN_STATE_WINDOW_MS = 180_000;
const KWH_MILLISECOND_DIVISOR = new Prisma.Decimal(3_600_000_000);

export interface FixtureEnergySnapshot {
  energyTrackingStartedAt: Date;
  firstStateOccurredAt: Date | null;
  lastStateEventId: string | null;
  lastStateSequence: bigint | null;
  lastStateOccurredAt: Date | null;
  brightness: number;
  powerOn: boolean | null;
  ratedWatt: Prisma.Decimal;
}

export interface IncomingFixtureEnergyState {
  eventId: string;
  sequence: bigint;
  occurredAt: Date;
  brightness: number;
  powerOn: boolean;
}

export interface FixtureEnergyDailyDelta {
  localDate: Date;
  estimatedKwh: Prisma.Decimal;
  estimatedCost: Prisma.Decimal;
  knownSeconds: number;
  unknownSeconds: number;
}

export type FixtureStateTransitionStatus = "accepted" | "duplicate" | "stale_sequence" | "reverse_time";

export interface FixtureStateTransitionResult {
  status: FixtureStateTransitionStatus;
  dailyDeltas: FixtureEnergyDailyDelta[];
  nextSnapshot: FixtureEnergySnapshot;
}

interface AggregationContext {
  timeZone: string;
  tariffKwhRate: Prisma.Decimal;
}

interface MutableDailyDelta extends FixtureEnergyDailyDelta {}

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
}

export function aggregateFixtureStateTransition(input: {
  snapshot: FixtureEnergySnapshot;
  event: IncomingFixtureEnergyState;
  timeZone: string;
  tariffKwhRate: Prisma.Decimal;
}): FixtureStateTransitionResult {
  const { snapshot, event } = input;
  validateSnapshot(snapshot);
  validateIncomingState(event);
  const context = createContext(input.timeZone, input.tariffKwhRate);

  if (snapshot.lastStateEventId === event.eventId) {
    return rejectedTransition("duplicate", snapshot);
  }
  if (snapshot.lastStateSequence !== null && event.sequence <= snapshot.lastStateSequence) {
    return rejectedTransition("stale_sequence", snapshot);
  }
  if (snapshot.lastStateOccurredAt && event.occurredAt < snapshot.lastStateOccurredAt) {
    return rejectedTransition("reverse_time", snapshot);
  }

  const accumulator = new Map<string, MutableDailyDelta>();
  if (!snapshot.lastStateOccurredAt) {
    addUnknownInterval(accumulator, snapshot.energyTrackingStartedAt, event.occurredAt, context);
  } else {
    addObservedInterval(
      accumulator,
      snapshot.lastStateOccurredAt,
      event.occurredAt,
      snapshot.ratedWatt,
      snapshot.powerOn ? snapshot.brightness : 0,
      context
    );
  }

  return {
    status: "accepted",
    dailyDeltas: sortedDeltas(accumulator),
    nextSnapshot: {
      ...snapshot,
      firstStateOccurredAt: snapshot.firstStateOccurredAt ?? event.occurredAt,
      lastStateEventId: event.eventId,
      lastStateSequence: event.sequence,
      lastStateOccurredAt: event.occurredAt,
      brightness: event.brightness,
      powerOn: event.powerOn
    }
  };
}

export function projectOpenFixtureEnergy(input: {
  snapshot: FixtureEnergySnapshot;
  generatedAt: Date;
  timeZone: string;
  tariffKwhRate: Prisma.Decimal;
}): FixtureEnergyDailyDelta[] {
  validateSnapshot(input.snapshot);
  validateDate(input.generatedAt, "generatedAt");
  const context = createContext(input.timeZone, input.tariffKwhRate);
  const accumulator = new Map<string, MutableDailyDelta>();

  if (!input.snapshot.lastStateOccurredAt) {
    addUnknownInterval(accumulator, input.snapshot.energyTrackingStartedAt, input.generatedAt, context);
  } else {
    addObservedInterval(
      accumulator,
      input.snapshot.lastStateOccurredAt,
      input.generatedAt,
      input.snapshot.ratedWatt,
      input.snapshot.powerOn ? input.snapshot.brightness : 0,
      context
    );
  }

  return sortedDeltas(accumulator);
}

function rejectedTransition(
  status: Exclude<FixtureStateTransitionStatus, "accepted">,
  snapshot: FixtureEnergySnapshot
): FixtureStateTransitionResult {
  return { status, dailyDeltas: [], nextSnapshot: snapshot };
}

function addObservedInterval(
  accumulator: Map<string, MutableDailyDelta>,
  start: Date,
  end: Date,
  ratedWatt: Prisma.Decimal,
  effectiveBrightness: number,
  context: AggregationContext
) {
  if (end <= start) return;

  const knownEnd = new Date(Math.min(end.getTime(), start.getTime() + KNOWN_STATE_WINDOW_MS));
  addKnownInterval(accumulator, start, knownEnd, ratedWatt, effectiveBrightness, context);
  addUnknownInterval(accumulator, knownEnd, end, context);
}

function addKnownInterval(
  accumulator: Map<string, MutableDailyDelta>,
  start: Date,
  end: Date,
  ratedWatt: Prisma.Decimal,
  effectiveBrightness: number,
  context: AggregationContext
) {
  for (const part of splitByLocalDay(start, end, context.timeZone)) {
    const delta = getOrCreateDelta(accumulator, part.localDate);
    const durationMs = part.end.getTime() - part.start.getTime();
    const kwh = ratedWatt
      .mul(effectiveBrightness)
      .div(100)
      .mul(durationMs)
      .div(KWH_MILLISECOND_DIVISOR);

    delta.knownSeconds += wholeSeconds(durationMs);
    delta.estimatedKwh = delta.estimatedKwh.add(kwh);
    delta.estimatedCost = delta.estimatedCost.add(kwh.mul(context.tariffKwhRate));
  }
}

function addUnknownInterval(
  accumulator: Map<string, MutableDailyDelta>,
  start: Date,
  end: Date,
  context: AggregationContext
) {
  for (const part of splitByLocalDay(start, end, context.timeZone)) {
    const delta = getOrCreateDelta(accumulator, part.localDate);
    delta.unknownSeconds += wholeSeconds(part.end.getTime() - part.start.getTime());
  }
}

function splitByLocalDay(start: Date, end: Date, timeZone: string) {
  if (end <= start) return [];

  const formatter = createDateFormatter(timeZone);
  const parts: Array<{ localDate: string; start: Date; end: Date }> = [];
  let cursor = new Date(start);

  while (cursor < end) {
    const localDate = formatLocalDate(cursor, formatter);
    const nextDate = addCalendarDays(parseLocalDate(localDate), 1);
    const nextBoundary = findStartOfLocalDate(nextDate, formatter);
    const partEnd = new Date(Math.min(end.getTime(), nextBoundary.getTime()));

    if (partEnd <= cursor) {
      throw new Error(`could not advance local day boundary for ${timeZone}`);
    }
    parts.push({ localDate, start: cursor, end: partEnd });
    cursor = partEnd;
  }

  return parts;
}

function findStartOfLocalDate(target: LocalDateParts, formatter: Intl.DateTimeFormat): Date {
  let candidate = target;

  // Some zones have historically skipped a local calendar date. The next existing
  // local date is the correct boundary for the preceding interval in that case.
  for (let skippedDays = 0; skippedDays < 3; skippedDays += 1) {
    const targetKey = localDateKey(candidate);
    const naiveUtc = Date.UTC(candidate.year, candidate.month - 1, candidate.day);
    let low = naiveUtc - 36 * 60 * 60 * 1000;
    let high = naiveUtc + 36 * 60 * 60 * 1000;

    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (formatLocalDate(new Date(middle), formatter) < targetKey) low = middle + 1;
      else high = middle;
    }

    if (formatLocalDate(new Date(low), formatter) === targetKey) return new Date(low);
    candidate = addCalendarDays(candidate, 1);
  }

  throw new Error(`could not resolve local date boundary ${localDateKey(target)}`);
}

function getOrCreateDelta(accumulator: Map<string, MutableDailyDelta>, localDate: string) {
  const existing = accumulator.get(localDate);
  if (existing) return existing;

  const created: MutableDailyDelta = {
    localDate: new Date(`${localDate}T00:00:00.000Z`),
    estimatedKwh: new Prisma.Decimal(0),
    estimatedCost: new Prisma.Decimal(0),
    knownSeconds: 0,
    unknownSeconds: 0
  };
  accumulator.set(localDate, created);
  return created;
}

function sortedDeltas(accumulator: Map<string, MutableDailyDelta>) {
  return [...accumulator.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, delta]) => delta)
    .filter((delta) => delta.knownSeconds > 0 || delta.unknownSeconds > 0 || !delta.estimatedKwh.isZero());
}

function wholeSeconds(durationMs: number) {
  return Math.floor(durationMs / 1000);
}

function createContext(timeZone: string, tariffKwhRate: Prisma.Decimal): AggregationContext {
  createDateFormatter(timeZone);
  if (tariffKwhRate.isNegative()) throw new RangeError("tariffKwhRate must not be negative");
  return { timeZone, tariffKwhRate };
}

function createDateFormatter(timeZone: string) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
  } catch {
    throw new RangeError(`invalid IANA time zone: ${timeZone}`);
  }
}

function formatLocalDate(date: Date, formatter: Intl.DateTimeFormat) {
  const values = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type === "year" || part.type === "month" || part.type === "day")
      .map((part) => [part.type, part.value])
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function parseLocalDate(value: string): LocalDateParts {
  const [year, month, day] = value.split("-").map(Number);
  return { year, month, day };
}

function localDateKey(parts: LocalDateParts) {
  return `${parts.year.toString().padStart(4, "0")}-${parts.month.toString().padStart(2, "0")}-${parts.day
    .toString()
    .padStart(2, "0")}`;
}

function addCalendarDays(parts: LocalDateParts, days: number): LocalDateParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function validateSnapshot(snapshot: FixtureEnergySnapshot) {
  validateDate(snapshot.energyTrackingStartedAt, "energyTrackingStartedAt");
  if (snapshot.firstStateOccurredAt) validateDate(snapshot.firstStateOccurredAt, "firstStateOccurredAt");
  if (snapshot.lastStateOccurredAt) validateDate(snapshot.lastStateOccurredAt, "lastStateOccurredAt");
  validateBrightness(snapshot.brightness);
  if (snapshot.ratedWatt.isNegative()) throw new RangeError("ratedWatt must not be negative");
}

function validateIncomingState(event: IncomingFixtureEnergyState) {
  if (!event.eventId) throw new RangeError("eventId must not be empty");
  if (event.sequence < 0n) throw new RangeError("sequence must not be negative");
  validateDate(event.occurredAt, "occurredAt");
  validateBrightness(event.brightness);
}

function validateBrightness(brightness: number) {
  if (!Number.isInteger(brightness) || brightness < 0 || brightness > 100) {
    throw new RangeError("brightness must be an integer between 0 and 100");
  }
}

function validateDate(date: Date, field: string) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new RangeError(`${field} must be a valid Date`);
}
