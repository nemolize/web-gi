import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cameraBasis, DEFAULT_CAMERA } from "@/gi/camera";
import {
  comparisonMatrixRuns,
  type LinearComparisonMatrixReport,
} from "@/gi/comparison-matrix";
import type { LinearComparisonReport } from "@/gi/comparison-session";
import type { DeviceLossInfo, RendererStats } from "@/gi/renderer";
import { DEFAULT_SETTINGS } from "@/gi/settings";
import type { RendererFactory, RendererHandle } from "@/hooks/useGiRenderer";
import {
  PERFORMANCE_CAPTURE_TIMEOUT_MS,
  useGiRenderer,
} from "@/hooks/useGiRenderer";

/** Even, so the run-order balance the schedule promises is observable here. */
const MATRIX_TEST_REPEATS = 2;
const MATRIX_TEST_RUNS = comparisonMatrixRuns(MATRIX_TEST_REPEATS);

type FakeRenderer = {
  readonly renderer: RendererHandle;
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly compareReferenceAfter: ReturnType<
    typeof vi.fn<RendererHandle["compareReferenceAfter"]>
  >;
  readonly lose: (reason: GPUDeviceLostReason, message?: string) => void;
  readonly setStats: (patch: Partial<RendererStats>) => void;
  readonly statsReadCount: () => number;
};

const createFakeRenderer = (): FakeRenderer => {
  let resolveLoss: ((info: DeviceLossInfo) => void) | undefined;
  let lossResolved = false;
  const deviceLost = new Promise<DeviceLossInfo>((resolve) => {
    resolveLoss = resolve;
  });
  const lose = (reason: GPUDeviceLostReason, message = ""): void => {
    if (lossResolved) return;
    lossResolved = true;
    resolveLoss?.({ reason, message });
  };
  const destroy = vi.fn(() => {
    lose("destroyed", "Device was destroyed");
  });
  let stats: RendererStats = {
    width: 640,
    height: 480,
    accumFrames: 1,
    frameMs: 16,
    atrousVariant: "fallback",
  };
  let statsReads = 0;
  const compareReferenceAfter = vi
    .fn<RendererHandle["compareReferenceAfter"]>()
    .mockResolvedValue(null);
  const renderer = {
    deviceLost,
    destroy,
    allocationError: null,
    renderFrame: vi.fn(),
    setSettings: vi.fn(),
    notifyCameraChanged: vi.fn(),
    supportsGpuTiming: false,
    setGpuTimingEnabled: vi.fn(),
    saveComparisonReference: vi.fn().mockResolvedValue(true),
    saveComparisonReferenceAfterFrames: vi.fn().mockResolvedValue(true),
    compareReferenceAfter,
    releaseComparisonResources: vi.fn(),
    cancelComparison: vi.fn(),
    takeGpuSamples: vi.fn(() => []),
    get stats() {
      statsReads += 1;
      return stats;
    },
  } satisfies RendererHandle;

  return {
    renderer,
    destroy,
    compareReferenceAfter,
    lose,
    setStats: (patch) => {
      stats = { ...stats, ...patch };
    },
    statsReadCount: () => statsReads,
  };
};

interface RendererHarnessProps {
  readonly rendererFactory: RendererFactory;
}

