import type { AtrousVariant } from "@/gi/atrous";
import type { RenderSettings } from "@/gi/settings";

export const PERFORMANCE_CAPTURE_DURATION_MS = 5_000;
export const PERFORMANCE_CAPTURE_RUN_COUNT = 3;

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

export interface PerformanceCaptureAggregate {
  readonly totalDurationMs: number;
  readonly totalSampleCount: number;
  readonly fps: {
    readonly weighted: number;
    readonly medianRun: number;
    readonly minRun: number;
    readonly maxRun: number;
  };
  readonly frameTimeMs: {
    readonly weightedMean: number;
    readonly medianRunMedian: number;
    readonly medianRunP95: number;
    readonly min: number;
    readonly max: number;
  };
}

export interface PerformanceCapture {
  readonly atrousVariant: AtrousVariant;
  readonly renderResolution: PerformanceMeasurement["renderResolution"];
  readonly runs: readonly PerformanceMeasurement[];
  readonly aggregate: PerformanceCaptureAggregate;
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

interface PerformanceReportV2 {
  readonly schemaVersion: 2;
  readonly capturedAt: string;
  readonly url: string;
  readonly atrousVariant: AtrousVariant;
  readonly runCount: number;
  readonly aggregate: PerformanceCaptureAggregate;
  readonly runs: readonly (FrameTimeMeasurement & { readonly run: number })[];
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

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + upper) / 2
    : upper;
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

export const aggregatePerformanceMeasurements = (
  runs: readonly PerformanceMeasurement[],
): PerformanceCapture => {
  const first = runs[0];
  if (first === undefined) {
    throw new Error("At least one performance measurement is required.");
  }
  const incompatible = runs.some(
    (run) =>
      run.atrousVariant !== first.atrousVariant ||
      run.renderResolution.width !== first.renderResolution.width ||
      run.renderResolution.height !== first.renderResolution.height,
  );
  if (incompatible) {
    throw new Error("Performance runs used different render configurations.");
  }

  const totalDurationMs = runs.reduce(
    (total, run) => total + run.durationMs,
    0,
  );
  const totalSampleCount = runs.reduce(
    (total, run) => total + run.sampleCount,
    0,
  );
  const fpsValues = runs.map((run) => run.fps);

  return {
    atrousVariant: first.atrousVariant,
    renderResolution: first.renderResolution,
    runs,
    aggregate: {
      totalDurationMs,
      totalSampleCount,
      fps: {
        weighted:
          totalDurationMs > 0
            ? (totalSampleCount * 1_000) / totalDurationMs
            : 0,
        medianRun: median(fpsValues),
        minRun: Math.min(...fpsValues),
        maxRun: Math.max(...fpsValues),
      },
      frameTimeMs: {
        weightedMean:
          totalSampleCount > 0
            ? runs.reduce(
                (total, run) => total + run.frameTimeMs.mean * run.sampleCount,
                0,
              ) / totalSampleCount
            : 0,
        medianRunMedian: median(runs.map((run) => run.frameTimeMs.median)),
        medianRunP95: median(runs.map((run) => run.frameTimeMs.p95)),
        min: Math.min(...runs.map((run) => run.frameTimeMs.min)),
        max: Math.max(...runs.map((run) => run.frameTimeMs.max)),
      },
    },
  };
};

const round = (value: number): number => Number(value.toFixed(2));

const roundFrameTimeSummary = (
  summary: FrameTimeSummary,
): FrameTimeSummary => ({
  mean: round(summary.mean),
  median: round(summary.median),
  p95: round(summary.p95),
  min: round(summary.min),
  max: round(summary.max),
});

export const formatPerformanceReport = (
  capture: PerformanceCapture,
  context: PerformanceReportContext,
): string => {
  const report: PerformanceReportV2 = {
    schemaVersion: 2,
    capturedAt: context.capturedAt,
    url: context.url,
    atrousVariant: capture.atrousVariant,
    runCount: capture.runs.length,
    aggregate: {
      totalDurationMs: Math.round(capture.aggregate.totalDurationMs),
      totalSampleCount: capture.aggregate.totalSampleCount,
      fps: {
        weighted: round(capture.aggregate.fps.weighted),
        medianRun: round(capture.aggregate.fps.medianRun),
        minRun: round(capture.aggregate.fps.minRun),
        maxRun: round(capture.aggregate.fps.maxRun),
      },
      frameTimeMs: {
        weightedMean: round(capture.aggregate.frameTimeMs.weightedMean),
        medianRunMedian: round(capture.aggregate.frameTimeMs.medianRunMedian),
        medianRunP95: round(capture.aggregate.frameTimeMs.medianRunP95),
        min: round(capture.aggregate.frameTimeMs.min),
        max: round(capture.aggregate.frameTimeMs.max),
      },
    },
    runs: capture.runs.map((run, index) => ({
      run: index + 1,
      durationMs: Math.round(run.durationMs),
      sampleCount: run.sampleCount,
      fps: round(run.fps),
      frameTimeMs: roundFrameTimeSummary(run.frameTimeMs),
    })),
    renderResolution: capture.renderResolution,
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
  if (atrous === "fallback") {
    sanitized.searchParams.set("atrous", atrous);
  }
  return sanitized.toString();
};
