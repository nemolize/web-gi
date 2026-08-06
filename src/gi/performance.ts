import type { AtrousVariant } from "@/gi/atrous";
import type { RenderSettings } from "@/gi/settings";

export const PERFORMANCE_CAPTURE_DURATION_MS = 5_000;

export interface FrameTimeSummary {
  readonly mean: number;
  readonly median: number;
  readonly p95: number;
  readonly min: number;
  readonly max: number;
}

export interface FrameTimeMeasurement {
  readonly durationMs: number;
  readonly sampleCount: number;
  readonly fps: number;
  readonly frameTimeMs: FrameTimeSummary;
}

export interface PerformanceMeasurement extends FrameTimeMeasurement {
  readonly atrousVariant: AtrousVariant;
  readonly renderResolution: {
    readonly width: number;
    readonly height: number;
  };
}

export interface PerformanceReportContext {
  readonly capturedAt: string;
  readonly url: string;
  readonly viewport: {
    readonly width: number;
    readonly height: number;
  };
  readonly devicePixelRatio: number;
  readonly settings: RenderSettings;
  readonly userAgent: string;
}

export interface PerformanceRecorder {
  readonly record: (
    frameStartedAt: number,
    frameMs: number,
  ) => FrameTimeMeasurement | null;
}

interface PerformanceReportV1 {
  readonly schemaVersion: 1;
  readonly capturedAt: string;
  readonly url: string;
  readonly atrousVariant: AtrousVariant;
  readonly durationMs: number;
  readonly sampleCount: number;
  readonly fps: number;
  readonly frameTimeMs: FrameTimeSummary;
  readonly renderResolution: PerformanceMeasurement["renderResolution"];
  readonly viewport: PerformanceReportContext["viewport"];
  readonly devicePixelRatio: number;
  readonly settings: RenderSettings;
  readonly userAgent: string;
}

const percentile = (sorted: readonly number[], fraction: number): number => {
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? 0;
};

export const summarizeFrameTimes = (
  samples: readonly number[],
  durationMs: number,
): FrameTimeMeasurement => {
  const sorted = [...samples].sort((left, right) => left - right);
  const totalFrameMs = samples.reduce((total, value) => total + value, 0);

  return {
    durationMs,
    sampleCount: samples.length,
    fps: durationMs > 0 ? (samples.length * 1_000) / durationMs : 0,
    frameTimeMs: {
      mean: samples.length > 0 ? totalFrameMs / samples.length : 0,
      median: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      min: sorted[0] ?? 0,
      max: sorted.at(-1) ?? 0,
    },
  };
};

export const createPerformanceRecorder = (
  durationMs = PERFORMANCE_CAPTURE_DURATION_MS,
): PerformanceRecorder => {
  let startedAt: number | null = null;
  let completed = false;
  const samples: number[] = [];

  return {
    record: (frameStartedAt, frameMs) => {
      if (completed) return null;
      if (startedAt === null) {
        startedAt = frameStartedAt;
        return null;
      }
      if (Number.isFinite(frameMs) && frameMs > 0) samples.push(frameMs);

      const elapsedMs = frameStartedAt - startedAt;
      if (elapsedMs < durationMs) return null;

      completed = true;
      return summarizeFrameTimes(samples, elapsedMs);
    },
  };
};

export const formatPerformanceReport = (
  measurement: PerformanceMeasurement,
  context: PerformanceReportContext,
): string => {
  const report: PerformanceReportV1 = {
    schemaVersion: 1,
    capturedAt: context.capturedAt,
    url: context.url,
    atrousVariant: measurement.atrousVariant,
    durationMs: Math.round(measurement.durationMs),
    sampleCount: measurement.sampleCount,
    fps: Number(measurement.fps.toFixed(2)),
    frameTimeMs: {
      mean: Number(measurement.frameTimeMs.mean.toFixed(2)),
      median: Number(measurement.frameTimeMs.median.toFixed(2)),
      p95: Number(measurement.frameTimeMs.p95.toFixed(2)),
      min: Number(measurement.frameTimeMs.min.toFixed(2)),
      max: Number(measurement.frameTimeMs.max.toFixed(2)),
    },
    renderResolution: measurement.renderResolution,
    viewport: context.viewport,
    devicePixelRatio: context.devicePixelRatio,
    settings: context.settings,
    userAgent: context.userAgent,
  };

  return JSON.stringify(report, null, 2);
};

export const sanitizePerformanceReportUrl = (url: string): string => {
  const source = new URL(url);
  const sanitized = new URL(source.pathname, source.origin);
  const atrous = source.searchParams.get("atrous");
  if (atrous === "8" || atrous === "fallback") {
    sanitized.searchParams.set("atrous", atrous);
  }
  return sanitized.toString();
};
