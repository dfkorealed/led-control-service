export interface CadSceneTileCacheOptions<K> {
  maximumBytes: number;
  onEvict?: (key: K) => void;
}

export interface CadSceneTileLoadResult<T> {
  value: T;
  byteSize: number;
}

interface CacheEntry<T> {
  value: T;
  byteSize: number;
  lastUsed: number;
}

export class CadSceneTileCache<T, K = string> {
  private readonly entries = new Map<K, CacheEntry<T>>();
  private readonly pending = new Map<K, Promise<T>>();
  private pinned = new Set<K>();
  private clock = 0;
  private bytes = 0;
  private generation = 0;

  constructor(private readonly options: CadSceneTileCacheOptions<K>) {
    if (!Number.isSafeInteger(options.maximumBytes) || options.maximumBytes <= 0) {
      throw new Error("CAD scene tile cache byte limit must be a positive safe integer");
    }
  }

  get totalBytes(): number {
    return this.bytes;
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  get(key: K): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    entry.lastUsed = ++this.clock;
    return entry.value;
  }

  getOrLoad(key: K, loader: () => Promise<CadSceneTileLoadResult<T>>): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;

    const generation = this.generation;
    const request = loader().then(({ value, byteSize }) => {
      if (!Number.isSafeInteger(byteSize) || byteSize <= 0) {
        throw new Error("CAD scene tile cache entries require a positive byte size");
      }
      if (generation !== this.generation) return value;
      const previous = this.entries.get(key);
      if (previous) this.bytes -= previous.byteSize;
      this.entries.set(key, { value, byteSize, lastUsed: ++this.clock });
      this.bytes += byteSize;
      this.evictToBudget();
      return value;
    }).finally(() => {
      if (this.pending.get(key) === request) this.pending.delete(key);
    });
    this.pending.set(key, request);
    return request;
  }

  pin(keys: ReadonlySet<K>): void {
    this.pinned = new Set(keys);
    this.evictToBudget();
  }

  delete(key: K): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.bytes -= entry.byteSize;
    this.options.onEvict?.(key);
    return true;
  }

  cancelPending(): void {
    this.generation++;
    this.pending.clear();
  }

  clear(): void {
    this.cancelPending();
    for (const key of this.entries.keys()) this.options.onEvict?.(key);
    this.entries.clear();
    this.pending.clear();
    this.pinned.clear();
    this.bytes = 0;
  }

  private evictToBudget(): void {
    while (this.bytes > this.options.maximumBytes) {
      let oldestKey: K | undefined;
      let oldestUse = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.entries) {
        if (this.pinned.has(key) || entry.lastUsed >= oldestUse) continue;
        oldestKey = key;
        oldestUse = entry.lastUsed;
      }
      if (oldestKey === undefined) return;
      this.delete(oldestKey);
    }
  }
}
