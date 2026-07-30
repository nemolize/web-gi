import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { OrbitCamera } from "@/gi/camera";
import { DEFAULT_CAMERA, dollyCamera, orbitCamera } from "@/gi/camera";
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
  readonly resetView: () => void;
};

const EMPTY_STATS: RendererStats = {
  width: 0,
  height: 0,
  accumFrames: 0,
  frameMs: 0,
};

const STATS_INTERVAL_MS = 250;
const ORBIT_SPEED = 0.005;
const DOLLY_SPEED = 0.0015;

export const useGiRenderer = (): UseGiRenderer => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<GiRenderer | null>(null);
  const cameraRef = useRef<OrbitCamera>(DEFAULT_CAMERA);

  const [settings, setSettings] = useState<RenderSettings>(DEFAULT_SETTINGS);
  const [stats, setStats] = useState<RendererStats>(EMPTY_STATS);
  const [status, setStatus] = useState<RendererStatus>("initializing");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;

    let disposed = false;
    let animationFrame = 0;
    let renderer: GiRenderer | null = null;

    const start = async (): Promise<void> => {
      try {
        renderer = await GiRenderer.create(canvas, DEFAULT_SETTINGS);
        if (disposed) {
          renderer.destroy();
          return;
        }
        rendererRef.current = renderer;
        setStatus("running");

        let lastStatsAt = 0;
        const loop = (): void => {
          animationFrame = requestAnimationFrame(loop);
          const active = rendererRef.current;
          if (active === null) return;
          active.renderFrame(cameraRef.current);
          const now = performance.now();
          if (now - lastStatsAt > STATS_INTERVAL_MS) {
            lastStatsAt = now;
            setStats(active.stats);
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
      rendererRef.current = null;
      renderer?.destroy();
    };
  }, []);

  useEffect(() => {
    rendererRef.current?.setSettings(settings);
  }, [settings]);

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
  }, []);

  const updateSettings = useCallback((patch: Partial<RenderSettings>): void => {
    setSettings((current) => ({ ...current, ...patch }));
  }, []);

  const resetView = useCallback((): void => {
    cameraRef.current = DEFAULT_CAMERA;
    rendererRef.current?.notifyCameraChanged();
  }, []);

  return {
    canvasRef,
    settings,
    updateSettings,
    stats,
    status,
    errorMessage,
    resetView,
  };
};
