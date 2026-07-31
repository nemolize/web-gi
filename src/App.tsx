import { ControlPanel } from "@/components/ControlPanel";
import { useGiRenderer } from "@/hooks/useGiRenderer";

const Overlay = ({
  title,
  detail,
}: {
  readonly title: string;
  readonly detail: string;
}) => (
  <div
    role="alert"
    className="absolute inset-0 flex items-center justify-center bg-neutral-950/90 p-8"
  >
    <div className="max-w-md text-center">
      <h2 className="text-lg font-semibold text-neutral-100">{title}</h2>
      <p className="mt-2 text-sm text-neutral-400">{detail}</p>
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
    resetView,
  } = useGiRenderer();

  return (
    <div className="relative flex h-svh w-screen overflow-hidden bg-neutral-900 text-neutral-100">
      <main className="relative min-w-0 grow">
        <canvas
          ref={canvasRef}
          aria-label="Cornell box render"
          className="block size-full cursor-grab touch-none active:cursor-grabbing"
        />
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
            title="Renderer failed to start"
            detail={errorMessage ?? "Unknown error."}
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
        stats={stats}
        updateSettings={updateSettings}
        resetView={resetView}
      />
    </div>
  );
};
