import type { AtrousVariant } from "@/gi/atrous";
import type { RenderSettings } from "@/gi/settings";

export const PERFORMANCE_CAPTURE_DURATION_MS = 5_000;
export const PERFORMANCE_CAPTURE_RUN_COUNT = 3;

/**
 * Frames dropped before sampling starts. One frame is not enough: shader
 * compilation and the GPU's clock ramp both run well past it, and everything
 * they inflate lands in the window as if it were steady-state cost.
 */
export const PERFORMANCE_WARMUP_FRAMES = 30;

/**
 * A run whose later frames are this much slower than its earlier ones is
 * flagged. The threshold is deliberately loose — it exists to catch a device
 * clocking down mid-capture, not to resolve small differences.
 */
export const DRIFT_WARNING_RATIO = 1.1;

export interface DurationSummary {
  readonly mean: number;
  readonly median: number;
  readonly p95: number;
  readonly min: number;
  readonly max: number;
}

/**
 * One frame's GPU cost. `frameMs` spans the first pass's start to the last
 * pass's end, so it is a duration that actually elapsed rather than a sum of
 * per-pass medians drawn from different frames.
 */
export interface GpuFrameSample {
  readonly frameMs: number;
  readonly passMs: Readonly<Record<string, number>>;
}

/**
 * How much of the window the samples cover. A median over a fifth of the
 * frames is a different claim from one over all of them; `coverage` is what
 * tells the two apart.
 */
export interface SamplingSummary {
  readonly windowMs: number;
  readonly callbacks: number;
  readonly sampled: number;
  readonly rejected: number;
  readonly coverage: number;
  readonly warmupFrames: number;
}

/**
 * Wall-clock behaviour of the presentation loop. Kept as diagnostics only —
 * these describe how often frames reached the screen, which is a property of
 * the display and the browser's scheduling, not of the renderer's cost.
 */
export interface PresentationSummary {
  readonly callbackIntervalMs: DurationSummary;
  readonly vsyncBound: boolean;
  readonly displayPeriodMs: number | null;
}

/**
 * GPU timing is a runtime capability, not a device property — the same phone
 * can expose `timestamp-query` under one browser build and not the next. The
 * union makes a capture that lacks it say so.
 */
export type Measurement =
  | {
      readonly kind: "gpuTimestamp";
      readonly frameMs: DurationSummary;
      readonly passMs: Readonly<Record<string, DurationSummary>>;
      readonly sampling: SamplingSummary;
    }
  | {
      readonly kind: "wallFallback";
      readonly reason: string;
      readonly sampling: SamplingSummary;
    };

export interface PerformanceMeasurement {
  readonly measurement: Measurement;
  readonly presentation: PresentationSummary;
  readonly atrousVariant: AtrousVariant;
  readonly renderResolution: {
    readonly width: number;
    readonly height: number;
  };
}

/**
 * A drift signal, never a verdict: DVFS does not move compute-bound and
 * bandwidth-bound passes by the same factor, so an absent warning does not
 * clear a capture.
 */
export interface DriftWarning {
  readonly kind: "runTrend" | "rayFreeRatio";
  readonly detail: string;
  readonly ratio: number;
}

export interface PerformanceCaptureAggregate {
  readonly totalWindowMs: number;
  readonly totalSampleCount: number;
  /** Null when no run carried GPU timing. */
  readonly gpuFrameMs: {
    readonly medianRun: number;
    readonly medianRunP95: number;
    readonly minRun: number;
    readonly maxRun: number;
  } | null;
  readonly warnings: readonly DriftWarning[];
}

