import { describe, expect, it } from "vitest";

import type { PerformanceMeasurement } from "@/gi/performance";
import {
  aggregatePerformanceMeasurements,
  createPerformanceRecorder,
  formatPerformanceReport,
  sanitizePerformanceReportUrl,
  summarizeFrameTimes,
} from "@/gi/performance";
import { DEFAULT_SETTINGS } from "@/gi/settings";

describe("performance capture", () => {
  it("summarizes frame intervals with elapsed-time FPS", () => {
    const result = summarizeFrameTimes([10, 20, 30, 40, 100], 1_000);

    expect(result).toEqual({
      durationMs: 1_000,
      sampleCount: 5,
      fps: 5,
      frameTimeMs: {
        mean: 40,
        median: 30,
        p95: 100,
        min: 10,
        max: 100,
      },
    });
  });

  it("starts on the first render frame and completes after the duration", () => {
    const recorder = createPerformanceRecorder(100);

    expect(recorder.record(1_000, 250)).toBeNull();
    expect(recorder.record(1_040, 40)).toBeNull();
    expect(recorder.record(1_080, 40)).toBeNull();
    expect(recorder.record(1_120, 40)).toEqual({
      durationMs: 120,
      sampleCount: 3,
      fps: 25,
      frameTimeMs: {
        mean: 40,
        median: 40,
        p95: 40,
        min: 40,
        max: 40,
      },
    });
    expect(recorder.record(1_160, 40)).toBeNull();
  });

  it("aggregates compatible runs without inventing combined percentiles", () => {
    const runs: PerformanceMeasurement[] = [
      {
        durationMs: 1_000,
        sampleCount: 10,
        fps: 10,
        frameTimeMs: {
          mean: 100,
          median: 90,
          p95: 120,
          min: 80,
          max: 130,
        },
        atrousVariant: "fallback",
        renderResolution: { width: 640, height: 480 },
      },
      {
        durationMs: 1_000,
        sampleCount: 20,
        fps: 20,
        frameTimeMs: {
          mean: 50,
          median: 48,
          p95: 70,
          min: 40,
          max: 80,
        },
        atrousVariant: "fallback",
        renderResolution: { width: 640, height: 480 },
      },
      {
        durationMs: 1_000,
        sampleCount: 30,
        fps: 30,
        frameTimeMs: {
          mean: 100 / 3,
          median: 32,
          p95: 60,
          min: 25,
          max: 90,
        },
        atrousVariant: "fallback",
        renderResolution: { width: 640, height: 480 },
      },
    ];

    expect(aggregatePerformanceMeasurements(runs)).toEqual({
      atrousVariant: "fallback",
      renderResolution: { width: 640, height: 480 },
      runs,
      aggregate: {
        totalDurationMs: 3_000,
        totalSampleCount: 60,
        fps: { weighted: 20, medianRun: 20, minRun: 10, maxRun: 30 },
        frameTimeMs: {
          weightedMean: 50,
          medianRunMedian: 48,
          medianRunP95: 70,
          min: 25,
          max: 130,
        },
      },
    });
  });

  it("uses the conventional median for an even number of runs", () => {
    const createRun = (fps: number): PerformanceMeasurement => ({
      durationMs: 1_000,
      sampleCount: fps,
      fps,
      frameTimeMs: { mean: 100, median: 100, p95: 100, min: 100, max: 100 },
      atrousVariant: "fallback",
      renderResolution: { width: 640, height: 480 },
    });

    expect(
      aggregatePerformanceMeasurements([createRun(10), createRun(30)]).aggregate
        .fps.medianRun,
    ).toBe(20);
  });

  it("rejects runs captured with different render configurations", () => {
    const base: PerformanceMeasurement = {
      durationMs: 1_000,
      sampleCount: 10,
      fps: 10,
      frameTimeMs: { mean: 100, median: 100, p95: 100, min: 100, max: 100 },
      atrousVariant: "fallback",
      renderResolution: { width: 640, height: 480 },
    };

    expect(() =>
      aggregatePerformanceMeasurements([
        base,
        { ...base, renderResolution: { width: 320, height: 240 } },
      ]),
    ).toThrow("Performance runs used different render configurations.");
  });

  it("formats a pasteable multi-run report with the render context", () => {
    const run: PerformanceMeasurement = {
      ...summarizeFrameTimes([16.666, 17.333], 34),
      atrousVariant: "tiled-16",
      renderResolution: { width: 1080, height: 2208 },
    };
    const report = JSON.parse(
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
      schemaVersion: 2,
      atrousVariant: "tiled-16",
      runCount: 3,
      aggregate: {
        totalDurationMs: 102,
        totalSampleCount: 6,
        fps: {
          weighted: 58.82,
          medianRun: 58.82,
          minRun: 58.82,
          maxRun: 58.82,
        },
        frameTimeMs: {
          weightedMean: 17,
          medianRunMedian: 16.67,
          medianRunP95: 17.33,
          min: 16.67,
          max: 17.33,
        },
      },
      renderResolution: { width: 1080, height: 2208 },
      userAgent: "test browser",
    });
    expect(report.runs).toHaveLength(3);
    expect(report.runs[0]).toEqual({
      run: 1,
      durationMs: 34,
      sampleCount: 2,
      fps: 58.82,
      frameTimeMs: {
        mean: 17,
        median: 16.67,
        p95: 17.33,
        min: 16.67,
        max: 17.33,
      },
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
    expect(Object.keys(report.aggregate.frameTimeMs)).toEqual([
      "weightedMean",
      "medianRunMedian",
      "medianRunP95",
      "min",
      "max",
    ]);
  });

  it("keeps only the supported a-trous selector in the report URL", () => {
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
        "https://example.com/demo?atrous=unknown&user=42",
      ),
    ).toBe("https://example.com/demo");
  });
});
