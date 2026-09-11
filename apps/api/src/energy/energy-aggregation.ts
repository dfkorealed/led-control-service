import { Prisma } from "@prisma/client";
import { splitEnergyIntervalByUtcHour, type HourlyEnergyDelta } from "./energy-hourly-aggregation";

const KNOWN_STATE_WINDOW_MS = 180_000;
const KWH_MILLISECOND_DIVISOR = new Prisma.Decimal(3_600_000_000);
const MILLISECONDS_PER_SECOND = 1_000;

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

export interface FixtureEnergyDurationRemainder {
  localDate: string;
  knownMilliseconds: number;
  unknownMilliseconds: number;
}

export interface FixtureEnergyCheckpoint {
  aggregatedThrough: Date;
  observedStateOccurredAt: Date | null;
  brightness: number;
  powerOn: boolean | null;
  ratedWatt: Prisma.Decimal;
  durationRemainders: FixtureEnergyDurationRemainder[];
}

export interface FixtureEnergyDailyDelta {
  localDate: Date;
  estimatedKwh: Prisma.Decimal;
  estimatedCost: Prisma.Decimal;
  knownDurationSeconds: Prisma.Decimal;
  unknownDurationSeconds: Prisma.Decimal;
  knownSeconds: number;
  unknownSeconds: number;
}

export type RejectedFixtureStateTransitionStatus =
  | "duplicate"
  | "stale_sequence"
  | "reverse_time"
  | "stale_checkpoint";
export type FixtureStateTransitionStatus = "accepted" | RejectedFixtureStateTransitionStatus;

export interface AcceptedFixtureStateTransitionResult {
  status: "accepted";
  dailyDeltas: FixtureEnergyDailyDelta[];
  hourlyDeltas: HourlyEnergyDelta[];
  nextSnapshot: FixtureEnergySnapshot;
  nextCheckpoint: FixtureEnergyCheckpoint;
}

export interface RejectedFixtureStateTransitionResult {
  status: RejectedFixtureStateTransitionStatus;
  dailyDeltas: [];
  hourlyDeltas: [];
  nextSnapshot: FixtureEnergySnapshot;
  nextCheckpoint: FixtureEnergyCheckpoint;
}

export type FixtureStateTransitionResult =
  | AcceptedFixtureStateTransitionResult
  | RejectedFixtureStateTransitionResult;

export interface FixtureEnergyProjectionResult {
  dailyDeltas: FixtureEnergyDailyDelta[];
  hourlyDeltas: HourlyEnergyDelta[];
  sourceCheckpoint: FixtureEnergyCheckpoint;
  boundary: {
    projectedFrom: Date;
    projectedThrough: Date;
    checkpointAggregatedThrough: Date;
    ratedWattSnapshot: Prisma.Decimal;
  };
}

interface AggregationContext {
  timeZone: string;
  tariffKwhRate: Prisma.Decimal;
}

interface MutableDailyDelta extends FixtureEnergyDailyDelta {}

interface MutableDurationRemainder {
  knownMilliseconds: number;
  unknownMilliseconds: number;
}

interface EnergyAccumulator {
  dailyDeltas: Map<string, MutableDailyDelta>;
  hourlyDeltas: Map<string, HourlyEnergyDelta>;
  durationRemainders: Map<string, MutableDurationRemainder>;
}

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
}

interface LocalDayPart {
  localDate: string;
  start: Date;
  end: Date;
  closesLocalDay: boolean;
}

export function createInitialFixtureEnergyCheckpoint(snapshot: FixtureEnergySnapshot): FixtureEnergyCheckpoint {
  validateSnapshot(snapshot);
  const observedAt = snapshot.lastStateOccurredAt;
  return {
    aggregatedThrough: new Date(
      Math.max(snapshot.energyTrackingStartedAt.getTime(), observedAt?.getTime() ?? snapshot.energyTrackingStartedAt.getTime())
    ),
    observedStateOccurredAt: observedAt ? new Date(observedAt) : null,
    brightness: snapshot.brightness,
    powerOn: snapshot.powerOn,
    ratedWatt: new Prisma.Decimal(snapshot.ratedWatt),
    durationRemainders: []
  };
}

