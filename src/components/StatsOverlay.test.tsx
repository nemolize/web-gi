import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StatsOverlay } from "@/components/StatsOverlay";
import { DEFAULT_CAMERA } from "@/gi/camera";
import {
  COMPARISON_MATRIX_BUDGET,
  COMPARISON_MATRIX_PROBE_BUDGET,
  DEFAULT_COMPARISON_MATRIX_REPEATS,
} from "@/gi/comparison-matrix";
import type { PerformanceMeasurement } from "@/gi/performance";
import { DEFAULT_SETTINGS } from "@/gi/settings";

const summary = (value: number) => ({
  mean: value,
  median: value,
  p95: value,
  min: value,
  max: value,
});

const measurement: PerformanceMeasurement = {
  measurement: {
    kind: "gpuTimestamp",
    frameMs: summary(33.1),
    passMs: { gi: summary(20), atrous: summary(13.1) },
    sampling: {
      windowMs: 5_010,
      callbacks: 151,
      sampled: 151,
      rejected: 0,
      coverage: 1,
      warmupFrames: 30,
    },
  },
  presentation: {
    callbackIntervalMs: summary(33.18),
    vsyncBound: false,
    displayPeriodMs: null,
  },
  atrousVariant: "fallback",
  renderResolution: { width: 1080, height: 2208 },
};

const comparisonReport = {
  luminanceRatio: 1,
  relativeL2: 0.01234,
  meanAbsolute: 0.05678,
  maxAbsolute: 0.5,
  outliers: 2,
  pixels: 100,
  label: "path-traced",
  mode: "path-traced" as const,
  requestedDurationMs: 5_000,
  actualDurationMs: 5_012,
  targetFrames: 240,
  referenceFrames: 2_048,
  referenceActualDurationMs: 25_600,
  context: {
    atrousVariant: "tiled-16" as const,
    scene: "classic" as const,
    maxBounces: 3,
    width: 640,
    height: 480,
    camera: {
      pos: { x: 0, y: 0, z: 2 },
      forward: { x: 0, y: 0, z: -1 },
      right: { x: 1, y: 0, z: 0 },
      up: { x: 0, y: 1, z: 0 },
      tanHalfFov: 0.25,
      aspect: 4 / 3,
    },
    settings: { ...DEFAULT_SETTINGS, mode: "path-traced" as const },
  },
};

const inertComparisonProps = () => ({
  saveComparisonReference: vi.fn().mockResolvedValue(false),
  compareReferenceAfter: vi.fn().mockResolvedValue(null),
  runAutomaticComparison: vi.fn().mockResolvedValue(null),
  runAutomaticComparisonMatrix: vi.fn().mockResolvedValue({
    kind: "comparison-matrix",
    requestedReferenceFrames: 2_048,
    requestedDurationMs: 5_000,
    repeats: 0,
    runs: [],
  }),
});

