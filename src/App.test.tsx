import { cleanup, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "@/App";
import { DEFAULT_SETTINGS } from "@/gi/settings";
import type { RendererStatus, UseGiRenderer } from "@/hooks/useGiRenderer";

const { useGiRendererMock } = vi.hoisted(() => ({
  useGiRendererMock: vi.fn<() => UseGiRenderer>(),
}));

vi.mock("@/hooks/useGiRenderer", () => ({
  useGiRenderer: useGiRendererMock,
}));

const renderApp = (status: RendererStatus): void => {
  useGiRendererMock.mockReturnValue({
    canvasRef: createRef<HTMLCanvasElement>(),
    settings: DEFAULT_SETTINGS,
    updateSettings: vi.fn(),
    stats: {
      width: 640,
      height: 480,
      accumFrames: 7,
      frameMs: 16,
      atrousVariant: "tiled-8",
    },
    status,
    errorMessage: status === "error" ? "boom" : null,
    measurePerformance: vi.fn(),
    resetView: vi.fn(),
    retryRenderer: vi.fn(),
  });

  render(<App />);
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("stats HUD", () => {
  it("stays on screen while the renderer runs, with the control panel closed", () => {
    renderApp("running");

    expect(screen.getByRole("region", { name: "Stats" })).toBeVisible();
    expect(screen.getByTestId("stat-accumulated")).toHaveTextContent("7");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each<RendererStatus>(["initializing", "unsupported", "error"])(
    "stays hidden while %s so it cannot cover the status overlay",
    (status) => {
      renderApp(status);

      expect(
        screen.queryByRole("region", { name: "Stats" }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("alert")).toBeInTheDocument();
    },
  );
});