export function aggregateFixtureStateTransition(input: {
  snapshot: FixtureEnergySnapshot;
  checkpoint: FixtureEnergyCheckpoint;
  event: IncomingFixtureEnergyState;
  timeZone: string;
  tariffKwhRate: Prisma.Decimal;
}): FixtureStateTransitionResult {
  const { snapshot, checkpoint, event } = input;
  validateSnapshot(snapshot);
  validateCheckpoint(checkpoint, snapshot);
  validateIncomingState(event);
  const context = createContext(input.timeZone, input.tariffKwhRate);

  if (snapshot.lastStateEventId === event.eventId) return rejectedTransition("duplicate", snapshot, checkpoint);
  if (snapshot.lastStateSequence !== null && event.sequence <= snapshot.lastStateSequence) {
    return rejectedTransition("stale_sequence", snapshot, checkpoint);
  }
  if (snapshot.lastStateOccurredAt && event.occurredAt < snapshot.lastStateOccurredAt) {
    return rejectedTransition("reverse_time", snapshot, checkpoint);
  }
  if (event.occurredAt < checkpoint.aggregatedThrough) {
    return rejectedTransition("stale_checkpoint", snapshot, checkpoint);
  }

  const accumulator = createAccumulator(checkpoint);
  const intervalEnd = new Date(Math.max(checkpoint.aggregatedThrough.getTime(), event.occurredAt.getTime()));
  addCheckpointInterval(accumulator, checkpoint, checkpoint.aggregatedThrough, intervalEnd, context);

  const nextSnapshot: FixtureEnergySnapshot = {
    ...snapshot,
    firstStateOccurredAt: snapshot.firstStateOccurredAt ?? event.occurredAt,
    lastStateEventId: event.eventId,
    lastStateSequence: event.sequence,
    lastStateOccurredAt: event.occurredAt,
    brightness: event.brightness,
    powerOn: event.powerOn
  };
  const nextCheckpoint: FixtureEnergyCheckpoint = {
    aggregatedThrough: intervalEnd,
    observedStateOccurredAt: new Date(event.occurredAt),
    brightness: event.brightness,
    powerOn: event.powerOn,
    ratedWatt: new Prisma.Decimal(snapshot.ratedWatt),
    durationRemainders: serializeRemainders(accumulator)
  };

  return {
    status: "accepted",
    dailyDeltas: sortedDeltas(accumulator),
    hourlyDeltas: sortedHourlyDeltas(accumulator),
    nextSnapshot,
    nextCheckpoint
  };
}

export function closeFixtureEnergyCheckpoint(input: {
  snapshot: FixtureEnergySnapshot;
  checkpoint: FixtureEnergyCheckpoint;
  closedAt: Date;
  nextRatedWatt: Prisma.Decimal;
  timeZone: string;
  tariffKwhRate: Prisma.Decimal;
}) {
  validateSnapshot(input.snapshot);
  validateCheckpoint(input.checkpoint, input.snapshot);
  validateDate(input.closedAt, "closedAt");
  validateNonNegativeDecimal(input.nextRatedWatt, "nextRatedWatt");
  if (input.closedAt < input.checkpoint.aggregatedThrough) {
    throw new RangeError("closedAt must not precede the persisted energy checkpoint");
  }

  const context = createContext(input.timeZone, input.tariffKwhRate);
  const accumulator = createAccumulator(input.checkpoint);
  addCheckpointInterval(accumulator, input.checkpoint, input.checkpoint.aggregatedThrough, input.closedAt, context);

  return {
    dailyDeltas: sortedDeltas(accumulator),
    hourlyDeltas: sortedHourlyDeltas(accumulator),
    nextCheckpoint: {
      ...cloneCheckpoint(input.checkpoint),
      aggregatedThrough: new Date(input.closedAt),
      ratedWatt: new Prisma.Decimal(input.nextRatedWatt),
      durationRemainders: serializeRemainders(accumulator)
    }
  };
}

