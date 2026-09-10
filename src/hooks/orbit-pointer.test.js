import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CAMERA, orbitCamera } from "@/gi/camera";
import { useGiRenderer } from "@/hooks/useGiRenderer";

const Harness = ({ createRenderer }) => {
  const { canvasRef } = useGiRenderer(createRenderer);
  return createElement("canvas", { ref: canvasRef });
};

describe("orbit pointer ownership", () => {
  let frame;
  beforeEach(() => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback) => {
        frame = callback;
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const setup = async () => {
    const renderer = {
      deviceLost: new Promise(() => {}),
      destroy: vi.fn(),
      setSettings: vi.fn(),
      renderFrame: vi.fn(),
      notifyCameraChanged: vi.fn(),
      allocationError: null,
    };
    const { container } = render(
      createElement(Harness, { createRenderer: async () => renderer }),
    );
    await waitFor(() => expect(renderer.setSettings).toHaveBeenCalled());
    const canvas = container.querySelector("canvas");
    const captured = new Set();
    canvas.setPointerCapture = vi.fn((id) => captured.add(id));
    canvas.hasPointerCapture = (id) => captured.has(id);
    canvas.releasePointerCapture = vi.fn((id) => captured.delete(id));
    const pointer = (type, pointerId, clientX, clientY) => {
      fireEvent(
        canvas,
        new PointerEvent(type, { pointerId, clientX, clientY }),
      );
    };
    const camera = () => {
      act(() => frame(0));
      return renderer.renderFrame.mock.lastCall[0];
    };
    return { canvas, renderer, pointer, camera };
  };

  it.each(["pointerup", "pointercancel", "lostpointercapture"])(
    "ignores another pointer's movement and %s",
    async (ending) => {
      const { canvas, renderer, pointer, camera } = await setup();
      pointer("pointerdown", 1, 100, 100);
      pointer("pointerdown", 2, 300, 300);
      pointer("pointermove", 2, 350, 350);
      expect(renderer.notifyCameraChanged).not.toHaveBeenCalled();
      expect(camera()).toEqual(DEFAULT_CAMERA);
      pointer(ending, 2, 350, 350);
      pointer("pointermove", 1, 120, 110);
      expect(camera()).toEqual(orbitCamera(DEFAULT_CAMERA, -0.1, 0.05));
      expect(canvas.setPointerCapture.mock.calls).toEqual([[1]]);
    },
  );

  it.each(["pointerup", "pointercancel", "lostpointercapture"])(
    "ends the active drag on %s and accepts a fresh pointer",
    async (ending) => {
      const { pointer, camera } = await setup();
      pointer("pointerdown", 1, 100, 100);
      pointer(ending, 1, 100, 100);
      pointer("pointermove", 1, 200, 200);
      expect(camera()).toEqual(DEFAULT_CAMERA);
      pointer("pointerdown", 2, 300, 300);
      pointer("pointermove", 2, 320, 310);
      expect(camera()).toEqual(orbitCamera(DEFAULT_CAMERA, -0.1, 0.05));
    },
  );
});
