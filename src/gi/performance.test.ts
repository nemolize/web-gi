import { describe, expect, it } from "vitest";

import type { GpuFrameSample, PerformanceMeasurement } from "@/gi/performance";
import {
  aggregatePerformanceMeasurements,
  createPerformanceRecorder,
  formatPerformanceReport,
  sanitizePerformanceReportUrl,
  summarizeDurations,
} from "@/gi/performance";
import { DEFAULT_SETTINGS } from "@/gi/settings";

const gpuSample = (frameMs: number): GpuFrameSample => ({
  frameMs,
  passMs: { gi: frameMs * 0.6, atrous: frameMs * 0.4 },
});

const measurement = (
  frameMs: number,
  passMs: Record<string, number> = { gi: frameMs * 0.6, atrous: frameMs * 0.4 },
): PerformanceMeasurement => ({
  measurement: {
    kind: "gpuTimestamp",
    frameMs: summarizeDurations([frameMs]),
    passMs: Object.fromEntries(
      Object.entries(passMs).map(([label, value]) => [
        label,
        summarizeDurations([value]),
      ]),
    ),
    sampling: {
      windowMs: 5_000,
      callbacks: 100,
      sampled: 100,
      rejected: 0,
      coverage: 1,
      warmupFrames: 30,
    },
  },
  presentation: {
    callbackIntervalMs: summarizeDurations([8.33]),
    vsyncBound: true,
    displayPeriodMs: 8.33,
  },
  atrousVariant: "tiled-16",
  renderResolution: { width: 640, height: 480 },
});

