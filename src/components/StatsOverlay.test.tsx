import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StatsOverlay } from "@/components/StatsOverlay";
import type { PerformanceMeasurement } from "@/gi/performance";
import { DEFAULT_SETTINGS } from "@/gi/settings";

const measurement: PerformanceMeasurement = {
  durationMs: 5_010,
  sampleCount: 151,
  fps: 30.14,
  frameTimeMs: {
    mean: 33.18,
    median: 33.1,
    p95: 35.4,
    min: 31.8,
    max: 41.2,
  },
  atrousVariant: "fallback",
  renderResolution: { width: 1080, height: 2208 },
};

describe("StatsOverlay performance capture", () => {
  const writeText = vi.fn<(text: string) => Promise<void>>();

  beforeEach(() => {
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

    const measureButton = screen.getByRole("button", { name: "Measure 5 s" });
    fireEvent.click(measureButton);

    await screen.findByText(/30\.1 fps/);
    expect(measurePerformance).toHaveBeenCalledOnce();
    const copyButton = screen.getByRole("button", { name: "Copy result" });
    expect(copyButton).toBe(measureButton);
    expect(
      screen.getByText("Measurement complete. Copy result is ready."),
    ).toBeVisible();
    fireEvent.click(copyButton);

    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    const copied = JSON.parse(writeText.mock.calls[0]?.[0] ?? "");
    expect(copied).toMatchObject({
      schemaVersion: 1,
      atrousVariant: "fallback",
      sampleCount: 151,
      fps: 30.14,
      renderResolution: { width: 1080, height: 2208 },
    });
    expect(screen.getByText("Result copied to clipboard.")).toBeVisible();

    const againButton = screen.getByRole("button", { name: "Measure again" });
    againButton.focus();
    fireEvent.click(againButton);
    expect(measureButton).toHaveFocus();
  });

  it("allows retrying after capture failure", async () => {
    const measurePerformance = vi
      .fn()
      .mockRejectedValueOnce(new Error("renderer stopped"))
      .mockResolvedValueOnce(measurement);
    render(
      <StatsOverlay
        stats={{
          width: 640,
          height: 480,
          accumFrames: 1,
          frameMs: 16,
          atrousVariant: "tiled-8",
        }}
        settings={DEFAULT_SETTINGS}
        measurePerformance={measurePerformance}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Measure 5 s" }));
    expect(await screen.findByText("renderer stopped")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Measure 5 s" }));
    expect(await screen.findByText(/30\.1 fps/)).toBeVisible();
  });

  it("keeps the measured report available when clipboard access fails", async () => {
    writeText.mockRejectedValueOnce(new Error("permission denied"));
    render(
      <StatsOverlay
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

    fireEvent.click(screen.getByRole("button", { name: "Measure 5 s" }));
    await screen.findByText(/30\.1 fps/);
    fireEvent.click(screen.getByRole("button", { name: "Copy result" }));

    expect(
      await screen.findByText("Could not copy: permission denied"),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Copy result" })).toBeVisible();
  });
});
