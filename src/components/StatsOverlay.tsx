import type { RendererStats } from "@/gi/renderer";

export type StatsOverlayProps = {
  readonly stats: RendererStats;
};

export const StatsOverlay = ({ stats }: StatsOverlayProps) => {
  const fps = stats.frameMs > 0 ? 1000 / stats.frameMs : 0;

  return (
    <section
      aria-label="Stats"
      className="pointer-events-none absolute top-3 left-3 z-20 rounded-lg bg-neutral-950/70 px-3 py-2 backdrop-blur"
    >
      <dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 font-mono text-xs text-neutral-400">
        <dt>resolution</dt>
        <dd className="text-right text-neutral-200">
          {stats.width}×{stats.height}
        </dd>
        <dt>frame</dt>
        <dd className="text-right text-neutral-200">
          {stats.frameMs.toFixed(1)} ms
        </dd>
        <dt>fps</dt>
        <dd className="text-right text-neutral-200">{fps.toFixed(0)}</dd>
        <dt>accumulated</dt>
        <dd
          data-testid="stat-accumulated"
          className="text-right text-neutral-200"
        >
          {stats.accumFrames}
        </dd>
      </dl>
    </section>
  );
};