export function projectOpenFixtureEnergy(input: {
  snapshot: FixtureEnergySnapshot;
  checkpoint: FixtureEnergyCheckpoint;
  queryStartedAt: Date;
  generatedAt: Date;
  timeZone: string;
  tariffKwhRate: Prisma.Decimal;
}): FixtureEnergyProjectionResult {
  validateSnapshot(input.snapshot);
  validateCheckpoint(input.checkpoint, input.snapshot);
  validateDate(input.queryStartedAt, "queryStartedAt");
  validateDate(input.generatedAt, "generatedAt");

  const context = createContext(input.timeZone, input.tariffKwhRate);
  const accumulator = createAccumulator(input.checkpoint);
  const requestedStart = Math.max(
    input.queryStartedAt.getTime(),
    input.snapshot.energyTrackingStartedAt.getTime(),
    input.checkpoint.aggregatedThrough.getTime()
  );
  const projectedFrom = new Date(Math.min(requestedStart, input.generatedAt.getTime()));
  addCheckpointInterval(accumulator, input.checkpoint, projectedFrom, input.generatedAt, context);
  finalizeProjectionRemainders(accumulator);

  return {
    dailyDeltas: sortedDeltas(accumulator),
    hourlyDeltas: sortedHourlyDeltas(accumulator),
    sourceCheckpoint: cloneCheckpoint(input.checkpoint),
    boundary: {
      projectedFrom,
      projectedThrough: new Date(input.generatedAt),
      checkpointAggregatedThrough: new Date(input.checkpoint.aggregatedThrough),
      ratedWattSnapshot: new Prisma.Decimal(input.checkpoint.ratedWatt)
    }
  };
}

function rejectedTransition(
  status: RejectedFixtureStateTransitionStatus,
  snapshot: FixtureEnergySnapshot,
  checkpoint: FixtureEnergyCheckpoint
): RejectedFixtureStateTransitionResult {
  return { status, dailyDeltas: [], hourlyDeltas: [], nextSnapshot: snapshot, nextCheckpoint: cloneCheckpoint(checkpoint) };
}

function addCheckpointInterval(
  accumulator: EnergyAccumulator,
  checkpoint: FixtureEnergyCheckpoint,
  start: Date,
  end: Date,
  context: AggregationContext
) {
  if (end <= start) return;
  if (!checkpoint.observedStateOccurredAt) {
    addUnknownInterval(accumulator, start, end, context);
    return;
  }

  const knownDeadline = checkpoint.observedStateOccurredAt.getTime() + KNOWN_STATE_WINDOW_MS;
  const knownEnd = new Date(Math.min(end.getTime(), knownDeadline));
  if (start < knownEnd) {
    addKnownInterval(
      accumulator,
      start,
      knownEnd,
      checkpoint.ratedWatt,
      checkpoint.powerOn ? checkpoint.brightness : 0,
      context
    );
  }
  addUnknownInterval(accumulator, new Date(Math.max(start.getTime(), knownDeadline)), end, context);
}

