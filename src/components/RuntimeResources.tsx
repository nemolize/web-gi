import { useEffect, useState } from "react";

export interface HeapUsage {
  readonly used: number;
  readonly limit: number;
}

export const readHeapUsage = (source: object): HeapUsage | null => {
  if (!("memory" in source)) return null;
  const memory: unknown = source.memory;
  if (typeof memory !== "object" || memory === null) return null;
  if (!("usedJSHeapSize" in memory) || !("jsHeapSizeLimit" in memory))
    return null;
  const used = memory.usedJSHeapSize;
  const limit = memory.jsHeapSizeLimit;
  return typeof used === "number" &&
    typeof limit === "number" &&
    Number.isFinite(used) &&
    Number.isFinite(limit) &&
    used >= 0 &&
    limit > 0
    ? { used, limit }
    : null;
};

export const RuntimeResources = () => {
  const [heap, setHeap] = useState(() => readHeapUsage(performance));
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) setHeap(readHeapUsage(performance));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <>
      <dt title="System CPU utilization is not exposed to this web page.">
        CPU
      </dt>
      <dd
        className="text-right text-neutral-200"
        aria-label="CPU usage unavailable"
      >
        N/A
      </dd>
      <dt title="Approximate JavaScript heap usage and heap limit; excludes GPU memory and is not total device RAM.">
        JS heap
      </dt>
      <dd className="text-right text-neutral-200" data-testid="stat-js-heap">
        {heap === null ? (
          "N/A"
        ) : (
          <>
            <span className="inline-block">
              {Math.round(heap.used / 1048576)} /{" "}
              {Math.round(heap.limit / 1048576)}
            </span>{" "}
            MiB
          </>
        )}
      </dd>
    </>
  );
};
