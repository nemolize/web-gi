import { describe, expect, it } from "vitest";

import {
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

  it("formats a pasteable report with the render context", () => {
    const report = JSON.parse(
      formatPerformanceReport(
        {
          ...summarizeFrameTimes([16.666, 17.333], 34),
          atrousVariant: "tiled-8",
          renderResolution: { width: 1080, height: 2208 },
        },
        {
          capturedAt: "2026-08-06T00:00:00.000Z",
          url: "https://example.com/?atrous=8",
          viewport: { width: 412, height: 842 },
          devicePixelRatio: 2.625,
          settings: DEFAULT_SETTINGS,
          userAgent: "test browser",
        },
      ),
    );

    expect(report).toMatchObject({
      schemaVersion: 1,
      atrousVariant: "tiled-8",
      durationMs: 34,
      sampleCount: 2,
      fps: 58.82,
      frameTimeMs: {
        mean: 17,
        median: 16.67,
        p95: 17.33,
      },
      renderResolution: { width: 1080, height: 2208 },
      userAgent: "test browser",
    });
    expect(Object.keys(report)).toEqual([
      "schemaVersion",
      "capturedAt",
      "url",
      "atrousVariant",
      "durationMs",
      "sampleCount",
      "fps",
      "frameTimeMs",
      "renderResolution",
      "viewport",
      "devicePixelRatio",
      "settings",
      "userAgent",
    ]);
    expect(Object.keys(report.frameTimeMs)).toEqual([
      "mean",
      "median",
      "p95",
      "min",
      "max",
    ]);
  });

  it("keeps only the supported a-trous selector in the report URL", () => {
    expect(
      sanitizePerformanceReportUrl(
        "https://example.com/demo?atrous=8&token=secret#private",
      ),
    ).toBe("https://example.com/demo?atrous=8");
    expect(
      sanitizePerformanceReportUrl(
        "https://example.com/demo?atrous=unknown&user=42",
      ),
    ).toBe("https://example.com/demo");
  });
});