function addKnownInterval(
  accumulator: EnergyAccumulator,
  start: Date,
  end: Date,
  ratedWatt: Prisma.Decimal,
  effectiveBrightness: number,
  context: AggregationContext
) {
  mergeHourlyDeltas(accumulator, splitEnergyIntervalByUtcHour({
    from: start,
    to: end,
    brightness: effectiveBrightness,
    ratedWatt,
    timeZone: context.timeZone,
    known: true
  }));
  for (const part of splitByLocalDay(start, end, context.timeZone)) {
    const durationMs = part.end.getTime() - part.start.getTime();
    const delta = getOrCreateDelta(accumulator, part.localDate);
    const kwh = ratedWatt
      .mul(effectiveBrightness)
      .div(100)
      .mul(durationMs)
      .div(KWH_MILLISECOND_DIVISOR);

    delta.knownDurationSeconds = delta.knownDurationSeconds.add(decimalSeconds(durationMs));
    consumeDurationMilliseconds(accumulator, delta, part, "known", durationMs);
    delta.estimatedKwh = delta.estimatedKwh.add(kwh);
    delta.estimatedCost = delta.estimatedCost.add(kwh.mul(context.tariffKwhRate));
  }
}

function addUnknownInterval(
  accumulator: EnergyAccumulator,
  start: Date,
  end: Date,
  context: AggregationContext
) {
  mergeHourlyDeltas(accumulator, splitEnergyIntervalByUtcHour({
    from: start,
    to: end,
    brightness: 0,
    ratedWatt: new Prisma.Decimal(0),
    timeZone: context.timeZone,
    known: false
  }));
  for (const part of splitByLocalDay(start, end, context.timeZone)) {
    const durationMs = part.end.getTime() - part.start.getTime();
    const delta = getOrCreateDelta(accumulator, part.localDate);
    delta.unknownDurationSeconds = delta.unknownDurationSeconds.add(decimalSeconds(durationMs));
    consumeDurationMilliseconds(accumulator, delta, part, "unknown", durationMs);
  }
}

function consumeDurationMilliseconds(
  accumulator: EnergyAccumulator,
  delta: MutableDailyDelta,
  part: LocalDayPart,
  kind: "known" | "unknown",
  durationMs: number
) {
  const remainder = getOrCreateRemainder(accumulator, part.localDate);
  const field = kind === "known" ? "knownMilliseconds" : "unknownMilliseconds";
  const secondsField = kind === "known" ? "knownSeconds" : "unknownSeconds";
  const totalMilliseconds = remainder[field] + durationMs;

  if (part.closesLocalDay) {
    remainder[field] = 0;
    delta[secondsField] += roundMillisecondsToSeconds(totalMilliseconds);

    const otherField = kind === "known" ? "unknownMilliseconds" : "knownMilliseconds";
    const otherSecondsField = kind === "known" ? "unknownSeconds" : "knownSeconds";
    delta[otherSecondsField] += roundMillisecondsToSeconds(remainder[otherField]);
    remainder[otherField] = 0;
    return;
  }
  remainder[field] = totalMilliseconds % MILLISECONDS_PER_SECOND;
  delta[secondsField] += Math.floor(totalMilliseconds / MILLISECONDS_PER_SECOND);
}

function finalizeProjectionRemainders(accumulator: EnergyAccumulator) {
  for (const [localDate, delta] of accumulator.dailyDeltas) {
    const remainder = accumulator.durationRemainders.get(localDate);
    if (!remainder) continue;
    delta.knownSeconds += roundMillisecondsToSeconds(remainder.knownMilliseconds);
    delta.unknownSeconds += roundMillisecondsToSeconds(remainder.unknownMilliseconds);
  }
}

function splitByLocalDay(start: Date, end: Date, timeZone: string): LocalDayPart[] {
  if (end <= start) return [];
  const formatter = createDateFormatter(timeZone);
  const parts: LocalDayPart[] = [];
  let cursor = new Date(start);

  while (cursor < end) {
    const localDate = formatLocalDate(cursor, formatter);
    const nextDate = addCalendarDays(parseLocalDate(localDate), 1);
    const nextBoundary = findStartOfLocalDate(nextDate, formatter);
    const partEnd = new Date(Math.min(end.getTime(), nextBoundary.getTime()));

    if (partEnd <= cursor) throw new Error(`could not advance local day boundary for ${timeZone}`);
    parts.push({
      localDate,
      start: cursor,
      end: partEnd,
      closesLocalDay: partEnd.getTime() === nextBoundary.getTime()
    });
    cursor = partEnd;
  }
  return parts;
}

