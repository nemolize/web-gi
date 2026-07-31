import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DeviceLossInfo } from "@/gi/renderer";
import type { RendererFactory, RendererHandle } from "@/hooks/useGiRenderer";
import { useGiRenderer } from "@/hooks/useGiRenderer";

type FakeRenderer = {
  readonly renderer: RendererHandle;
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly lose: (reason: GPUDeviceLostReason, message?: string) => void;
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
  const renderer = {
    deviceLost,
    destroy,
    renderFrame: vi.fn(),
    setSettings: vi.fn(),
    notifyCameraChanged: vi.fn(),
    stats: { width: 640, height: 480, accumFrames: 1, frameMs: 16 },
  } satisfies RendererHandle;

  return {
    renderer,
    destroy,
    lose,
  };
};

interface RendererHarnessProps {
  readonly rendererFactory: RendererFactory;
}

const RendererHarness = ({ rendererFactory }: RendererHarnessProps) => {
  const { canvasRef, status, errorMessage, retryRenderer, updateSettings } =
    useGiRenderer(rendererFactory);

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
