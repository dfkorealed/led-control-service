import { useCallback, useEffect, useState } from "react";

type FloorPlanImageStatus = "idle" | "loading" | "ready" | "error";
type Snapshot = { image: HTMLImageElement | null; status: FloorPlanImageStatus };
type CacheEntry = Snapshot & {
  key: string;
  url: string;
  attempt: number;
  listeners: Set<() => void>;
};

const idleSnapshot: Snapshot = { image: null, status: "idle" };
const imageCache = new Map<string, CacheEntry>();

export function useFloorPlanImage(url: string, revision: string | number): Snapshot & { retry: () => void } {
  const key = url ? `${revision}\u0000${url}` : "";
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
    return () => { entry.listeners.delete(publish); };
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
  if (existing) return existing;
  const entry: CacheEntry = { key, url, image: null, status: "idle", attempt: 0, listeners: new Set() };
  imageCache.set(key, entry);
  load(entry);
  return entry;
}

function load(entry: CacheEntry) {
  if (entry.status === "loading" || entry.status === "ready") return;
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