const RendererHarness = ({ rendererFactory }: RendererHarnessProps) => {
  const {
    canvasRef,
    status,
    errorMessage,
    retryRenderer,
    updateSettings,
    measurePerformance,
    runAutomaticComparison,
    runAutomaticComparisonMatrix,
    resetView,
  } = useGiRenderer(rendererFactory);
  const [capturedCallbacks, setCapturedCallbacks] = useState<number | null>(
    null,
  );
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [matrixCases, setMatrixCases] = useState<number | null>(null);
  const [matrixReport, setMatrixReport] =
    useState<LinearComparisonMatrixReport | null>(null);
  const [matrixProgress, setMatrixProgress] = useState<string | null>(null);

  return (
    <>
      <canvas ref={canvasRef} />
      <output data-testid="status">{status}</output>
      <output data-testid="error">{errorMessage}</output>
      <button
        type="button"
        onClick={() => updateSettings({ resolutionScale: 0.5 })}
      >
        Lower resolution
      </button>
      <button type="button" onClick={retryRenderer}>
        Retry
      </button>
      <button type="button" onClick={resetView}>
        Reset view
      </button>
      <button
        type="button"
        onClick={() => {
          void runAutomaticComparison("path-traced", 2_048, 5_000);
        }}
      >
        Auto compare
      </button>
      <button
        type="button"
        onClick={() => {
          const progress: string[] = [];
          void runAutomaticComparisonMatrix(
            2_048,
            5_000,
            MATRIX_TEST_REPEATS,
            ({ runIndex, totalRuns, entry, phase }) => {
              progress.push(
                `${String(runIndex)}/${String(totalRuns)} ${entry.label}#${String(entry.repeat)} ${phase}`,
              );
            },
          ).then((report) => {
            setMatrixCases(report.runs.length);
            setMatrixReport(report);
            setMatrixProgress(progress.join("\n"));
          });
        }}
      >
        Auto compare matrix
      </button>
      <button
        type="button"
        onClick={() => {
          void measurePerformance()
            .then((measurement) => {
              setCapturedCallbacks(measurement.measurement.sampling.callbacks);
            })
            .catch((error: unknown) => {
              setCaptureError(
                error instanceof Error ? error.message : String(error),
              );
            });
        }}
      >
        Measure
      </button>
      <output data-testid="captured-callbacks">{capturedCallbacks}</output>
      <output data-testid="capture-error">{captureError}</output>
      <output data-testid="matrix-cases">{matrixCases}</output>
      <output data-testid="matrix-progress">{matrixProgress}</output>
      <output data-testid="matrix-report">
        {matrixReport === null ? null : JSON.stringify(matrixReport)}
      </output>
    </>
  );
};

