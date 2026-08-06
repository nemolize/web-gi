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

import type { DeviceLossInfo, RendererStats } from "@/gi/renderer";
import type { RendererFactory, RendererHandle } from "@/hooks/useGiRenderer";
import { useGiRenderer } from "@/hooks/useGiRenderer";

type FakeRenderer = {
  readonly renderer: RendererHandle;
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly lose: (reason: GPUDeviceLostReason, message?: string) => void;
  readonly setStats: (patch: Partial<RendererStats>) => void;
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
  const renderer = {
    deviceLost,
    destroy,
    allocationError: null,
    renderFrame: vi.fn(),
    setSettings: vi.fn(),
    notifyCameraChanged: vi.fn(),
    get stats() {
      return stats;
    },
  } satisfies RendererHandle;

  return {
    renderer,
    destroy,
    lose,
    setStats: (patch) => {
      stats = { ...stats, ...patch };
    },
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
    resetView,
  } = useGiRenderer(rendererFactory);
  const [capturedFps, setCapturedFps] = useState<number | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);

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
          void measurePerformance()
            .then((measurement) => {
              setCapturedFps(measurement.fps);
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
      <output data-testid="captured-fps">{capturedFps}</output>
      <output data-testid="capture-error">{captureError}</output>
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
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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

    act(() => {
      for (let now = 0; now <= 5_000; now += 40) {
        const frame = nextFrame;
        nextFrame = null;
        frame?.(now);
      }
    });

    await waitFor(() =>
      expect(screen.getByTestId("captured-fps")).toHaveTextContent("25"),
    );
    expect(fake.renderer.renderFrame).toHaveBeenCalledTimes(126);
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
      await vi.advanceTimersByTimeAsync(7_000);
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