export interface PerformanceCapture {
  readonly atrousVariant: AtrousVariant;
  readonly renderResolution: PerformanceMeasurement["renderResolution"];
  /** Temporal order is load-bearing: the drift check reads first against last. */
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

/**
 * Per-frame input to a capture. `gpu` is absent on frames the probe did not
 * sample; `accepted` is false for frames the capture refuses to count.
 */
export interface FrameObservation {
  readonly at: number;
  readonly callbackIntervalMs: number;
  readonly accepted: boolean;
  readonly gpu?: GpuFrameSample | null;
  /** False when the device never offered GPU timing, which names the fallback. */
  readonly gpuSupported?: boolean;
}

export interface PerformanceRecorder {
  readonly observe: (frame: FrameObservation) => RecorderResult | null;
}

export interface RecorderResult {
  readonly measurement: Measurement;
  readonly presentation: PresentationSummary;
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

export const summarizeDurations = (
  samples: readonly number[],
): DurationSummary => {
  const sorted = [...samples].sort((left, right) => left - right);
  const total = samples.reduce((sum, value) => sum + value, 0);
  return {
    mean: samples.length > 0 ? total / samples.length : 0,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    min: sorted[0] ?? 0,
    max: sorted.at(-1) ?? 0,
  };
};

/** Display periods a capture may sit on, in ms: 120Hz, 90Hz, 60Hz. */
const DISPLAY_PERIODS_MS = [1_000 / 120, 1_000 / 90, 1_000 / 60];
const VSYNC_TOLERANCE_MS = 0.8;

const matchDisplayPeriod = (medianIntervalMs: number): number | null =>
  DISPLAY_PERIODS_MS.find(
    (period) => Math.abs(medianIntervalMs - period) < VSYNC_TOLERANCE_MS,
  ) ?? null;

/**
 * Collects one run. The window and the sample set are advanced by the same
 * frames: a frame the capture rejects moves neither, so a coverage gap can no
 * longer inflate the denominator while leaving the numerator alone.
 */
export const createPerformanceRecorder = (
  durationMs = PERFORMANCE_CAPTURE_DURATION_MS,
  warmupFrames = PERFORMANCE_WARMUP_FRAMES,
): PerformanceRecorder => {
  let startedAt: number | null = null;
  let warmedFrames = 0;
  let completed = false;
  let callbacks = 0;
  let rejected = 0;
  let gpuSupported = true;
  const intervals: number[] = [];
  const gpuSamples: GpuFrameSample[] = [];

  const finish = (windowMs: number): RecorderResult => {
    const sampling: SamplingSummary = {
      windowMs,
      callbacks,
      sampled: gpuSamples.length,
      rejected,
      coverage: callbacks > 0 ? gpuSamples.length / callbacks : 0,
      warmupFrames,
    };
    const presentation: PresentationSummary = {
      callbackIntervalMs: summarizeDurations(intervals),
      vsyncBound:
        matchDisplayPeriod(summarizeDurations(intervals).median) !== null,
      displayPeriodMs: matchDisplayPeriod(summarizeDurations(intervals).median),
    };

    if (gpuSamples.length === 0) {
      return {
        measurement: {
          kind: "wallFallback",
          reason: wallFallbackReason(gpuSupported, sampling.sampled),
          sampling,
        },
        presentation,
      };
    }

    const passLabels = new Set<string>();
    for (const sample of gpuSamples) {
      for (const label of Object.keys(sample.passMs)) passLabels.add(label);
    }
    const passMs: Record<string, DurationSummary> = {};
    for (const label of passLabels) {
      passMs[label] = summarizeDurations(
        gpuSamples.flatMap((sample) => {
          const value = sample.passMs[label];
          return value === undefined ? [] : [value];
        }),
      );
    }

    return {
      measurement: {
        kind: "gpuTimestamp",
        frameMs: summarizeDurations(gpuSamples.map((sample) => sample.frameMs)),
        passMs,
        sampling,
      },
      presentation,
    };
  };

  return {
    observe: (frame) => {
      if (completed) return null;
      if (warmedFrames < warmupFrames) {
        warmedFrames += 1;
        return null;
      }
      if (startedAt === null) {
        startedAt = frame.at;
        return null;
      }

      callbacks += 1;
      if (frame.gpuSupported === false) gpuSupported = false;
      if (!frame.accepted) {
        rejected += 1;
      } else {
        if (
          Number.isFinite(frame.callbackIntervalMs) &&
          frame.callbackIntervalMs > 0
        ) {
          intervals.push(frame.callbackIntervalMs);
        }
        if (frame.gpu != null && frame.gpu.frameMs > 0)
          gpuSamples.push(frame.gpu);
      }

      const windowMs = frame.at - startedAt;
      if (windowMs < durationMs) return null;

      completed = true;
      return finish(windowMs);
    },
  };
};

/** Marks a capture whose GPU timing never arrived, so the reason survives. */
export const wallFallbackReason = (
  supported: boolean,
  sampled: number,
): string =>
  supported
    ? `The GPU reported no timestamps across ${String(sampled)} sampled frames.`
    : "This browser or device does not expose timestamp-query.";

const gpuFrame = (run: PerformanceMeasurement): DurationSummary | null =>
  run.measurement.kind === "gpuTimestamp" ? run.measurement.frameMs : null;

/**
 * Passes that trace no rays. A device clocking down slows these in step with
 * the ray-tracing passes; a change to ray traversal does not touch them, so a
 * proportional rise across both is the shape a thermal event leaves behind.
 */
const RAY_FREE_PASS = /^(atrous|temporal|shade)/;

const detectDrift = (
  runs: readonly PerformanceMeasurement[],
): DriftWarning[] => {
  const warnings: DriftWarning[] = [];
  const frames = runs.map(gpuFrame);
  const first = frames[0];
  const last = frames.at(-1);

  if (first != null && last != null && first.median > 0) {
    const ratio = last.median / first.median;
    // Monotonicity, not spread: a run-to-run climb is a device changing state,
    // while the same range arriving unordered is ordinary noise.
    const medians = frames.flatMap((frame) =>
      frame == null ? [] : [frame.median],
    );
    const monotone = medians.every(
      (value, index) => index === 0 || value >= (medians[index - 1] ?? 0),
    );
    if (monotone && ratio >= DRIFT_WARNING_RATIO) {
      warnings.push({
        kind: "runTrend",
        detail: `Run medians rose monotonically from ${first.median.toFixed(2)}ms to ${last.median.toFixed(2)}ms across the capture; the device may have been clocking down.`,
        ratio,
      });
    }
  }

  const rayFreeRatio = (run: PerformanceMeasurement): number | null => {
    if (run.measurement.kind !== "gpuTimestamp") return null;
    const entries = Object.entries(run.measurement.passMs);
    const rayFree = entries.filter(([label]) => RAY_FREE_PASS.test(label));
    const traced = entries.filter(([label]) => !RAY_FREE_PASS.test(label));
    // The signal needs both halves present: with the à-trous stage toggled off
    // the denominator vanishes, and a ratio built on what is left says nothing.
    if (rayFree.length === 0 || traced.length === 0) return null;
    const sum = (list: [string, DurationSummary][]): number =>
      list.reduce((total, [, value]) => total + value.median, 0);
    const tracedMs = sum(traced);
    return tracedMs > 0 ? sum(rayFree) / tracedMs : null;
  };

  const firstRun = runs[0];
  const lastRun = runs.at(-1);
  if (firstRun !== undefined && lastRun !== undefined && runs.length > 1) {
    const firstRatio = rayFreeRatio(firstRun);
    const lastRatio = rayFreeRatio(lastRun);
    const firstFrame = gpuFrame(firstRun);
    const lastFrame = gpuFrame(lastRun);
    if (
      firstRatio != null &&
      lastRatio != null &&
      firstFrame != null &&
      lastFrame != null &&
      firstFrame.median > 0 &&
      lastFrame.median / firstFrame.median >= DRIFT_WARNING_RATIO &&
      // Ray-free and ray-tracing passes keeping their proportion while both
      // grow points away from the traversal code and towards the device.
      Math.abs(lastRatio - firstRatio) / Math.max(firstRatio, 1e-6) < 0.15
    ) {
      warnings.push({
        kind: "rayFreeRatio",
        detail:
          "Ray-free passes slowed in proportion with the ray-tracing passes, which a change to ray traversal would not do. Treat this capture as thermally suspect rather than as a measured regression.",
        ratio: lastFrame.median / firstFrame.median,
      });
    }
  }

  return warnings;
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

  const totalWindowMs = runs.reduce(
    (total, run) => total + run.measurement.sampling.windowMs,
    0,
  );
  const totalSampleCount = runs.reduce(
    (total, run) => total + run.measurement.sampling.sampled,
    0,
  );
  const frames = runs.flatMap((run) => {
    const frame = gpuFrame(run);
    return frame === null ? [] : [frame];
  });

  return {
    atrousVariant: first.atrousVariant,
    renderResolution: first.renderResolution,
    runs,
    aggregate: {
      totalWindowMs,
      totalSampleCount,
      gpuFrameMs:
        frames.length > 0
          ? {
              medianRun: median(frames.map((frame) => frame.median)),
              medianRunP95: median(frames.map((frame) => frame.p95)),
              minRun: Math.min(...frames.map((frame) => frame.min)),
              maxRun: Math.max(...frames.map((frame) => frame.max)),
            }
          : null,
      warnings: detectDrift(runs),
    },
  };
};

const round = (value: number): number => Number(value.toFixed(2));

const roundDurations = (summary: DurationSummary): DurationSummary => ({
  mean: round(summary.mean),
  median: round(summary.median),
  p95: round(summary.p95),
  min: round(summary.min),
  max: round(summary.max),
});

const roundMeasurement = (measurement: Measurement): Measurement => {
  const sampling: SamplingSummary = {
    ...measurement.sampling,
    windowMs: Math.round(measurement.sampling.windowMs),
    coverage: Number(measurement.sampling.coverage.toFixed(3)),
  };
  if (measurement.kind === "wallFallback") return { ...measurement, sampling };
  const passMs: Record<string, DurationSummary> = {};
  for (const [label, summary] of Object.entries(measurement.passMs)) {
    passMs[label] = roundDurations(summary);
  }
  return {
    ...measurement,
    frameMs: roundDurations(measurement.frameMs),
    passMs,
    sampling,
  };
};

interface PerformanceReportV3 {
  readonly schemaVersion: 3;
  readonly capturedAt: string;
  readonly url: string;
  readonly atrousVariant: AtrousVariant;
  readonly runCount: number;
  readonly aggregate: PerformanceCaptureAggregate;
  readonly runs: readonly (PerformanceMeasurement & { readonly run: number })[];
  readonly renderResolution: PerformanceMeasurement["renderResolution"];
  readonly viewport: PerformanceReportContext["viewport"];
  readonly devicePixelRatio: number;
  readonly settings: RenderSettings;
  readonly userAgent: string;
}

export const formatPerformanceReport = (
  capture: PerformanceCapture,
  context: PerformanceReportContext,
): string => {
  const { gpuFrameMs } = capture.aggregate;
  const report: PerformanceReportV3 = {
    schemaVersion: 3,
    capturedAt: context.capturedAt,
    url: context.url,
    atrousVariant: capture.atrousVariant,
    runCount: capture.runs.length,
    aggregate: {
      totalWindowMs: Math.round(capture.aggregate.totalWindowMs),
      totalSampleCount: capture.aggregate.totalSampleCount,
      gpuFrameMs:
        gpuFrameMs === null
          ? null
          : {
              medianRun: round(gpuFrameMs.medianRun),
              medianRunP95: round(gpuFrameMs.medianRunP95),
              minRun: round(gpuFrameMs.minRun),
              maxRun: round(gpuFrameMs.maxRun),
            },
      warnings: capture.aggregate.warnings.map((warning) => ({
        ...warning,
        ratio: round(warning.ratio),
      })),
    },
    runs: capture.runs.map((run, index) => ({
      run: index + 1,
      measurement: roundMeasurement(run.measurement),
      presentation: {
        ...run.presentation,
        callbackIntervalMs: roundDurations(run.presentation.callbackIntervalMs),
        displayPeriodMs:
          run.presentation.displayPeriodMs === null
            ? null
            : round(run.presentation.displayPeriodMs),
      },
      atrousVariant: run.atrousVariant,
      renderResolution: run.renderResolution,
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
