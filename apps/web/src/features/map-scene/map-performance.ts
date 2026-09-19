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
  valid?: boolean;
}>, referenceFingerprint: string | null) {
  const controlled = samples.filter(sample => referenceFingerprint !== null
    && sample.valid === true
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

export function summarizePerformanceOutcome(checks: {
  entryCoverage: boolean;
  finalCoverage: boolean;
  noBrowserErrors: boolean;
  noMutations: boolean;
}, assertionErrors: string[]) {
  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  const valid = failedChecks.length === 0 && assertionErrors.length === 0;
  return {
    valid,
    checks: { ...checks },
    failedChecks,
    assertionErrors: [...assertionErrors],
    failure: valid ? null : `성능 관측 검증 실패: ${[...failedChecks, ...assertionErrors].join("; ")}`
  };
}
