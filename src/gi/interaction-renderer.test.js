import { describe, expect, it } from "vitest";

import { GiRenderer } from "@/gi/renderer";
import { DEFAULT_SETTINGS } from "@/gi/settings";

describe("interaction target reuse", () => {
  const rendererWithTargets = () => {
    const renderer = Object.create(GiRenderer.prototype);
    Object.assign(renderer, {
      settings: DEFAULT_SETTINGS,
      targets: { width: 800, height: 600, textures: [], buffers: [] },
      targetCapacity: { width: 800, height: 600 },
      canvas: { width: 800, height: 600 },
      passProbe: null,
      measuringPerformance: false,
      motionUntil: performance.now() + 200,
      accumFrames: 50,
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

  it("resets row-stride history on both transitions without replacing resources", () => {
    const renderer = rendererWithTargets();
    const { textures, buffers } = renderer.targets;
    const moving = renderer.ensureTargets();
    expect(moving).toMatchObject({ width: 400, height: 300 });
    expect(renderer.accumFrames).toBe(0);
    expect(moving.textures).toBe(textures);
    expect(moving.buffers).toBe(buffers);
    renderer.accumFrames = 20;
    renderer.motionUntil = 0;
    const settled = renderer.ensureTargets();
    expect(settled).toMatchObject({ width: 800, height: 600 });
    expect(renderer.accumFrames).toBe(0);
    expect(settled.textures).toBe(textures);
    expect(settled.buffers).toBe(buffers);
  });
});
