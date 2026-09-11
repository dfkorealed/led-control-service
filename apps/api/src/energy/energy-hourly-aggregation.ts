import { Prisma } from "@prisma/client";

const HOUR_MS = 3_600_000;
const KWH_MILLISECOND_DIVISOR = new Prisma.Decimal(3_600_000_000);

export interface HourlyEnergyDelta {
  bucketStartUtc: Date;
  localDate: Date;
  localHour: number;
  utcOffsetMinutes: number;
  estimatedKwh: Prisma.Decimal;
  knownSeconds: number;
  unknownSeconds: number;
  brightnessWeightedSeconds: Prisma.Decimal;
}

export function splitEnergyIntervalByUtcHour(input: {
  from: Date;
  to: Date;
  brightness: number;
  ratedWatt: Prisma.Decimal;
  timeZone: string;
  known: boolean;
}): HourlyEnergyDelta[] {
  if (input.to <= input.from) return [];
  const formatter = createFormatter(input.timeZone);
  const deltas: HourlyEnergyDelta[] = [];
  let cursor = new Date(input.from);

  while (cursor < input.to) {
    const bucketStartMs = Math.floor(cursor.getTime() / HOUR_MS) * HOUR_MS;
    const bucketStartUtc = new Date(bucketStartMs);
    const partEnd = new Date(Math.min(input.to.getTime(), bucketStartMs + HOUR_MS));
    const durationMs = partEnd.getTime() - cursor.getTime();
    const durationSeconds = new Prisma.Decimal(durationMs).div(1_000);
    const local = localParts(bucketStartUtc, formatter);
    const offsetMinutes = Math.round(
      (Date.UTC(local.year, local.month - 1, local.day, local.hour) - bucketStartUtc.getTime()) / 60_000
    );
    const estimatedKwh = input.known
      ? input.ratedWatt.mul(input.brightness).div(100).mul(durationMs).div(KWH_MILLISECOND_DIVISOR)
      : new Prisma.Decimal(0);

    deltas.push({
      bucketStartUtc,
      localDate: new Date(Date.UTC(local.year, local.month - 1, local.day)),
      localHour: local.hour,
      utcOffsetMinutes: offsetMinutes,
      estimatedKwh,
      knownSeconds: input.known ? Math.round(durationMs / 1_000) : 0,
      unknownSeconds: input.known ? 0 : Math.round(durationMs / 1_000),
      brightnessWeightedSeconds: input.known ? durationSeconds.mul(input.brightness) : new Prisma.Decimal(0)
    });
    cursor = partEnd;
  }
  return deltas;
}

function createFormatter(timeZone: string) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23"
    });
  } catch {
    throw new RangeError(`invalid IANA time zone: ${timeZone}`);
  }
}

function localParts(date: Date, formatter: Intl.DateTimeFormat) {
  const values = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => ["year", "month", "day", "hour"].includes(part.type))
      .map((part) => [part.type, Number(part.value)])
  );
  return { year: values.year, month: values.month, day: values.day, hour: values.hour };
}