function findStartOfLocalDate(target: LocalDateParts, formatter: Intl.DateTimeFormat): Date {
  let candidate = target;

  // A few IANA zones historically skipped an entire local date. In that case the
  // next existing local date is the preceding interval's actual boundary.
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

function createAccumulator(checkpoint: FixtureEnergyCheckpoint): EnergyAccumulator {
  return {
    dailyDeltas: new Map(),
    hourlyDeltas: new Map(),
    durationRemainders: new Map(
      checkpoint.durationRemainders.map((remainder) => [
        remainder.localDate,
        {
          knownMilliseconds: remainder.knownMilliseconds,
          unknownMilliseconds: remainder.unknownMilliseconds
        }
      ])
    )
  };
}

function mergeHourlyDeltas(accumulator: EnergyAccumulator, deltas: HourlyEnergyDelta[]) {
  for (const delta of deltas) {
    const key = delta.bucketStartUtc.toISOString();
    const current = accumulator.hourlyDeltas.get(key);
    if (!current) {
      accumulator.hourlyDeltas.set(key, delta);
      continue;
    }
    current.estimatedKwh = current.estimatedKwh.add(delta.estimatedKwh);
    current.knownSeconds += delta.knownSeconds;
    current.unknownSeconds += delta.unknownSeconds;
    current.brightnessWeightedSeconds = current.brightnessWeightedSeconds.add(delta.brightnessWeightedSeconds);
  }
}

function sortedHourlyDeltas(accumulator: EnergyAccumulator) {
  return [...accumulator.hourlyDeltas.values()].sort(
    (left, right) => left.bucketStartUtc.getTime() - right.bucketStartUtc.getTime()
  );
}

function getOrCreateDelta(accumulator: EnergyAccumulator, localDate: string) {
  const existing = accumulator.dailyDeltas.get(localDate);
  if (existing) return existing;
  const created: MutableDailyDelta = {
    localDate: new Date(`${localDate}T00:00:00.000Z`),
    estimatedKwh: new Prisma.Decimal(0),
    estimatedCost: new Prisma.Decimal(0),
    knownDurationSeconds: new Prisma.Decimal(0),
    unknownDurationSeconds: new Prisma.Decimal(0),
    knownSeconds: 0,
    unknownSeconds: 0
  };
  accumulator.dailyDeltas.set(localDate, created);
  return created;
}

function getOrCreateRemainder(accumulator: EnergyAccumulator, localDate: string) {
  const existing = accumulator.durationRemainders.get(localDate);
  if (existing) return existing;
  const created = { knownMilliseconds: 0, unknownMilliseconds: 0 };
  accumulator.durationRemainders.set(localDate, created);
  return created;
}

function sortedDeltas(accumulator: EnergyAccumulator) {
  return [...accumulator.dailyDeltas.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, delta]) => delta)
    .filter(
      (delta) =>
        !delta.knownDurationSeconds.isZero() ||
        !delta.unknownDurationSeconds.isZero() ||
        !delta.estimatedKwh.isZero()
    );
}

function serializeRemainders(accumulator: EnergyAccumulator): FixtureEnergyDurationRemainder[] {
  return [...accumulator.durationRemainders.entries()]
    .filter(([, value]) => value.knownMilliseconds > 0 || value.unknownMilliseconds > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([localDate, value]) => ({ localDate, ...value }));
}

function decimalSeconds(durationMs: number) {
  return new Prisma.Decimal(durationMs).div(MILLISECONDS_PER_SECOND);
}

function roundMillisecondsToSeconds(milliseconds: number) {
  return Math.floor((milliseconds + MILLISECONDS_PER_SECOND / 2) / MILLISECONDS_PER_SECOND);
}

