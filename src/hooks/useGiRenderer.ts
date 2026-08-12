import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { OrbitCamera } from "@/gi/camera";
import { DEFAULT_CAMERA, dollyCamera, orbitCamera } from "@/gi/camera";
import {
  COMPARISON_MATRIX_CASES,
  type ComparisonMatrixProgress,
  comparisonMatrixRuns,
  type LinearComparisonMatrixReport,
} from "@/gi/comparison-matrix";
import type { LinearComparisonReport } from "@/gi/comparison-session";
import {
  createPerformanceRecorder,
  PERFORMANCE_CAPTURE_DURATION_MS,
  PERFORMANCE_WARMUP_FRAMES,
  type PerformanceMeasurement,
} from "@/gi/performance";
import type { RendererStats } from "@/gi/renderer";
import { GiRenderer, WebGpuUnsupportedError } from "@/gi/renderer";
import type { ComparisonMode, RenderSettings } from "@/gi/settings";
import { settingsFromSearch } from "@/gi/settings";

export type RendererStatus =
  "initializing" | "running" | "unsupported" | "error";

export type UseGiRenderer = {
  readonly canvasRef: RefObject<HTMLCanvasElement | null>;
  readonly settings: RenderSettings;
  readonly updateSettings: (patch: Partial<RenderSettings>) => void;
  readonly stats: RendererStats;
  readonly status: RendererStatus;
  readonly errorMessage: string | null;
  readonly measurePerformance: () => Promise<PerformanceMeasurement>;
  readonly saveComparisonReference: () => Promise<boolean>;
  readonly compareReferenceAfter: (
    label: string,
    durationMs: number,
  ) => Promise<LinearComparisonReport | null>;
  readonly runAutomaticComparison: (
    mode: ComparisonMode,
    referenceFrames: number,
    durationMs: number,
  ) => Promise<LinearComparisonReport | null>;
  readonly runAutomaticComparisonMatrix: (
    referenceFrames: number,
    durationMs: number,
    repeats: number,
    onProgress: (progress: ComparisonMatrixProgress) => void,
  ) => Promise<LinearComparisonMatrixReport>;
  readonly resetView: () => void;
  readonly retryRenderer: () => void;
};

export type RendererHandle = Pick<
  GiRenderer,
  | "destroy"
  | "deviceLost"
  | "allocationError"
  | "notifyCameraChanged"
  | "renderFrame"
  | "setSettings"
  | "stats"
  | "supportsGpuTiming"
  | "setGpuTimingEnabled"
  | "saveComparisonReference"
  | "saveComparisonReferenceAfterFrames"
  | "compareReferenceAfter"
  | "releaseComparisonResources"
  | "cancelComparison"
  | "takeGpuSamples"
>;

export type RendererFactory = (
  canvas: HTMLCanvasElement,
  settings: RenderSettings,
) => Promise<RendererHandle>;

const createRenderer: RendererFactory = (canvas, settings) =>
  GiRenderer.create(canvas, settings);

const EMPTY_STATS: RendererStats = {
  width: 0,
  height: 0,
  accumFrames: 0,
  frameMs: 0,
  atrousVariant: null,
};

type ActiveMeasurement = {
  readonly recorder: ReturnType<typeof createPerformanceRecorder>;
  readonly resolve: (measurement: PerformanceMeasurement) => void;
  readonly reject: (error: Error) => void;
  readonly timeoutId: number;
  renderContext: Pick<
    PerformanceMeasurement,
    "atrousVariant" | "renderResolution"
  > | null;
  lastFrameAt: number | null;
};

const STATS_INTERVAL_MS = 250;
/** Warm-up runs before the window opens, so it has to fit inside the timeout. */
export const PERFORMANCE_CAPTURE_TIMEOUT_MS =
  PERFORMANCE_CAPTURE_DURATION_MS + PERFORMANCE_WARMUP_FRAMES * 100 + 2_000;
const MAX_CAPTURE_FRAME_GAP_MS = 1_000;
const ORBIT_SPEED = 0.005;
const DOLLY_SPEED = 0.0015;

