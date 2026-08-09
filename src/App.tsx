import { ControlPanel } from "@/components/ControlPanel";
import { StatsOverlay } from "@/components/StatsOverlay";
import { useGiRenderer } from "@/hooks/useGiRenderer";

interface OverlayProps {
  readonly title: string;
  readonly detail: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
}

const Overlay = ({ title, detail, actionLabel, onAction }: OverlayProps) => (
  <div
    role="alert"
    className="absolute inset-0 flex items-center justify-center bg-neutral-950/90 p-8"
  >
    <div className="max-w-md text-center">
      <h2 className="text-lg font-semibold text-neutral-100">{title}</h2>
      <p className="mt-2 text-sm text-neutral-400">{detail}</p>
      {actionLabel !== undefined && onAction !== undefined && (
        <button
          type="button"
          className="mt-5 rounded-lg border border-neutral-600 bg-neutral-800 px-4 py-2 text-sm font-medium text-neutral-100 transition-colors hover:bg-neutral-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
          onClick={onAction}
        >
          {actionLabel}
        </button>
      )}
    </div>
  </div>
);

export const App = () => {
  const {
    canvasRef,
    settings,
    updateSettings,
    stats,
    status,
    errorMessage,
    measurePerformance,
    resetView,
    retryRenderer,
  } = useGiRenderer();

  return (
    <div className="relative flex h-svh w-screen overflow-hidden bg-neutral-900 text-neutral-100">
      <main className="relative min-w-0 grow">
        <canvas
          ref={canvasRef}
          aria-label="Render output"
          className="block size-full cursor-grab touch-none active:cursor-grabbing"
        />
        {status === "running" && (
          <StatsOverlay
            stats={stats}
            settings={settings}
            measurePerformance={measurePerformance}
          />
        )}
        {status === "initializing" && (
          <Overlay title="Starting WebGPU…" detail="Requesting a GPU device." />
        )}
        {status === "unsupported" && (
          <Overlay
            title="WebGPU is not available"
            detail={`${errorMessage ?? ""} Try a recent Chrome, Edge, or Safari build with WebGPU enabled.`}
          />
        )}
        {status === "error" && (
          <Overlay
            title="Renderer unavailable"
            detail={errorMessage ?? "Unknown error."}
            actionLabel="Retry renderer"
            onAction={retryRenderer}
          />
        )}
        {status === "running" && (
          <p className="pointer-events-none absolute bottom-3 left-3 text-xs text-neutral-400">
            Drag to orbit
            <span className="hidden sm:inline"> · scroll to dolly</span>
          </p>
        )}
      </main>
      <ControlPanel
        settings={settings}
        updateSettings={updateSettings}
        resetView={resetView}
      />
    </div>
  );
};
