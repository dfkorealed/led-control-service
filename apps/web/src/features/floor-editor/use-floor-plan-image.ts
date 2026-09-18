import { useCallback, useEffect, useState } from "react";

type FloorPlanImageStatus = "idle" | "loading" | "ready" | "error";
type Snapshot = { image: HTMLImageElement | null; status: FloorPlanImageStatus };
type CacheEntry = Snapshot & {
  url: string;
  attempt: number;
  listeners: Set<() => void>;
};

const idleSnapshot: Snapshot = { image: null, status: "idle" };
const imageCache = new Map<string, CacheEntry>();

export function useFloorPlanImage(url: string): Snapshot & { retry: () => void } {
  const [snapshot, setSnapshot] = useState<Snapshot>(() => url ? snapshotOf(entryFor(url)) : idleSnapshot);

  useEffect(() => {
    if (!url) {
      setSnapshot(idleSnapshot);
      return;
    }
    const entry = entryFor(url);
    const publish = () => setSnapshot(snapshotOf(entry));
    publish();
    entry.listeners.add(publish);
    return () => { entry.listeners.delete(publish); };
  }, [url]);

  const retry = useCallback(() => {
    if (!url) return;
    load(entryFor(url));
  }, [url]);

  return { ...snapshot, retry };
}

function entryFor(url: string): CacheEntry {
  const existing = imageCache.get(url);
  if (existing) return existing;
  const entry: CacheEntry = { url, image: null, status: "loading", attempt: 0, listeners: new Set() };
  imageCache.set(url, entry);
  load(entry);
  return entry;
}

function load(entry: CacheEntry) {
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
  if (entry.attempt !== attempt) return;
  entry.image = image;
  entry.status = status;
  notify(entry);
}

function notify(entry: CacheEntry) {
  entry.listeners.forEach((listener) => listener());
}

function snapshotOf(entry: CacheEntry): Snapshot {
  return { image: entry.image, status: entry.status };
}