export const useGiRenderer = (
  rendererFactory: RendererFactory = createRenderer,
): UseGiRenderer => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<RendererHandle | null>(null);
  const rendererFactoryRef = useRef<RendererFactory>(rendererFactory);
  const cameraRef = useRef<OrbitCamera>(DEFAULT_CAMERA);

  const [settings, setSettings] = useState<RenderSettings>(() =>
    settingsFromSearch(window.location.search),
  );
  const settingsRef = useRef<RenderSettings>(settings);
  const [stats, setStats] = useState<RendererStats>(EMPTY_STATS);
  const [status, setStatus] = useState<RendererStatus>("initializing");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [rendererVersion, setRendererVersion] = useState(0);
  const measurementRef = useRef<ActiveMeasurement | null>(null);

  const cancelMeasurement = useCallback((message: string): void => {
    const measurement = measurementRef.current;
    if (measurement === null) return;
    measurementRef.current = null;
    window.clearTimeout(measurement.timeoutId);
    rendererRef.current?.setGpuTimingEnabled(false);
    measurement.reject(new Error(message));
  }, []);

  useEffect(() => {
    rendererFactoryRef.current = rendererFactory;
  }, [rendererFactory]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;

    let disposed = false;
    let animationFrame = 0;
    let renderer: RendererHandle | null = null;

    const start = async (): Promise<void> => {
      try {
        renderer = await rendererFactoryRef.current(
          canvas,
          settingsRef.current,
        );
        if (disposed) {
          renderer.destroy();
          return;
        }
        renderer.setSettings(settingsRef.current);
        rendererRef.current = renderer;
        setStats(EMPTY_STATS);
        setErrorMessage(null);
        setStatus("running");

        const activeRenderer = renderer;
        void activeRenderer.deviceLost.then((info) => {
          if (
            disposed ||
            rendererRef.current !== activeRenderer ||
            info.reason === "destroyed"
          ) {
            return;
          }

          cancelAnimationFrame(animationFrame);
          cancelMeasurement(
            "Performance capture stopped because the GPU device was lost.",
          );
          rendererRef.current = null;
          activeRenderer.destroy();
          const detail = info.message.trim();
          setErrorMessage(
            detail.length > 0
              ? `The WebGPU device was lost: ${detail}`
              : "The WebGPU device was lost unexpectedly.",
          );
          setStatus("error");
        });

        let lastStatsAt = 0;
        const loop = (now: number): void => {
          animationFrame = requestAnimationFrame(loop);
          const active = rendererRef.current;
          if (active === null) return;
          active.renderFrame(cameraRef.current);
          // A renderer that cannot allocate its targets keeps running and keeps
          // drawing black, so the failure has to be pulled out of it explicitly.
          const failure = active.allocationError;
          if (failure !== null) {
            cancelAnimationFrame(animationFrame);
            cancelMeasurement(
              "Performance capture stopped because render targets could not be allocated.",
            );
            rendererRef.current = null;
            active.destroy();
            setErrorMessage(failure);
            setStatus("error");
            return;
          }
          const measurement = measurementRef.current;
          const shouldUpdateStats = now - lastStatsAt > STATS_INTERVAL_MS;
          const currentStats =
            measurement !== null || shouldUpdateStats ? active.stats : null;
          if (measurement !== null && currentStats !== null) {
            // A frame the capture will not count still reaches the recorder,
            // marked rejected — the window and the sample set then advance on
            // the same frames instead of drifting apart.
            const usable =
              currentStats.atrousVariant !== null &&
              currentStats.width > 0 &&
              currentStats.height > 0;
            const currentContext = usable
              ? {
                  atrousVariant: currentStats.atrousVariant,
                  renderResolution: {
                    width: currentStats.width,
                    height: currentStats.height,
                  },
                }
              : null;

            if (currentContext !== null) {
              const initialContext = measurement.renderContext;
              if (initialContext === null) {
                measurement.renderContext = currentContext;
              } else if (
                initialContext.atrousVariant !== currentContext.atrousVariant ||
                initialContext.renderResolution.width !==
                  currentContext.renderResolution.width ||
                initialContext.renderResolution.height !==
                  currentContext.renderResolution.height
              ) {
                cancelMeasurement(
                  "Performance capture stopped because the render configuration changed.",
                );
              } else if (
                measurement.lastFrameAt !== null &&
                now - measurement.lastFrameAt > MAX_CAPTURE_FRAME_GAP_MS
              ) {
                cancelMeasurement(
                  "Performance capture stopped because rendering was interrupted.",
                );
              }
            }

            if (measurementRef.current === measurement) {
              measurement.lastFrameAt = now;
              // Drained every frame: leaving samples queued would attribute
              // them to whichever window happened to close next.
              const gpu = active.takeGpuSamples().at(-1) ?? null;
              const result = measurement.recorder.observe({
                at: now,
                callbackIntervalMs: currentStats.frameMs,
                accepted: currentContext !== null,
                gpu,
                gpuSupported: active.supportsGpuTiming,
              });
              if (result !== null) {
                const context = measurement.renderContext;
                measurementRef.current = null;
                window.clearTimeout(measurement.timeoutId);
                active.setGpuTimingEnabled(false);
                if (context === null) {
                  measurement.reject(
                    new Error(
                      "Performance capture ended before the renderer reported a usable frame.",
                    ),
                  );
                } else {
                  measurement.resolve({ ...result, ...context });
                }
              }
            }
          }
          if (shouldUpdateStats && currentStats !== null) {
            lastStatsAt = now;
            setStats(currentStats);
          }
        };
        animationFrame = requestAnimationFrame(loop);
      } catch (error) {
        if (disposed) return;
        setStatus(
          error instanceof WebGpuUnsupportedError ? "unsupported" : "error",
        );
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    };
    void start();

    return () => {
      disposed = true;
      cancelAnimationFrame(animationFrame);
      cancelMeasurement(
        "Performance capture stopped because the renderer restarted.",
      );
      rendererRef.current = null;
      renderer?.destroy();
    };
  }, [cancelMeasurement, rendererVersion]);

  useEffect(() => {
    settingsRef.current = settings;
    cancelMeasurement(
      "Performance capture stopped because the render settings changed.",
    );
    rendererRef.current?.setSettings(settings);
  }, [cancelMeasurement, settings]);

  useEffect(() => {
    const cancelWhenHidden = (): void => {
      if (document.visibilityState !== "visible") {
        cancelMeasurement(
          "Performance capture stopped because the page was hidden.",
        );
        rendererRef.current?.cancelComparison(
          "Comparison stopped because the page was hidden.",
        );
      }
    };

    document.addEventListener("visibilitychange", cancelWhenHidden);
    return () => {
      document.removeEventListener("visibilitychange", cancelWhenHidden);
    };
  }, [cancelMeasurement]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;

    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const onPointerDown = (event: PointerEvent): void => {
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent): void => {
      if (!dragging) return;
      cancelMeasurement(
        "Performance capture stopped because the camera moved.",
      );
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      cameraRef.current = orbitCamera(
        cameraRef.current,
        -dx * ORBIT_SPEED,
        dy * ORBIT_SPEED,
      );
      rendererRef.current?.notifyCameraChanged();
    };
    const onPointerUp = (event: PointerEvent): void => {
      dragging = false;
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
    };
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      cancelMeasurement(
        "Performance capture stopped because the camera moved.",
      );
      cameraRef.current = dollyCamera(
        cameraRef.current,
        Math.exp(event.deltaY * DOLLY_SPEED),
      );
      rendererRef.current?.notifyCameraChanged();
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [cancelMeasurement]);

  const updateSettings = useCallback((patch: Partial<RenderSettings>): void => {
    setSettings((current) => ({ ...current, ...patch }));
  }, []);

  const resetView = useCallback((): void => {
    cancelMeasurement("Performance capture stopped because the camera moved.");
    cameraRef.current = DEFAULT_CAMERA;
    rendererRef.current?.notifyCameraChanged();
  }, [cancelMeasurement]);

  const retryRenderer = useCallback((): void => {
    setStatus("initializing");
    setStats(EMPTY_STATS);
    setErrorMessage(null);
    setRendererVersion((version) => version + 1);
  }, []);

  const measurePerformance =
    useCallback((): Promise<PerformanceMeasurement> => {
      const renderer = rendererRef.current;
      if (renderer === null) {
        return Promise.reject(new Error("The renderer is not running."));
      }
      if (measurementRef.current !== null) {
        return Promise.reject(
          new Error("A performance capture is already running."),
        );
      }

      renderer.setGpuTimingEnabled(true);
      renderer.takeGpuSamples();

      return new Promise((resolve, reject) => {
        const timeoutId = window.setTimeout(() => {
          cancelMeasurement(
            "Performance capture timed out before enough frames were rendered.",
          );
        }, PERFORMANCE_CAPTURE_TIMEOUT_MS);
        measurementRef.current = {
          recorder: createPerformanceRecorder(),
          resolve,
          reject,
          timeoutId,
          renderContext: null,
          lastFrameAt: null,
        };
      });
    }, [cancelMeasurement]);

  const saveComparisonReference = useCallback((): Promise<boolean> => {
    const renderer = rendererRef.current;
    return renderer === null
      ? Promise.reject(new Error("The renderer is not running."))
      : renderer.saveComparisonReference();
  }, []);

  const compareReferenceAfter = useCallback(
    (
      label: string,
      durationMs: number,
    ): Promise<LinearComparisonReport | null> => {
      const renderer = rendererRef.current;
      return renderer === null
        ? Promise.reject(new Error("The renderer is not running."))
        : renderer.compareReferenceAfter(label, durationMs);
    },
    [],
  );

  const runAutomaticComparison = useCallback(
    async (
      mode: ComparisonMode,
      referenceFrames: number,
      durationMs: number,
    ): Promise<LinearComparisonReport | null> => {
      const renderer = rendererRef.current;
      if (renderer === null) throw new Error("The renderer is not running.");
      if (measurementRef.current !== null) {
        throw new Error("A performance capture is already running.");
      }
      try {
        const saved =
          await renderer.saveComparisonReferenceAfterFrames(referenceFrames);
        if (!saved) throw new Error("No stable reference frame to save.");
        if (rendererRef.current !== renderer) {
          throw new Error("The renderer restarted during the comparison.");
        }

        const targetSettings = { ...settingsRef.current, mode };
        settingsRef.current = targetSettings;
        renderer.setSettings(targetSettings);
        setSettings(targetSettings);
        renderer.renderFrame(cameraRef.current);
        return await renderer.compareReferenceAfter(mode, durationMs);
      } finally {
        renderer.releaseComparisonResources();
      }
    },
    [],
  );

  const runAutomaticComparisonMatrix = useCallback(
    async (
      referenceFrames: number,
      durationMs: number,
      repeats: number,
      onProgress: (progress: ComparisonMatrixProgress) => void,
    ): Promise<LinearComparisonMatrixReport> => {
      const renderer = rendererRef.current;
      if (renderer === null) throw new Error("The renderer is not running.");
      if (measurementRef.current !== null) {
        throw new Error("A performance capture is already running.");
      }

      const requireActiveRenderer = (): void => {
        if (rendererRef.current !== renderer) {
          throw new Error("The renderer restarted during the comparison.");
        }
        if (document.visibilityState !== "visible") {
          throw new Error("Comparison stopped because the page was hidden.");
        }
      };
      const applyView = (
        scene: (typeof COMPARISON_MATRIX_CASES)[number]["scene"],
        mode: RenderSettings["mode"],
        camera: OrbitCamera,
      ): void => {
        requireActiveRenderer();
        const nextSettings = { ...settingsRef.current, scene, mode };
        cameraRef.current = camera;
        settingsRef.current = nextSettings;
        renderer.setSettings(nextSettings);
        setSettings(nextSettings);
        renderer.renderFrame(camera);
      };

      const runs = comparisonMatrixRuns(repeats);
      const cases: LinearComparisonMatrixReport["cases"][number][] = [];
      for (const [runOffset, entry] of runs.entries()) {
        try {
          const runIndex = runOffset + 1;
          const { runOrder } = entry;
          onProgress({
            runIndex,
            totalRuns: runs.length,
            entry,
            phase: "reference",
          });
          applyView(entry.scene, "reference", entry.camera);
          const saved =
            await renderer.saveComparisonReferenceAfterFrames(referenceFrames);
          requireActiveRenderer();
          if (!saved) throw new Error("No stable reference frame to save.");

          let restir: LinearComparisonReport | null = null;
          let pathTraced: LinearComparisonReport | null = null;
          for (const mode of runOrder) {
            onProgress({
              runIndex,
              totalRuns: runs.length,
              entry,
              phase: mode,
            });
            applyView(entry.scene, mode, entry.camera);
            const report = await renderer.compareReferenceAfter(
              mode,
              durationMs,
            );
            requireActiveRenderer();
            if (report === null) {
              throw new Error("The comparison did not produce a capture.");
            }
            if (mode === "restir") restir = report;
            else pathTraced = report;
          }
          if (restir === null || pathTraced === null) {
            throw new Error("The comparison matrix is incomplete.");
          }
          cases.push({
            ...entry,
            comparisons: { restir, "path-traced": pathTraced },
          });
        } finally {
          renderer.releaseComparisonResources();
        }
      }
      return {
        kind: "comparison-matrix",
        requestedReferenceFrames: referenceFrames,
        requestedDurationMs: durationMs,
        repeats: runs.length / COMPARISON_MATRIX_CASES.length,
        cases,
      };
    },
    [],
  );

  return {
    canvasRef,
    settings,
    updateSettings,
    stats,
    status,
    errorMessage,
    measurePerformance,
    saveComparisonReference,
    compareReferenceAfter,
    runAutomaticComparison,
    runAutomaticComparisonMatrix,
    resetView,
    retryRenderer,
  };
};