describe("useGiRenderer", () => {
  beforeEach(() => {
    let frame = 0;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => ++frame),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    cleanup();
    window.history.replaceState(null, "", "/");
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("creates the renderer with settings from the benchmark preset", async () => {
    window.history.replaceState(
      null,
      "",
      "/?preset=heavy&mode=path-traced&measure=auto",
    );
    const fake = createFakeRenderer();
    const create = vi.fn<RendererFactory>().mockResolvedValue(fake.renderer);

    render(<RendererHarness rendererFactory={create} />);

    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("running"),
    );
    expect(create.mock.calls[0]?.[1]).toMatchObject({
      scene: "manyLights",
      mode: "path-traced",
      diCandidates: 32,
      spatialSamples: 8,
      maxBounces: 6,
      resolutionScale: 0.75,
    });
  });

  it("applies settings changed while renderer creation is pending", async () => {
    const fake = createFakeRenderer();
    let resolveCreation: ((renderer: RendererHandle) => void) | undefined;
    const create = vi.fn<RendererFactory>(
      () =>
        new Promise((resolve) => {
          resolveCreation = resolve;
        }),
    );

    render(<RendererHarness rendererFactory={create} />);
    fireEvent.click(screen.getByRole("button", { name: "Lower resolution" }));

    await act(async () => {
      resolveCreation?.(fake.renderer);
    });

    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("running"),
    );
    expect(fake.renderer.setSettings).toHaveBeenCalledWith(
      expect.objectContaining({ resolutionScale: 0.5 }),
    );
  });

  it("stops after device loss and retries with the current settings", async () => {
    const first = createFakeRenderer();
    const second = createFakeRenderer();
    const create = vi.fn<RendererFactory>();
    create
      .mockResolvedValueOnce(first.renderer)
      .mockResolvedValueOnce(second.renderer);

    render(<RendererHarness rendererFactory={create} />);

    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("running"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Lower resolution" }));

    await act(async () => {
      first.lose("unknown", "GPU reset");
      await first.renderer.deviceLost;
    });

    expect(screen.getByTestId("status")).toHaveTextContent("error");
    expect(screen.getByTestId("error")).toHaveTextContent(
      "The WebGPU device was lost: GPU reset",
    );
    expect(cancelAnimationFrame).toHaveBeenCalled();
    expect(first.destroy).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("running"),
    );
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]?.[1].resolutionScale).toBe(0.5);
  });

  it("uses the latest renderer factory on retry", async () => {
    const first = createFakeRenderer();
    const second = createFakeRenderer();
    const initialFactory = vi.fn<RendererFactory>();
    const updatedFactory = vi.fn<RendererFactory>();
    initialFactory.mockResolvedValueOnce(first.renderer);
    updatedFactory.mockResolvedValueOnce(second.renderer);

    const { rerender } = render(
      <RendererHarness rendererFactory={initialFactory} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("running"),
    );

    rerender(<RendererHarness rendererFactory={updatedFactory} />);
    expect(initialFactory).toHaveBeenCalledTimes(1);
    expect(updatedFactory).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(updatedFactory).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("running"),
    );
  });

  it("captures every rendered frame over the measurement window", async () => {
    const fake = createFakeRenderer();
    const create = vi.fn<RendererFactory>().mockResolvedValue(fake.renderer);
    let nextFrame: FrameRequestCallback | null = null;
    let frameId = 0;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        nextFrame = callback;
        frameId += 1;
        return frameId;
      }),
    );

    render(<RendererHarness rendererFactory={create} />);
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("running"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Measure" }));

    // The window only opens after the warm-up frames and the one that sets its
    // origin, so the loop has to outlast both before it covers 5s of capture.
    act(() => {
      for (let now = 0; now <= 11_000; now += 40) {
        const frame = nextFrame;
        nextFrame = null;
        frame?.(now);
      }
    });

    await waitFor(() =>
      expect(screen.getByTestId("captured-callbacks")).toHaveTextContent("125"),
    );
  });

  it("keeps stats snapshots on the throttled cadence while idle", async () => {
    const fake = createFakeRenderer();
    const create = vi.fn<RendererFactory>().mockResolvedValue(fake.renderer);
    let nextFrame: FrameRequestCallback | null = null;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        nextFrame = callback;
        return 1;
      }),
    );

    render(<RendererHarness rendererFactory={create} />);
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("running"),
    );

    act(() => {
      for (let now = 0; now <= 256; now += 16) {
        const frame = nextFrame;
        nextFrame = null;
        frame?.(now);
      }
    });

    expect(fake.renderer.renderFrame).toHaveBeenCalledTimes(17);
    expect(fake.statsReadCount()).toBe(1);
  });

  it("cancels a capture when render settings change", async () => {
    const fake = createFakeRenderer();
    const create = vi.fn<RendererFactory>().mockResolvedValue(fake.renderer);

    render(<RendererHarness rendererFactory={create} />);
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("running"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Measure" }));
    fireEvent.click(screen.getByRole("button", { name: "Lower resolution" }));

    await waitFor(() =>
      expect(screen.getByTestId("capture-error")).toHaveTextContent(
        "Performance capture stopped because the render settings changed.",
      ),
    );
  });

  it("cancels a capture when the render resolution changes", async () => {
    const fake = createFakeRenderer();
    const create = vi.fn<RendererFactory>().mockResolvedValue(fake.renderer);
    let nextFrame: FrameRequestCallback | null = null;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        nextFrame = callback;
        return 1;
      }),
    );

    render(<RendererHarness rendererFactory={create} />);
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("running"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Measure" }));

    act(() => {
      const frame = nextFrame;
      nextFrame = null;
      frame?.(0);
    });
    fake.setStats({ width: 320 });
    act(() => {
      const frame = nextFrame;
      nextFrame = null;
      frame?.(40);
    });

    await waitFor(() =>
      expect(screen.getByTestId("capture-error")).toHaveTextContent(
        "Performance capture stopped because the render configuration changed.",
      ),
    );
  });

  it("cancels a capture after an interrupted frame sequence", async () => {
    const fake = createFakeRenderer();
    const create = vi.fn<RendererFactory>().mockResolvedValue(fake.renderer);
    let nextFrame: FrameRequestCallback | null = null;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        nextFrame = callback;
        return 1;
      }),
    );

    render(<RendererHarness rendererFactory={create} />);
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("running"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Measure" }));

    act(() => {
      const frame = nextFrame;
      nextFrame = null;
      frame?.(0);
    });
    act(() => {
      const frame = nextFrame;
      nextFrame = null;
      frame?.(2_000);
    });

    await waitFor(() =>
      expect(screen.getByTestId("capture-error")).toHaveTextContent(
        "Performance capture stopped because rendering was interrupted.",
      ),
    );
  });

  it("cancels a capture when the page becomes hidden", async () => {
    const fake = createFakeRenderer();
    const create = vi.fn<RendererFactory>().mockResolvedValue(fake.renderer);

    render(<RendererHarness rendererFactory={create} />);
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("running"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Measure" }));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));

    await waitFor(() =>
      expect(screen.getByTestId("capture-error")).toHaveTextContent(
        "Performance capture stopped because the page was hidden.",
      ),
    );
    expect(fake.renderer.cancelComparison).toHaveBeenCalledWith(
      "Comparison stopped because the page was hidden.",
    );
  });

  it("times out when frames stop arriving", async () => {
    const fake = createFakeRenderer();
    const create = vi.fn<RendererFactory>().mockResolvedValue(fake.renderer);

    render(<RendererHarness rendererFactory={create} />);
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("running"),
    );
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Measure" }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PERFORMANCE_CAPTURE_TIMEOUT_MS + 1_000);
    });

    expect(screen.getByTestId("capture-error")).toHaveTextContent(
      "Performance capture timed out before enough frames were rendered.",
    );
  });

  it("cancels a capture when the camera moves", async () => {
    const fake = createFakeRenderer();
    const create = vi.fn<RendererFactory>().mockResolvedValue(fake.renderer);

    render(<RendererHarness rendererFactory={create} />);
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("running"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Measure" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset view" }));

    await waitFor(() =>
      expect(screen.getByTestId("capture-error")).toHaveTextContent(
        "Performance capture stopped because the camera moved.",
      ),
    );
  });

  it("builds an exact reference before switching and releases readback resources", async () => {
    const fake = createFakeRenderer();
    const create = vi.fn<RendererFactory>().mockResolvedValue(fake.renderer);

    render(<RendererHarness rendererFactory={create} />);
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("running"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Auto compare" }));

    await waitFor(() =>
      expect(
        fake.renderer.saveComparisonReferenceAfterFrames,
      ).toHaveBeenCalledWith(2_048),
    );
    expect(fake.renderer.setSettings).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "path-traced" }),
    );
    expect(fake.renderer.renderFrame).toHaveBeenCalledWith(DEFAULT_CAMERA);
    expect(fake.renderer.compareReferenceAfter).toHaveBeenCalledWith(
      "path-traced",
      5_000,
    );
    expect(vi.mocked(fake.renderer.renderFrame)).toHaveBeenCalledBefore(
      fake.compareReferenceAfter,
    );
    expect(fake.renderer.releaseComparisonResources).toHaveBeenCalledOnce();
  });

  it("shares one reference between both renderers in every matrix case", async () => {
    window.history.replaceState(null, "", "/?preset=matrix");
    const fake = createFakeRenderer();
    let currentSettings = DEFAULT_SETTINGS;
    let currentCamera = DEFAULT_CAMERA;
    vi.mocked(fake.renderer.setSettings).mockImplementation((settings) => {
      currentSettings = settings;
    });
    vi.mocked(fake.renderer.renderFrame).mockImplementation((camera) => {
      currentCamera = camera;
    });
    fake.compareReferenceAfter.mockImplementation((label) => {
      if (label !== "restir" && label !== "path-traced") {
        throw new Error(`Unexpected comparison mode: ${label}`);
      }
      const mode = label;
      return Promise.resolve({
        luminanceRatio: 1,
        relativeL2: 0.01,
        meanAbsolute: 0.02,
        maxAbsolute: 0.5,
        outliers: 1,
        pixels: 640 * 480,
        label,
        mode,
        requestedDurationMs: 5_000,
        actualDurationMs: 5_010,
        targetFrames: mode === "restir" ? 50 : 80,
        referenceFrames: 2_048,
        referenceActualDurationMs: 60_000,
        context: {
          atrousVariant: "tiled-16",
          scene: currentSettings.scene,
          maxBounces: currentSettings.maxBounces,
          width: 640,
          height: 480,
          camera: cameraBasis(currentCamera, 4 / 3),
          settings: currentSettings,
        },
      } satisfies LinearComparisonReport);
    });
    const create = vi.fn<RendererFactory>().mockResolvedValue(fake.renderer);

    render(<RendererHarness rendererFactory={create} />);
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("running"),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Auto compare matrix" }),
    );

    await waitFor(() =>
      expect(screen.getByTestId("matrix-cases")).toHaveTextContent(
        String(MATRIX_TEST_RUNS.length),
      ),
    );
    expect(
      fake.renderer.saveComparisonReferenceAfterFrames,
    ).toHaveBeenCalledTimes(MATRIX_TEST_RUNS.length);
    expect(fake.renderer.compareReferenceAfter).toHaveBeenCalledTimes(
      MATRIX_TEST_RUNS.length * 2,
    );
    // Pinned literally: deriving every expectation from the schedule would let a
    // regression in it mirror itself on both sides of the assertion.
    expect(fake.compareReferenceAfter.mock.calls.slice(0, 2)).toEqual([
      ["restir", 5_000],
      ["path-traced", 5_000],
    ]);
    expect(fake.compareReferenceAfter.mock.calls).toEqual(
      MATRIX_TEST_RUNS.flatMap((run) =>
        run.runOrder.map((mode) => [mode, 5_000]),
      ),
    );
    // Counts the runs from 1 and reports each run's three phases in order.
    expect(screen.getByTestId("matrix-progress")).toHaveTextContent(
      MATRIX_TEST_RUNS.flatMap((run, index) =>
        ["reference", ...run.runOrder].map(
          (phase) =>
            `${String(index + 1)}/${String(MATRIX_TEST_RUNS.length)} ${run.label}#${String(run.repeat)} ${phase}`,
        ),
      ).join(" "),
    );

    const saves = vi.mocked(fake.renderer.saveComparisonReferenceAfterFrames)
      .mock.invocationCallOrder;
    const comparisons = fake.compareReferenceAfter.mock.invocationCallOrder;
    for (let index = 0; index < saves.length; index++) {
      expect(saves[index]).toBeLessThan(comparisons[index * 2] ?? 0);
      expect(comparisons[index * 2]).toBeLessThan(
        comparisons[index * 2 + 1] ?? 0,
      );
      if (index + 1 < saves.length) {
        expect(comparisons[index * 2 + 1]).toBeLessThan(saves[index + 1] ?? 0);
      }
    }
    expect(fake.renderer.releaseComparisonResources).toHaveBeenCalledTimes(
      MATRIX_TEST_RUNS.length,
    );

    const matrix: unknown = JSON.parse(
      screen.getByTestId("matrix-report").textContent ?? "null",
    );
    expect(matrix).toMatchObject({
      repeats: MATRIX_TEST_REPEATS,
      runs: MATRIX_TEST_RUNS.map((entry) => ({
        label: entry.label,
        scene: entry.scene,
        camera: entry.camera,
        repeat: entry.repeat,
        runOrder: entry.runOrder,
        comparisons: {
          restir: {
            context: {
              scene: entry.scene,
              camera: JSON.parse(
                JSON.stringify(cameraBasis(entry.camera, 4 / 3)),
              ),
            },
          },
          "path-traced": {
            context: {
              scene: entry.scene,
              camera: JSON.parse(
                JSON.stringify(cameraBasis(entry.camera, 4 / 3)),
              ),
            },
          },
        },
      })),
    });
  });

  it("ignores the destroyed notification from renderer cleanup", async () => {
    const first = createFakeRenderer();
    const second = createFakeRenderer();
    const create = vi.fn<RendererFactory>();
    create
      .mockResolvedValueOnce(first.renderer)
      .mockResolvedValueOnce(second.renderer);

    render(<RendererHarness rendererFactory={create} />);
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("running"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    await first.renderer.deviceLost;
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("running"),
    );
    expect(screen.getByTestId("error")).toBeEmptyDOMElement();
    expect(first.destroy).toHaveBeenCalled();
  });
});