describe("StatsOverlay performance capture", () => {
  const writeText = vi.fn<(text: string) => Promise<void>>();

  beforeEach(() => {
    writeText.mockReset();
    writeText.mockResolvedValue();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("measures and copies a structured report on a second user action", async () => {
    const measurePerformance = vi.fn().mockResolvedValue(measurement);
    render(
      <StatsOverlay
        {...inertComparisonProps()}
        stats={{
          width: 1080,
          height: 2208,
          accumFrames: 42,
          frameMs: 33.1,
          atrousVariant: "fallback",
        }}
        settings={DEFAULT_SETTINGS}
        measurePerformance={measurePerformance}
      />,
    );

    const measureButton = screen.getByRole("button", {
      name: "Measure 3×5 s",
    });
    fireEvent.click(measureButton);

    await screen.findByText(/33.10 ms GPU median run/);
    expect(measurePerformance).toHaveBeenCalledTimes(3);
    const copyButton = screen.getByRole("button", { name: "Copy result" });
    expect(copyButton).toBe(measureButton);
    expect(
      screen.getByText("Measurement complete. Copy result is ready."),
    ).toBeVisible();
    fireEvent.click(copyButton);

    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    const copied = JSON.parse(writeText.mock.calls[0]?.[0] ?? "");
    expect(copied).toMatchObject({
      schemaVersion: 3,
      atrousVariant: "fallback",
      runCount: 3,
      aggregate: {
        totalSampleCount: 453,
        gpuFrameMs: { medianRun: 33.1 },
      },
      renderResolution: { width: 1080, height: 2208 },
    });
    expect(copied.runs).toHaveLength(3);
    expect(screen.getByText("Result copied to clipboard.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Copy again" })).toBeVisible();

    const againButton = screen.getByRole("button", { name: "Measure again" });
    againButton.focus();
    fireEvent.click(againButton);
    expect(measureButton).toHaveFocus();
  });

  it("starts one three-run capture when automatic measurement is requested", async () => {
    const measurePerformance = vi.fn().mockResolvedValue(measurement);
    const props = {
      ...inertComparisonProps(),
      stats: {
        width: 1080,
        height: 2208,
        accumFrames: 42,
        frameMs: 33.1,
        atrousVariant: "fallback" as const,
      },
      settings: DEFAULT_SETTINGS,
      measurePerformance,
      autoMeasure: true,
    };
    const { rerender } = render(
      <StrictMode>
        <StatsOverlay {...props} />
      </StrictMode>,
    );

    await screen.findByText(/33.10 ms GPU median run/);
    expect(measurePerformance).toHaveBeenCalledTimes(3);
    rerender(
      <StrictMode>
        <StatsOverlay {...props} />
      </StrictMode>,
    );
    await waitFor(() => expect(measurePerformance).toHaveBeenCalledTimes(3));
  });

  it("saves and compares linear development captures", async () => {
    const saveReference = vi.fn().mockResolvedValue(true);
    const compareReferenceAfter = vi.fn().mockResolvedValue(comparisonReport);
    const stats = {
      width: 640,
      height: 480,
      accumFrames: 42,
      frameMs: 16,
      atrousVariant: "tiled-16" as const,
    };
    const measurePerformance = vi.fn();
    const { rerender } = render(
      <StatsOverlay
        saveComparisonReference={saveReference}
        compareReferenceAfter={compareReferenceAfter}
        runAutomaticComparison={vi.fn().mockResolvedValue(null)}
        runAutomaticComparisonMatrix={vi.fn()}
        stats={stats}
        settings={{ ...DEFAULT_SETTINGS, mode: "reference" }}
        measurePerformance={measurePerformance}
      />,
    );

    expect(screen.getByRole("button", { name: "Compare 5 s" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save ref" }));
    expect(await screen.findByText("Reference saved.")).toBeVisible();
    rerender(
      <StatsOverlay
        saveComparisonReference={saveReference}
        compareReferenceAfter={compareReferenceAfter}
        runAutomaticComparison={vi.fn().mockResolvedValue(null)}
        runAutomaticComparisonMatrix={vi.fn()}
        stats={stats}
        settings={{ ...DEFAULT_SETTINGS, mode: "path-traced" }}
        measurePerformance={measurePerformance}
      />,
    );
    expect(screen.getByRole("button", { name: "Save ref" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Compare 5 s" }));
    expect(
      await screen.findByText(
        "path-traced · saved 640×480 eye 0.000,0.000,2.000 · relative L2 0.0123 · mean absolute 0.0568 · 240 frames in 5.01 s",
      ),
    ).toBeVisible();
    expect(compareReferenceAfter).toHaveBeenCalledWith("path-traced", 5_000);
  });

  it("automates a fixed-size reference and equal-time comparison once", async () => {
    const automaticComparisonReport = {
      ...comparisonReport,
      referenceFrames: 1_024,
      referenceActualDurationMs: 12_800,
    };
    const runAutomaticComparison = vi
      .fn()
      .mockResolvedValue(automaticComparisonReport);
    render(
      <StrictMode>
        <StatsOverlay
          {...inertComparisonProps()}
          runAutomaticComparison={runAutomaticComparison}
          measurePerformance={vi.fn()}
          autoCompareMode="path-traced"
          stats={{
            width: 640,
            height: 480,
            accumFrames: 1,
            frameMs: 12,
            atrousVariant: "tiled-16",
          }}
          settings={{ ...DEFAULT_SETTINGS, mode: "reference" }}
        />
      </StrictMode>,
    );

    expect(
      await screen.findByText(/path-traced · relative L2 0.0123/),
    ).toBeVisible();
    expect(runAutomaticComparison).toHaveBeenCalledOnce();
    expect(runAutomaticComparison).toHaveBeenCalledWith(
      "path-traced",
      1_024,
      5_000,
    );
    expect(screen.queryByRole("button", { name: "Measure again" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Copy result" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    const copied = JSON.parse(writeText.mock.calls[0]?.[0] ?? "");
    expect(copied).toMatchObject({
      schemaVersion: 3,
      mode: "path-traced",
      referenceFrames: 1_024,
      targetFrames: 240,
      relativeL2: 0.01234,
    });
  });

  it("keeps automatic comparison failures visible after renderer state changes", async () => {
    const runAutomaticComparison = vi
      .fn()
      .mockRejectedValue(new Error("Render settings changed"));
    render(
      <StatsOverlay
        {...inertComparisonProps()}
        runAutomaticComparison={runAutomaticComparison}
        measurePerformance={vi.fn()}
        autoCompareMode="restir"
        stats={{
          width: 640,
          height: 480,
          accumFrames: 1,
          frameMs: 16,
          atrousVariant: "tiled-16",
        }}
        settings={{ ...DEFAULT_SETTINGS, mode: "reference" }}
      />,
    );

    expect(
      await screen.findByText(
        "Render settings changed Reload this URL to retry.",
      ),
    ).toBeVisible();
    expect(screen.getByText("Render settings changed")).toBeVisible();
  });

  it("automates and copies the paired comparison matrix once", async () => {
    const pathTracedReport = {
      ...comparisonReport,
      referenceFrames: 1_024,
      referenceActualDurationMs: 12_800,
    };
    const restirReport = {
      ...pathTracedReport,
      label: "restir",
      mode: "restir" as const,
      // Lower than the path-traced side, so the derived verdict is a win rather
      // than the tie two identical fixtures would produce.
      relativeL2: pathTracedReport.relativeL2 / 2,
      context: {
        ...comparisonReport.context,
        settings: { ...DEFAULT_SETTINGS, mode: "restir" as const },
      },
    };
    const matrixReport = {
      kind: "comparison-matrix" as const,
      requestedReferenceFrames: 1_024,
      requestedDurationMs: 5_000,
      repeats: 1,
      runs: [
        {
          label: "classic/front",
          scene: "classic" as const,
          cameraLabel: "front",
          cameraIndex: 0,
          camera: DEFAULT_CAMERA,
          repeat: 0,
          runOrder: ["restir", "path-traced"] as const,
          comparisons: {
            restir: restirReport,
            "path-traced": pathTracedReport,
          },
        },
      ],
    };
    const runAutomaticComparisonMatrix = vi
      .fn()
      .mockImplementation(async (_frames, _duration, _repeats, onProgress) => {
        onProgress({
          runIndex: 1,
          totalRuns: 1,
          entry: matrixReport.runs[0],
          phase: "reference",
        });
        return matrixReport;
      });

    render(
      <StatsOverlay
        {...inertComparisonProps()}
        runAutomaticComparisonMatrix={runAutomaticComparisonMatrix}
        measurePerformance={vi.fn()}
        autoCompareMode="matrix"
        stats={{
          width: 640,
          height: 480,
          accumFrames: 1,
          frameMs: 12,
          atrousVariant: "tiled-16",
        }}
        settings={{ ...DEFAULT_SETTINGS, mode: "reference" }}
      />,
    );

    expect(
      await screen.findByText(
        "1 cases × 1 repeats · relative L2 wins by scene: classic ReSTIR 1/Denoised PT 0",
      ),
    ).toBeVisible();
    expect(runAutomaticComparisonMatrix).toHaveBeenCalledOnce();
    expect(runAutomaticComparisonMatrix).toHaveBeenCalledWith(
      1_024,
      5_000,
      DEFAULT_COMPARISON_MATRIX_REPEATS,
      expect.any(Function),
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy result" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    const copied = JSON.parse(writeText.mock.calls[0]?.[0] ?? "");
    expect(copied).toMatchObject({
      schemaVersion: 3,
      kind: "comparison-matrix",
      requestedReferenceFrames: 1_024,
      runs: [{ label: "classic/front" }],
    });
    expect(copied.summary.byScene).toHaveLength(1);
    expect(copied.summary.byScene[0].scope).toBe("classic");
    expect(copied.summary.byScene[0].tallies.relativeL2.wins).toEqual({
      restir: 1,
      "path-traced": 0,
    });
  });

  // A swapped budget would still produce a well-formed report, so only the call
  // arguments distinguish a probe run from a verdict-grade one.
  it.each([
    ["matrix" as const, COMPARISON_MATRIX_BUDGET],
    ["probe" as const, COMPARISON_MATRIX_PROBE_BUDGET],
  ])("runs %s on its own budget", async (preset, budget) => {
    const runAutomaticComparisonMatrix = vi.fn().mockResolvedValue({
      kind: "comparison-matrix" as const,
      requestedReferenceFrames: budget.referenceFrames,
      requestedDurationMs: budget.durationMs,
      repeats: budget.repeats,
      runs: [],
    });

    render(
      <StatsOverlay
        {...inertComparisonProps()}
        runAutomaticComparisonMatrix={runAutomaticComparisonMatrix}
        measurePerformance={vi.fn()}
        autoCompareMode={preset}
        stats={{
          width: 640,
          height: 480,
          accumFrames: 1,
          frameMs: 12,
          atrousVariant: "fallback",
        }}
        settings={{ ...DEFAULT_SETTINGS, mode: "reference" }}
      />,
    );

    await waitFor(() => {
      expect(runAutomaticComparisonMatrix).toHaveBeenCalledWith(
        budget.referenceFrames,
        budget.durationMs,
        budget.repeats,
        expect.any(Function),
      );
    });

    const completion = await screen.findByText(/cases × .* repeats/);
    expect(
      completion.textContent?.includes("probe budget, not a verdict"),
    ).toBe(preset === "probe");
  });

  it("allows retrying after capture failure", async () => {
    const measurePerformance = vi
      .fn()
      .mockRejectedValueOnce(new Error("renderer stopped"))
      .mockResolvedValue(measurement);
    render(
      <StatsOverlay
        {...inertComparisonProps()}
        stats={{
          width: 640,
          height: 480,
          accumFrames: 1,
          frameMs: 16,
          atrousVariant: "tiled-16",
        }}
        settings={DEFAULT_SETTINGS}
        measurePerformance={measurePerformance}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Measure 3×5 s" }));
    expect(await screen.findByText("renderer stopped")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Measure 3×5 s" }));
    expect(await screen.findByText(/33.10 ms GPU median run/)).toBeVisible();
  });

  it("keeps the measured report available when clipboard access fails", async () => {
    writeText.mockRejectedValueOnce(new Error("permission denied"));
    render(
      <StatsOverlay
        {...inertComparisonProps()}
        stats={{
          width: 640,
          height: 480,
          accumFrames: 1,
          frameMs: 16,
          atrousVariant: "fallback",
        }}
        settings={DEFAULT_SETTINGS}
        measurePerformance={vi.fn().mockResolvedValue(measurement)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Measure 3×5 s" }));
    await screen.findByText(/33.10 ms GPU median run/);
    fireEvent.click(screen.getByRole("button", { name: "Copy result" }));

    expect(
      await screen.findByText("Could not copy: permission denied"),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Copy result" })).toBeVisible();
  });

  it("runs the three measurements sequentially and reports progress", async () => {
    let resolveFirst: ((value: PerformanceMeasurement) => void) | undefined;
    let resolveSecond: ((value: PerformanceMeasurement) => void) | undefined;
    let resolveThird: ((value: PerformanceMeasurement) => void) | undefined;
    const first = new Promise<PerformanceMeasurement>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<PerformanceMeasurement>((resolve) => {
      resolveSecond = resolve;
    });
    const third = new Promise<PerformanceMeasurement>((resolve) => {
      resolveThird = resolve;
    });
    const measurePerformance = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
      .mockReturnValueOnce(third);
    render(
      <StatsOverlay
        {...inertComparisonProps()}
        stats={{
          width: 640,
          height: 480,
          accumFrames: 1,
          frameMs: 16,
          atrousVariant: "fallback",
        }}
        settings={DEFAULT_SETTINGS}
        measurePerformance={measurePerformance}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Measure 3×5 s" }));
    expect(
      screen.getByRole("button", { name: "Measuring 1/3…" }),
    ).toBeVisible();
    expect(measurePerformance).toHaveBeenCalledOnce();

    resolveFirst?.(measurement);
    await waitFor(() => expect(measurePerformance).toHaveBeenCalledTimes(2));
    expect(
      screen.getByRole("button", { name: "Measuring 2/3…" }),
    ).toBeVisible();

    resolveSecond?.(measurement);
    await waitFor(() => expect(measurePerformance).toHaveBeenCalledTimes(3));
    expect(
      screen.getByRole("button", { name: "Measuring 3/3…" }),
    ).toBeVisible();

    resolveThird?.(measurement);
    expect(await screen.findByText(/33.10 ms GPU median run/)).toBeVisible();
  });
});
