import { useEffect, useState } from "react";

import type { RendererActivity } from "@/gi/renderer";

interface RendererProgressProps {
  readonly activity?: RendererActivity;
}

export const RendererProgress = ({ activity }: RendererProgressProps) => {
  const [mountedAt] = useState(() => performance.now());
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(performance.now()), 250);
    return () => window.clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, now - (activity?.startedAt ?? mountedAt));
  if (activity?.kind === "rendering" && elapsed < 750) return null;
  const title = activity
    ? activity.kind === "preparing"
      ? "Preparing ReSTIR BDPT…"
      : "Waiting for GPU…"
    : "Starting WebGPU…";

  return (
    <div className="pointer-events-none absolute inset-x-4 bottom-12 flex justify-center">
      <div className="w-full max-w-sm rounded-xl border border-neutral-600 bg-neutral-950/95 p-4 text-center shadow-xl">
        <div role="status" aria-live="polite">
          <p className="font-medium text-neutral-100">{title}</p>
          {activity?.step !== undefined && (
            <p
              className="mt-1 text-sm text-neutral-300"
              data-testid="renderer-step"
            >
              Step {activity.step.current}/{activity.step.total}
            </p>
          )}
          <p className="mt-1 text-sm text-neutral-300">
            {activity?.detail ?? "Preparing the GPU device and renderer"}
          </p>
        </div>
        <p
          className="mt-2 text-sm text-neutral-400"
          data-testid="renderer-elapsed"
        >
          {Math.floor(elapsed / 1_000)}s elapsed
        </p>
        <p className="mt-1 text-xs text-neutral-400">
          {activity?.kind === "rendering"
            ? "Waiting for the submitted frame to finish."
            : "This can take a while on the first run."}
        </p>
      </div>
    </div>
  );
};
