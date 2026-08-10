import { useRef, useState } from "react";

import {
  aggregatePerformanceMeasurements,
  formatPerformanceReport,
  PERFORMANCE_CAPTURE_DURATION_MS,
  PERFORMANCE_CAPTURE_RUN_COUNT,
  type PerformanceCapture,
  type PerformanceMeasurement,
  type PerformanceReportContext,
  sanitizePerformanceReportUrl,
} from "@/gi/performance";
import type { RendererStats } from "@/gi/renderer";
import type { RenderSettings } from "@/gi/settings";

export type StatsOverlayProps = {
  readonly stats: RendererStats;
  readonly settings: RenderSettings;
  readonly measurePerformance: () => Promise<PerformanceMeasurement>;
};

type CaptureStatus =
  "idle" | "measuring" | "ready" | "copied" | "capture-error" | "copy-error";

const COMPARISON_DURATION_MS = 5_000;

const createReportContext = (
  settings: RenderSettings,
): PerformanceReportContext => ({
  capturedAt: new Date().toISOString(),
  url: sanitizePerformanceReportUrl(window.location.href),
  viewport: { width: window.innerWidth, height: window.innerHeight },
  devicePixelRatio: window.devicePixelRatio,
  settings,
  userAgent: navigator.userAgent,
});

