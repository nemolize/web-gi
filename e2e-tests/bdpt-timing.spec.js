import { expect, test } from "@playwright/test";

import { isPreviewTarget } from "./target";

test("normal tiled renderer measures all stages and keeps Adreno compilation at 4x4", async ({
  page,
}) => {
  test.skip(isPreviewTarget, "Imports development renderer modules.");
  await page.goto("/?diagnostics=core");
  const result = await page.evaluate(async () => {
    if (!(await navigator.gpu?.requestAdapter())) return null;
    const { GiRenderer } = await import("/src/gi/renderer.ts");
    const { DEFAULT_SETTINGS } = await import("/src/gi/settings.ts");
    const { DEFAULT_CAMERA } = await import("/src/gi/camera.ts");
    const info = Object.getOwnPropertyDescriptor(GPUAdapter.prototype, "info");
    Object.defineProperty(GPUAdapter.prototype, "info", {
      configurable: true,
      get: () => ({
        vendor: "qualcomm",
        architecture: "adreno-8xx",
        description: "",
        device: "",
      }),
    });
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "width:123px;height:91px";
    document.body.append(canvas);
    const logs = [];
    const errors = [];
    let renderer;
    try {
      renderer = await GiRenderer.create(
        canvas,
        { ...DEFAULT_SETTINGS, restirMethod: "bdpt", smoothMotion: false },
        (line) => logs.push(line),
      );
      renderer.device.addEventListener("uncapturederror", (event) =>
        errors.push(event.error.message),
      );
      const frame = async () => {
        const count = renderer.stats.accumFrames;
        while (renderer.stats.accumFrames === count) {
          renderer.renderFrame(DEFAULT_CAMERA);
          await renderer.bdptInitialization;
          await renderer.bdptPresentation;
          if (renderer.allocationError) throw Error(renderer.allocationError);
        }
      };
      await frame();
      renderer.setGpuTimingEnabled(true);
      for (let i = 0; i < 3; i++) await frame();
      const samples = renderer.takeGpuSamples();
      renderer.setGpuTimingEnabled(false);
      await frame();
      const untimed = renderer.takeGpuSamples();
      const image = await renderer.captureLinearImage();
      return {
        samples,
        untimed,
        supports: renderer.supportsGpuTiming,
        logs,
        errors,
        finite: image.data.every(Number.isFinite),
        positive: image.data.some((v, i) => i % 4 !== 3 && v > 0),
      };
    } finally {
      renderer?.destroy();
      canvas.remove();
      Object.defineProperty(GPUAdapter.prototype, "info", info);
    }
  });
  test.skip(result === null, "WebGPU unavailable.");
  expect(result.logs).toContain("BDPT workgroup size limit: 4");
  expect(
    result.logs.filter((line) => line.startsWith("COMPILE PASS")),
  ).toHaveLength(7);
  expect(
    result.logs
      .filter((line) => line.startsWith("COMPILE PASS"))
      .every((line) => line.endsWith("4x4")),
  ).toBe(true);
  expect(result.errors).toEqual([]);
  expect(result.finite).toBe(true);
  expect(result.positive).toBe(true);
  expect(result.untimed).toEqual([]);
  if (result.supports) {
    expect(result.samples).toHaveLength(3);
    for (const sample of result.samples) {
      for (const name of [
        "gbuffer",
        "bdpt-initial-camera",
        "bdpt-initial-light",
        "bdpt-initial-gather",
        "bdpt-caustic-reproject",
        "bdpt-temporal",
        "bdpt-spatial",
        "bdpt-resolve",
        "temporal",
        "atrous0",
        "present",
      ])
        expect(sample.passMs[name], name).toBeGreaterThanOrEqual(0);
      expect(sample.frameMs).toBeGreaterThan(0);
      expect(
        Object.values(sample.passMs).reduce((a, b) => a + b, 0),
      ).toBeLessThanOrEqual(sample.frameMs + 0.001);
    }
  } else {
    expect(result.samples).toEqual([]);
  }
});
