import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { OrbitCamera } from "@/gi/camera";
import { DEFAULT_CAMERA, dollyCamera, orbitCamera } from "@/gi/camera";
import {
  createPerformanceRecorder,
  PERFORMANCE_CAPTURE_DURATION_MS,
  type PerformanceMeasurement,
} from "@/gi/performance";
import type { RendererStats } from "@/gi/renderer";
import { GiRenderer, WebGpuUnsupportedError } from "@/gi/renderer";
import type { RenderSettings } from "@/gi/settings";
import { DEFAULT_SETTINGS } from "@/gi/settings";

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
const PERFORMANCE_CAPTURE_TIMEOUT_MS = PERFORMANCE_CAPTURE_DURATION_MS + 2_000;
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

  const [settings, setSettings] = useState<RenderSettings>(DEFAULT_SETTINGS);
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
          const currentStats = active.stats;
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
          if (
            measurement !== null &&
            currentStats.atrousVariant !== null &&
            currentStats.width > 0 &&
            currentStats.height > 0
          ) {
            const currentContext = {
              atrousVariant: currentStats.atrousVariant,
              renderResolution: {
                width: currentStats.width,
                height: currentStats.height,
              },
            };
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

            if (measurementRef.current === measurement) {
              measurement.lastFrameAt = now;
              const result = measurement.recorder.record(
                now,
                currentStats.frameMs,
              );
              if (result !== null) {
                measurementRef.current = null;
                window.clearTimeout(measurement.timeoutId);
                measurement.resolve({ ...result, ...currentContext });
              }
            }
          }
          if (now - lastStatsAt > STATS_INTERVAL_MS) {
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
    setErrorMessage(null);
    setRendererVersion((version) => version + 1);
  }, []);

  const measurePerformance =
    useCallback((): Promise<PerformanceMeasurement> => {
      if (rendererRef.current === null) {
        return Promise.reject(new Error("The renderer is not running."));
      }
      if (measurementRef.current !== null) {
        return Promise.reject(
          new Error("A performance capture is already running."),
        );
      }

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

  return {
    canvasRef,
    settings,
    updateSettings,
    stats,
    status,
    errorMessage,
    measurePerformance,
    resetView,
    retryRenderer,
  };
};