export const StatsOverlay = ({
  stats,
  settings,
  measurePerformance,
}: StatsOverlayProps) => {
  const fps = stats.frameMs > 0 ? 1000 / stats.frameMs : 0;
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus>("idle");
  const [capture, setCapture] = useState<PerformanceCapture | null>(null);
  const [activeRun, setActiveRun] = useState(0);
  const [report, setReport] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const comparisonSettingsKey = JSON.stringify(settings);
  const [comparisonStatus, setComparisonStatus] = useState<{
    readonly settingsKey: string;
    readonly text: string;
  } | null>(null);
  const [isComparing, setIsComparing] = useState(false);
  const primaryButtonRef = useRef<HTMLButtonElement>(null);

  const showComparisonStatus = (text: string): void => {
    setComparisonStatus({ settingsKey: comparisonSettingsKey, text });
  };

  const startCapture = async (): Promise<void> => {
    setCaptureStatus("measuring");
    setCapture(null);
    setReport(null);
    setCaptureError(null);
    const context = createReportContext(settings);

    try {
      const runs: PerformanceMeasurement[] = [];
      for (let index = 0; index < PERFORMANCE_CAPTURE_RUN_COUNT; index++) {
        setActiveRun(index + 1);
        runs.push(await measurePerformance());
      }
      const result = aggregatePerformanceMeasurements(runs);
      setActiveRun(0);
      setCapture(result);
      setReport(formatPerformanceReport(result, context));
      setCaptureStatus("ready");
    } catch (error) {
      setActiveRun(0);
      setCaptureError(error instanceof Error ? error.message : String(error));
      setCaptureStatus("capture-error");
    }
  };

  const copyReport = async (): Promise<void> => {
    if (report === null) return;

    try {
      await navigator.clipboard.writeText(report);
      setCaptureError(null);
      setCaptureStatus("copied");
    } catch (error) {
      setCaptureError(
        error instanceof Error
          ? `Could not copy: ${error.message}`
          : "Could not copy the result.",
      );
      setCaptureStatus("copy-error");
    }
  };

  const runPrimaryAction = (): void => {
    if (captureStatus === "measuring" || isComparing) return;
    if (report === null) {
      void startCapture();
    } else {
      void copyReport();
    }
  };

  const primaryLabel =
    captureStatus === "measuring"
      ? `Measuring ${String(activeRun)}/${String(PERFORMANCE_CAPTURE_RUN_COUNT)}…`
      : report === null
        ? `Measure ${String(PERFORMANCE_CAPTURE_RUN_COUNT)}×${String(PERFORMANCE_CAPTURE_DURATION_MS / 1_000)} s`
        : captureStatus === "copied"
          ? "Copy again"
          : "Copy result";

  const saveReference = async (): Promise<void> => {
    setIsComparing(true);
    setComparisonStatus(null);
    try {
      const saved = await globalThis.__gi?.saveReference();
      showComparisonStatus(
        saved === true ? "Reference saved." : "No stable frame to save.",
      );
    } catch (error) {
      showComparisonStatus(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setIsComparing(false);
    }
  };

  const compareReference = async (): Promise<void> => {
    setIsComparing(true);
    setComparisonStatus(null);
    try {
      const comparison = await globalThis.__gi?.compareReferenceAfter(
        settings.mode,
        COMPARISON_DURATION_MS,
      );
      const capturedView =
        comparison === null || comparison === undefined
          ? null
          : `${String(comparison.context.width)}×${String(comparison.context.height)} eye ${comparison.context.camera.pos.x.toFixed(3)},${comparison.context.camera.pos.y.toFixed(3)},${comparison.context.camera.pos.z.toFixed(3)}`;
      showComparisonStatus(
        comparison === null || comparison === undefined
          ? "Save a reference first."
          : `${comparison.mode} · saved ${capturedView ?? "view"} · relative L2 ${comparison.relativeL2.toFixed(4)} · mean absolute ${comparison.meanAbsolute.toFixed(4)} · ${String(comparison.targetFrames)} frames in ${(comparison.actualDurationMs / 1_000).toFixed(2)} s`,
      );
    } catch (error) {
      showComparisonStatus(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setIsComparing(false);
    }
  };

  return (
    <section
      aria-label="Stats"
      aria-busy={captureStatus === "measuring"}
      className="absolute top-3 left-3 z-20 max-w-[calc(100vw-7rem)] rounded-lg bg-neutral-950/80 px-3 py-2 backdrop-blur"
    >
      <dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 font-mono text-xs text-neutral-400">
        <dt>resolution</dt>
        <dd className="text-right text-neutral-200">
          {stats.width}×{stats.height}
        </dd>
        <dt>presented</dt>
        <dd className="text-right text-neutral-200">
          {stats.frameMs.toFixed(1)} ms
        </dd>
        <dt>fps</dt>
        <dd className="text-right text-neutral-200">{fps.toFixed(0)}</dd>
        <dt>a-trous</dt>
        <dd className="text-right text-neutral-200">
          {stats.atrousVariant ?? "—"}
        </dd>
        <dt>accumulated</dt>
        <dd
          data-testid="stat-accumulated"
          className="text-right text-neutral-200"
        >
          {stats.accumFrames}
        </dd>
      </dl>
      {import.meta.env.DEV && (
        <div className="mt-2 border-t border-neutral-700 pt-2">
          <div className="flex gap-2">
            <button
              type="button"
              disabled={
                isComparing ||
                captureStatus === "measuring" ||
                settings.mode !== "reference"
              }
              className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
              onClick={() => void saveReference()}
            >
              Save ref
            </button>
            <button
              type="button"
              disabled={
                isComparing ||
                captureStatus === "measuring" ||
                settings.mode === "reference"
              }
              className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
              onClick={() => void compareReference()}
            >
              {isComparing ? "Comparing…" : "Compare 5 s"}
            </button>
          </div>
          <p
            aria-live="polite"
            className="mt-1 font-mono text-xs text-neutral-400"
          >
            {comparisonStatus?.settingsKey === comparisonSettingsKey
              ? comparisonStatus.text
              : null}
          </p>
        </div>
      )}
      <div className="mt-2 border-t border-neutral-700 pt-2">
        {capture !== null && (
          <div className="mb-2 font-mono text-xs">
            <p className="text-neutral-200">
              {capture.aggregate.gpuFrameMs === null
                ? "no GPU timing on this device"
                : `${capture.aggregate.gpuFrameMs.medianRun.toFixed(2)} ms GPU median run · p95 ${capture.aggregate.gpuFrameMs.medianRunP95.toFixed(2)} ms`}
            </p>
            {capture.aggregate.warnings.map((warning) => (
              <p key={warning.kind} className="mt-1 text-amber-300">
                ⚠ {warning.detail}
              </p>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <button
            ref={primaryButtonRef}
            type="button"
            aria-disabled={captureStatus === "measuring" || isComparing}
            className={`min-h-11 grow rounded border px-3 py-2 text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 ${
              captureStatus === "measuring" || isComparing
                ? "cursor-wait border-neutral-700 bg-neutral-900 text-neutral-400"
                : "border-sky-700 bg-sky-950 text-sky-100 hover:bg-sky-900"
            }`}
            onClick={runPrimaryAction}
          >
            {primaryLabel}
          </button>
          {report !== null && (
            <button
              type="button"
              aria-label="Measure again"
              disabled={isComparing}
              className="min-h-11 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
              onClick={() => {
                primaryButtonRef.current?.focus();
                void startCapture();
              }}
            >
              Again
            </button>
          )}
        </div>
        <p aria-live="polite" className="mt-1 text-xs text-neutral-400">
          {captureStatus === "measuring"
            ? `Measuring run ${String(activeRun)} of ${String(PERFORMANCE_CAPTURE_RUN_COUNT)} for ${String(PERFORMANCE_CAPTURE_DURATION_MS / 1_000)} seconds.`
            : captureStatus === "ready"
              ? "Measurement complete. Copy result is ready."
              : captureStatus === "copied"
                ? "Result copied to clipboard."
                : captureError}
        </p>
      </div>
    </section>
  );
};