describe("performance capture", () => {
  it("summarizes a set of durations", () => {
    expect(summarizeDurations([10, 20, 30, 40, 100])).toEqual({
      mean: 40,
      median: 30,
      p95: 100,
      min: 10,
      max: 100,
    });
  });

  it("discards warm-up frames before opening the window", () => {
    const recorder = createPerformanceRecorder(100, 2);

    // Two warm-up frames, then the frame that sets the window's origin.
    expect(
      recorder.observe({ at: 0, callbackIntervalMs: 40, accepted: true }),
    ).toBeNull();
    expect(
      recorder.observe({ at: 40, callbackIntervalMs: 40, accepted: true }),
    ).toBeNull();
    expect(
      recorder.observe({ at: 80, callbackIntervalMs: 40, accepted: true }),
    ).toBeNull();

    const result = recorder.observe({
      at: 200,
      callbackIntervalMs: 40,
      accepted: true,
      gpu: gpuSample(5),
    });
    expect(result?.measurement.sampling.windowMs).toBe(120);
  });

  it("counts a rejected frame without letting it advance the sample set", () => {
    const recorder = createPerformanceRecorder(100, 0);
    recorder.observe({ at: 0, callbackIntervalMs: 40, accepted: true });
    recorder.observe({
      at: 40,
      callbackIntervalMs: 40,
      accepted: false,
      gpu: gpuSample(5),
    });

    const result = recorder.observe({
      at: 140,
      callbackIntervalMs: 40,
      accepted: true,
      gpu: gpuSample(5),
    });

    const sampling = result?.measurement.sampling;
    expect(sampling?.callbacks).toBe(2);
    expect(sampling?.rejected).toBe(1);
    // The rejected frame contributed no sample, and `coverage` says so rather
    // than leaving the median to look like it covered the whole window.
    expect(sampling?.sampled).toBe(1);
    expect(sampling?.coverage).toBe(0.5);
  });

  it("falls back with a stated reason when the device offers no GPU timing", () => {
    const recorder = createPerformanceRecorder(50, 0);
    recorder.observe({
      at: 0,
      callbackIntervalMs: 16,
      accepted: true,
      gpuSupported: false,
    });
    const result = recorder.observe({
      at: 60,
      callbackIntervalMs: 16,
      accepted: true,
      gpuSupported: false,
    });

    expect(result?.measurement.kind).toBe("wallFallback");
    expect(
      result?.measurement.kind === "wallFallback" && result.measurement.reason,
    ).toContain("does not expose timestamp-query");
  });

  it("reads the display period from the intervals the loop kept up on", () => {
    // Real jitter puts the fastest callbacks below the period, so `min` names
    // no display at all; the quarter mark is where the refresh rate sits.
    const recorder = createPerformanceRecorder(400, 0);
    const intervals = [6.4, 8.3, 8.3, 8.3, 8.3, 9.9, 10.3];
    intervals.forEach((interval, index) => {
      recorder.observe({
        at: index * 50,
        callbackIntervalMs: interval,
        accepted: true,
        gpu: gpuSample(5.2),
      });
    });
    const result = recorder.observe({
      at: 500,
      callbackIntervalMs: 8.3,
      accepted: true,
      gpu: gpuSample(5.2),
    });

    expect(result?.presentation.displayPeriodMs).toBeCloseTo(8.33, 1);
    expect(result?.presentation.vsyncBound).toBe(true);
  });

  it("does not call a frame vsync-bound when the GPU overruns the display", () => {
    // The shape an Android capture produced: the loop touches the 8.33ms
    // refresh on the frames it makes while the GPU needs 42ms. Reading the
    // interval alone once reported that display as the binding constraint.
    const recorder = createPerformanceRecorder(400, 0);
    [8.3, 8.3, 8.3, 34, 122, 130].forEach((interval, index) => {
      recorder.observe({
        at: index * 50,
        callbackIntervalMs: interval,
        accepted: true,
        gpu: gpuSample(42),
      });
    });
    const result = recorder.observe({
      at: 500,
      callbackIntervalMs: 130,
      accepted: true,
      gpu: gpuSample(42),
    });

    expect(result?.presentation.displayPeriodMs).toBeCloseTo(8.33, 1);
    expect(result?.presentation.vsyncBound).toBe(false);
  });

  it("rejects runs captured with different render configurations", () => {
    const base = measurement(6);

    expect(() =>
      aggregatePerformanceMeasurements([
        base,
        { ...base, renderResolution: { width: 320, height: 240 } },
      ]),
    ).toThrow("Performance runs used different render configurations.");
  });

  it("warns when run medians climb monotonically across the capture", () => {
    const capture = aggregatePerformanceMeasurements([
      measurement(6),
      measurement(7),
      measurement(8.4),
    ]);

    const trend = capture.aggregate.warnings.find(
      (warning) => warning.kind === "runTrend",
    );
    expect(trend).toBeDefined();
    expect(trend?.ratio).toBeCloseTo(1.4, 5);
  });

  it("stays quiet when the same spread arrives unordered", () => {
    const capture = aggregatePerformanceMeasurements([
      measurement(8.4),
      measurement(6),
      measurement(7),
    ]);

    expect(
      capture.aggregate.warnings.some((warning) => warning.kind === "runTrend"),
    ).toBe(false);
  });

  it("flags a slowdown that spared no pass as thermally suspect", () => {
    // Every pass rises by the same factor — including the ray-free ones, which
    // a change to ray traversal could not touch.
    const capture = aggregatePerformanceMeasurements([
      measurement(6, { gi: 3.6, atrous: 2.4 }),
      measurement(7.2, { gi: 4.32, atrous: 2.88 }),
      measurement(8.4, { gi: 5.04, atrous: 3.36 }),
    ]);

    expect(
      capture.aggregate.warnings.some(
        (warning) => warning.kind === "rayFreeRatio",
      ),
    ).toBe(true);
  });

  it("does not flag a slowdown confined to the ray-tracing passes", () => {
    const capture = aggregatePerformanceMeasurements([
      measurement(6, { gi: 3.6, atrous: 2.4 }),
      measurement(7.2, { gi: 4.8, atrous: 2.4 }),
      measurement(8.4, { gi: 6, atrous: 2.4 }),
    ]);

    expect(
      capture.aggregate.warnings.some(
        (warning) => warning.kind === "rayFreeRatio",
      ),
    ).toBe(false);
  });

  it("formats a pasteable report keyed on GPU time", () => {
    const run = measurement(6);
    const report: Record<string, unknown> = JSON.parse(
      formatPerformanceReport(
        aggregatePerformanceMeasurements([run, run, run]),
        {
          capturedAt: "2026-08-06T00:00:00.000Z",
          url: "https://example.com/",
          viewport: { width: 412, height: 842 },
          devicePixelRatio: 2.625,
          settings: DEFAULT_SETTINGS,
          userAgent: "test browser",
        },
      ),
    );

    expect(report).toMatchObject({
      schemaVersion: 3,
      atrousVariant: "tiled-16",
      runCount: 3,
      aggregate: {
        totalWindowMs: 15_000,
        totalSampleCount: 300,
        gpuFrameMs: { medianRun: 6, minRun: 6, maxRun: 6 },
        warnings: [],
      },
      userAgent: "test browser",
    });
    expect(Object.keys(report)).toEqual([
      "schemaVersion",
      "capturedAt",
      "url",
      "atrousVariant",
      "runCount",
      "aggregate",
      "runs",
      "renderResolution",
      "viewport",
      "devicePixelRatio",
      "settings",
      "userAgent",
    ]);
  });

  it("reports a null GPU aggregate when no run carried timing", () => {
    const fallback: PerformanceMeasurement = {
      ...measurement(6),
      measurement: {
        kind: "wallFallback",
        reason: "This browser or device does not expose timestamp-query.",
        sampling: {
          windowMs: 5_000,
          callbacks: 100,
          sampled: 0,
          rejected: 0,
          coverage: 0,
          warmupFrames: 30,
        },
      },
    };

    expect(
      aggregatePerformanceMeasurements([fallback]).aggregate.gpuFrameMs,
    ).toBeNull();
  });

  it("keeps only supported benchmark selectors in the report URL", () => {
    expect(
      sanitizePerformanceReportUrl(
        "https://example.com/demo?atrous=fallback&token=secret#private",
      ),
    ).toBe("https://example.com/demo?atrous=fallback");
    expect(
      sanitizePerformanceReportUrl(
        "https://example.com/demo?atrous=8&token=secret#private",
      ),
    ).toBe("https://example.com/demo");
    expect(
      sanitizePerformanceReportUrl(
        "https://example.com/demo?preset=heavy&mode=path-traced&measure=auto&token=secret#private",
      ),
    ).toBe(
      "https://example.com/demo?preset=heavy&mode=path-traced&measure=auto",
    );
    expect(
      sanitizePerformanceReportUrl(
        "https://example.com/demo?preset=heavy&compare=restir&mode=path-traced&measure=auto&token=secret",
      ),
    ).toBe("https://example.com/demo?preset=heavy&compare=restir");
    expect(
      sanitizePerformanceReportUrl(
        "https://example.com/demo?preset=matrix&compare=restir&token=secret#private",
      ),
    ).toBe("https://example.com/demo?preset=matrix");
  });
});
