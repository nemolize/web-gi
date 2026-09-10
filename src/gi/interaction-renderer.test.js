import { describe, expect, it, vi } from "vitest";

import { cameraBasis, DEFAULT_CAMERA } from "@/gi/camera";
import { GiRenderer } from "@/gi/renderer";
import { DEFAULT_SETTINGS } from "@/gi/settings";

describe("interaction target reuse", () => {
  const rendererWithTargets = () => {
    const renderer = Object.create(GiRenderer.prototype);
    Object.assign(renderer, {
      settings: DEFAULT_SETTINGS,
      scene: { glassShapes: [] },
      targets: { width: 800, height: 600, textures: [], buffers: [] },
      targetCapacity: { width: 800, height: 600 },
      canvas: { width: 800, height: 600 },
      passProbe: null,
      measuringPerformance: false,
      motionUntil: performance.now() + 200,
      accumFrames: 50,
      historyFrames: 50,
      comparisonGeneration: 0,
      resolveSize: () => ({ width: 800, height: 600 }),
    });
    return renderer;
  };

  it("keeps wall-clock measurements full-sized without timestamp queries", () => {
    const renderer = rendererWithTargets();
    expect(renderer.supportsGpuTiming).toBe(false);
    renderer.setGpuTimingEnabled(true);
    expect(renderer.ensureTargets()).toMatchObject({ width: 800, height: 600 });
    renderer.setGpuTimingEnabled(false);
    expect(renderer.ensureTargets()).toMatchObject({ width: 400, height: 300 });
  });

  it("restarts reservoirs but retains illumination history across resolution transitions", () => {
    const renderer = rendererWithTargets();
    const { textures, buffers } = renderer.targets;
    const moving = renderer.ensureTargets();
    expect(moving).toMatchObject({ width: 400, height: 300 });
    expect(renderer.accumFrames).toBe(0);
    expect(renderer.historyFrames).toBe(50);
    expect(moving.textures).toBe(textures);
    expect(moving.buffers).toBe(buffers);
    renderer.accumFrames = 20;
    renderer.motionUntil = 0;
    const settled = renderer.ensureTargets();
    expect(settled).toMatchObject({ width: 800, height: 600 });
    expect(renderer.accumFrames).toBe(0);
    expect(renderer.historyFrames).toBe(50);
    expect(settled.textures).toBe(textures);
    expect(settled.buffers).toBe(buffers);
  });

  it("discards illumination history on an explicit accumulation reset", () => {
    const renderer = rendererWithTargets();
    renderer.resetAccumulation();
    expect(renderer.accumFrames).toBe(0);
    expect(renderer.historyFrames).toBe(0);
  });

  it.each([16, 200])(
    "restores presentation gradually with %i ms frame intervals",
    (interval) => {
      const renderer = rendererWithTargets();
      renderer.ensureTargets();
      renderer.motionUntil = 0;
      const targets = renderer.ensureTargets();
      Object.assign(renderer, {
        scene: { quads: [], lights: [], clusters: [], glassShapes: [] },
        uniformData: new ArrayBuffer(224),
        device: { queue: { writeBuffer: vi.fn() } },
      });
      let now = renderer.presentationTransition.updatedAt;
      const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
      try {
        const basis = cameraBasis(DEFAULT_CAMERA, 4 / 3);
        const readBlend = () => {
          renderer.writeUniforms(basis, targets);
          return new DataView(renderer.uniformData).getFloat32(216, true);
        };
        now += 500;
        expect(readBlend()).toBe(1);
        renderer.presentationTransition.pending = false;
        let previous = 1;
        let frames = 0;
        while (renderer.presentationTransition !== null && frames < 20) {
          now += interval;
          const blend = readBlend();
          expect(blend).toBeLessThan(previous);
          expect(previous - blend).toBeLessThanOrEqual(0.250001);
          previous = blend;
          frames += 1;
        }
        expect(previous).toBe(0);
        expect(frames).toBeGreaterThanOrEqual(4);
        expect(renderer.presentationTransition).toBeNull();
      } finally {
        clock.mockRestore();
      }
    },
  );

  it.each(["motion", "settings", "measurement", "reset"])(
    "cancels a pending presentation blend on %s",
    (reason) => {
      const renderer = rendererWithTargets();
      renderer.ensureTargets();
      expect(renderer.presentationTransition).toBeNull();
      renderer.motionUntil = 0;
      renderer.ensureTargets();
      expect(renderer.presentationTransition).toMatchObject({
        size: { width: 400, height: 300 },
        pending: true,
      });
      if (reason === "motion") renderer.notifyCameraChanged();
      if (reason === "settings")
        renderer.setSettings({ ...DEFAULT_SETTINGS, exposure: 2 });
      if (reason === "measurement") renderer.setGpuTimingEnabled(true);
      if (reason === "reset") renderer.resetAccumulation();
      expect(renderer.presentationTransition).toBeNull();
    },
  );
});