function createContext(timeZone: string, tariffKwhRate: Prisma.Decimal): AggregationContext {
  createDateFormatter(timeZone);
  validateNonNegativeDecimal(tariffKwhRate, "tariffKwhRate");
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

function cloneCheckpoint(checkpoint: FixtureEnergyCheckpoint): FixtureEnergyCheckpoint {
  return {
    aggregatedThrough: new Date(checkpoint.aggregatedThrough),
    observedStateOccurredAt: checkpoint.observedStateOccurredAt ? new Date(checkpoint.observedStateOccurredAt) : null,
    brightness: checkpoint.brightness,
    powerOn: checkpoint.powerOn,
    ratedWatt: new Prisma.Decimal(checkpoint.ratedWatt),
    durationRemainders: checkpoint.durationRemainders.map((remainder) => ({ ...remainder }))
  };
}

function validateCheckpoint(checkpoint: FixtureEnergyCheckpoint, snapshot: FixtureEnergySnapshot) {
  validateDate(checkpoint.aggregatedThrough, "checkpoint.aggregatedThrough");
  if (checkpoint.aggregatedThrough < snapshot.energyTrackingStartedAt) {
    throw new RangeError("energy checkpoint must not precede energyTrackingStartedAt");
  }
  if (checkpoint.observedStateOccurredAt) validateDate(checkpoint.observedStateOccurredAt, "checkpoint.observedStateOccurredAt");
  if (!sameInstant(checkpoint.observedStateOccurredAt, snapshot.lastStateOccurredAt)) {
    throw new RangeError("observed state differs from the persisted energy checkpoint");
  }
  if (checkpoint.brightness !== snapshot.brightness || checkpoint.powerOn !== snapshot.powerOn) {
    throw new RangeError("observed values differ from the persisted energy checkpoint");
  }
  if (!checkpoint.ratedWatt.eq(snapshot.ratedWatt)) {
    throw new RangeError("ratedWatt differs from the persisted energy checkpoint");
  }
  validateBrightness(checkpoint.brightness);
  validateNonNegativeDecimal(checkpoint.ratedWatt, "checkpoint.ratedWatt");

  const localDates = new Set<string>();
  for (const remainder of checkpoint.durationRemainders) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(remainder.localDate) || localDates.has(remainder.localDate)) {
      throw new RangeError("checkpoint duration remainder localDate must be unique YYYY-MM-DD");
    }
    localDates.add(remainder.localDate);
    validateRemainder(remainder.knownMilliseconds, "knownMilliseconds");
    validateRemainder(remainder.unknownMilliseconds, "unknownMilliseconds");
  }
}

function sameInstant(left: Date | null, right: Date | null) {
  return left === null || right === null ? left === right : left.getTime() === right.getTime();
}

function validateRemainder(value: number, field: string) {
  if (!Number.isInteger(value) || value < 0 || value >= MILLISECONDS_PER_SECOND) {
    throw new RangeError(`${field} must be an integer between 0 and 999`);
  }
}

function validateSnapshot(snapshot: FixtureEnergySnapshot) {
  validateDate(snapshot.energyTrackingStartedAt, "energyTrackingStartedAt");
  if (snapshot.firstStateOccurredAt) validateDate(snapshot.firstStateOccurredAt, "firstStateOccurredAt");
  if (snapshot.lastStateOccurredAt) validateDate(snapshot.lastStateOccurredAt, "lastStateOccurredAt");
  validateBrightness(snapshot.brightness);
  validateNonNegativeDecimal(snapshot.ratedWatt, "ratedWatt");
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

function validateNonNegativeDecimal(value: Prisma.Decimal, field: string) {
  if (value.isNegative()) throw new RangeError(`${field} must not be negative`);
}

function validateDate(date: Date, field: string) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new RangeError(`${field} must be a valid Date`);
}
