/** A synchronous, command-scoped gate. It must never perform network I/O. */
export interface CommandWriteControl {
  mayStartWrite(): boolean;
  onWriteStarted(): void;
}

export class CommandWriteVetoError extends Error {
  readonly code = "COMMAND_WRITE_VETOED";
  constructor() { super("Central Set write permit is unavailable"); }
}

export function assertCommandWriteAllowed(control?: Partial<CommandWriteControl>) {
  if (control?.mayStartWrite && !control.mayStartWrite()) throw new CommandWriteVetoError();
}

/** Per-adapter observation preserves uncertainty when native submission fails. */
export function trackCommandWrites(control?: CommandWriteControl) {
  let started = false;
  return {
    hasStarted: () => started,
    control: control ? {
      mayStartWrite: () => control.mayStartWrite(),
      onWriteStarted: () => { started = true; control.onWriteStarted(); }
    } : undefined
  };
}

export class CommandRfDrain {
  private readonly epochs = new Map<number | undefined, { queuedCount: number; submittedCount: number }>();

  begin(publishEpoch: number | undefined) {
    const counts = this.epochs.get(publishEpoch) ?? { queuedCount: 0, submittedCount: 0 };
    this.epochs.set(publishEpoch, counts);
    counts.queuedCount++;
    let started = false;
    let finished = false;
    return {
      onWriteStarted: () => {
        if (started) return;
        started = true;
        if (!finished) counts.queuedCount--;
        counts.submittedCount++;
      },
      finish: () => {
        if (finished) return;
        finished = true;
        if (!started) counts.queuedCount--;
      }
    };
  }

  snapshot(publishEpoch: number) {
    const epoch = this.epochs.get(publishEpoch);
    const legacy = this.epochs.get(undefined);
    const submittedCount = (epoch?.submittedCount ?? 0) + (legacy?.submittedCount ?? 0);
    // D-Bus success, USB completion, and even a device status do not prove that
    // all daemon/dongle retransmissions have stopped. Keep submissions unknown
    // for this process lifetime. A process restart can reset counters within the
    // SAME boot: neither zero counts nor the boot ID certifies physical drain.
    return {
      queuedCount: (epoch?.queuedCount ?? 0) + (legacy?.queuedCount ?? 0),
      submittedCount,
      unconfirmedCount: submittedCount,
      physicalCompletionCertified: false as const
    };
  }
}
