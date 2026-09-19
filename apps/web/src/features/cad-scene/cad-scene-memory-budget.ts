interface MemoryAllocation {
  owner: string;
  key: string;
  bytes: number;
  lastUsed: number;
  pinned: boolean;
  onEvict?: (key: string) => void;
}

export class CadSceneMemoryBudget {
  private readonly allocations = new Map<string, MemoryAllocation>();
  private clock = 0;
  private bytes = 0;

  constructor(readonly maximumBytes: number) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
      throw new Error("CAD scene aggregate memory limit must be a positive safe integer");
    }
  }

  get totalBytes(): number {
    return this.bytes;
  }

  reserve(owner: string, key: string, bytes: number, onEvict?: (key: string) => void): boolean {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
      throw new Error("CAD scene memory allocations require a positive safe integer byte size");
    }
    const allocationKey = this.allocationKey(owner, key);
    const current = this.allocations.get(allocationKey);
    const required = this.bytes - (current?.bytes ?? 0) + bytes - this.maximumBytes;
    const victims: Array<[string, MemoryAllocation]> = [];
    if (required > 0) {
      let reclaimed = 0;
      const candidates = [...this.allocations.entries()]
        .filter(([candidateKey, value]) => candidateKey !== allocationKey && !value.pinned)
        .sort((left, right) => left[1].lastUsed - right[1].lastUsed);
      for (const candidate of candidates) {
        victims.push(candidate);
        reclaimed += candidate[1].bytes;
        if (reclaimed >= required) break;
      }
      if (reclaimed < required) return false;
    }

    for (const [victimKey, victim] of victims) {
      this.allocations.delete(victimKey);
      this.bytes -= victim.bytes;
    }
    if (current) this.bytes -= current.bytes;
    this.allocations.set(allocationKey, {
      owner,
      key,
      bytes,
      lastUsed: ++this.clock,
      pinned: current?.pinned ?? false,
      onEvict
    });
    this.bytes += bytes;
    for (const [, victim] of victims) victim.onEvict?.(victim.key);
    return true;
  }

  touch(owner: string, key: string): void {
    const allocation = this.allocations.get(this.allocationKey(owner, key));
    if (allocation) allocation.lastUsed = ++this.clock;
  }

  setPinned(owner: string, key: string, pinned: boolean): void {
    const allocation = this.allocations.get(this.allocationKey(owner, key));
    if (allocation) allocation.pinned = pinned;
  }

  release(owner: string, key: string): void {
    const allocationKey = this.allocationKey(owner, key);
    const allocation = this.allocations.get(allocationKey);
    if (!allocation) return;
    this.allocations.delete(allocationKey);
    this.bytes -= allocation.bytes;
  }

  releaseOwner(owner: string): void {
    for (const [allocationKey, allocation] of this.allocations) {
      if (allocation.owner !== owner) continue;
      this.allocations.delete(allocationKey);
      this.bytes -= allocation.bytes;
    }
  }

  private allocationKey(owner: string, key: string): string {
    return `${owner}\u0000${key}`;
  }
}
