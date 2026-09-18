import { useCallback, useEffect, useState } from "react";

type FloorPlanImageStatus = "idle" | "loading" | "ready" | "error";
type Snapshot = { image: HTMLImageElement | null; status: FloorPlanImageStatus };
type CacheEntry = Snapshot & {
  key: string;
  url: string;
  attempt: number;
  lastUsed: number;
  evicted: boolean;
  listeners: Set<() => void>;
};

const idleSnapshot: Snapshot = { image: null, status: "idle" };
const imageCache = new Map<string, CacheEntry>();
const MAX_CACHED_FLOOR_PLAN_IMAGES = 8;
let useSequence = 0;

export function useFloorPlanImage(url: string, assetIdentity: string | number = url): Snapshot & { retry: () => void } {
  const key = url ? `${assetIdentity}\u0000${url}` : "";
  const entry = url ? entryFor(key, url) : null;
  const [published, setPublished] = useState<{ key: string; snapshot: Snapshot }>(() => ({
    key,
    snapshot: entry ? snapshotOf(entry) : idleSnapshot
  }));

  useEffect(() => {
    if (!url) {
      setPublished({ key: "", snapshot: idleSnapshot });
      return;
    }
    const entry = entryFor(key, url);
    const publish = () => setPublished({ key, snapshot: snapshotOf(entry) });
    publish();
    entry.listeners.add(publish);
    return () => {
      entry.listeners.delete(publish);
      evictUnusedEntries();
    };
  }, [key, url]);

  const retry = useCallback(() => {
    if (!url) return;
    const entry = entryFor(key, url);
    if (entry.status === "error") load(entry);
  }, [key, url]);

  const snapshot = published.key === key ? published.snapshot : entry ? snapshotOf(entry) : idleSnapshot;
  return { ...snapshot, retry };
}

function entryFor(key: string, url: string): CacheEntry {
  const existing = imageCache.get(key);
  if (existing) {
    existing.lastUsed = ++useSequence;
    return existing;
  }
  const entry: CacheEntry = {
    key,
    url,
    image: null,
    status: "idle",
    attempt: 0,
    lastUsed: ++useSequence,
    evicted: false,
    listeners: new Set()
  };
  imageCache.set(key, entry);
  load(entry);
  evictUnusedEntries(key);
  return entry;
}

function load(entry: CacheEntry) {
  if (entry.evicted || entry.status === "loading" || entry.status === "ready") return;
  const attempt = ++entry.attempt;
  entry.image = null;
  entry.status = "loading";
  notify(entry);
  const image = new Image();
  image.onload = () => {
    const decoded = typeof image.decode === "function" ? image.decode() : Promise.resolve();
    void decoded.then(
      () => settle(entry, attempt, image, "ready"),
      () => settle(entry, attempt, null, "error")
    );
  };
  image.onerror = () => settle(entry, attempt, null, "error");
  image.src = entry.url;
}

function settle(entry: CacheEntry, attempt: number, image: HTMLImageElement | null, status: "ready" | "error") {
  if (entry.evicted || imageCache.get(entry.key) !== entry || entry.attempt !== attempt) return;
  entry.image = image;
  entry.status = status;
  notify(entry);
  evictUnusedEntries(entry.listeners.size ? entry.key : undefined);
}

function notify(entry: CacheEntry) {
  entry.listeners.forEach((listener) => listener());
}

function snapshotOf(entry: CacheEntry): Snapshot {
  return { image: entry.image, status: entry.status };
}

function evictUnusedEntries(protectedKey?: string) {
  if (imageCache.size <= MAX_CACHED_FLOOR_PLAN_IMAGES) return;
  const candidates = [...imageCache.values()]
    .filter((entry) => entry.key !== protectedKey && entry.status !== "loading" && entry.listeners.size === 0)
    .sort((left, right) => left.lastUsed - right.lastUsed);
  for (const entry of candidates) {
    if (imageCache.size <= MAX_CACHED_FLOOR_PLAN_IMAGES) break;
    if (imageCache.get(entry.key) !== entry) continue;
    imageCache.delete(entry.key);
    entry.evicted = true;
    entry.attempt += 1;
    entry.image = null;
  }
}
