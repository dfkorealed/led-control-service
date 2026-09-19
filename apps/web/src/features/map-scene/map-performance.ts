export function summarizeFrameTimes(samples: number[]): { count: number; p95Ms: number | null } {
  if (samples.some(sample => !Number.isFinite(sample) || sample < 0)) {
    throw new RangeError("Frame durations must be finite and non-negative");
  }
  const ordered = [...samples].sort((left, right) => left - right);
  return {
    count: ordered.length,
    p95Ms: ordered.length ? ordered[Math.ceil(ordered.length * 0.95) - 1] : null
  };
}

export function summarizeControlledEntryTimes(samples: Array<{
  durationMs: number | null;
  sourceFingerprintBefore: string | null;
  sourceFingerprintAfter: string | null;
}>, referenceFingerprint: string | null) {
  const controlled = samples.filter(sample => referenceFingerprint !== null
    && sample.sourceFingerprintBefore === referenceFingerprint
    && sample.sourceFingerprintAfter === referenceFingerprint
    && sample.durationMs !== null);
  const summary = summarizeFrameTimes(controlled.map(sample => sample.durationMs!));
  return {
    observedCount: samples.length,
    controlledCount: controlled.length,
    p95Ms: controlled.length === 5 ? summary.p95Ms : null
  };
}
