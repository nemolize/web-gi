import { expect, test } from "@playwright/test";

import { isPreviewTarget } from "./target";

test("BDPT comparison uses a shared size and cancels during lazy compilation", async ({
  page,
}) => {
  test.skip(
    isPreviewTarget,
    "This lifecycle harness imports the renderer module.",
  );
  test.setTimeout(90_000);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    if (!(await navigator.gpu?.requestAdapter())) return null;
    const { GiRenderer } = await import("/src/gi/renderer.ts");
    const { DEFAULT_SETTINGS } = await import("/src/gi/settings.ts");
    const { DEFAULT_CAMERA } = await import("/src/gi/camera.ts");
    const canvas = document.createElement("canvas");
    canvas.style.cssText =
      "position:absolute;width:1000px;height:600px;visibility:hidden";
    document.body.append(canvas);
    const settings = {
      ...DEFAULT_SETTINGS,
      restirMethod: "bdpt",
      mode: "reference",
      smoothMotion: false,
    };
    const renderer = await GiRenderer.create(canvas, settings);
    const prototype = GPUDevice.prototype;
    const compile = prototype.createComputePipelineAsync;
    let pending = 0;
    prototype.createComputePipelineAsync = function (descriptor) {
      const pipeline = Reflect.apply(compile, this, [descriptor]);
      if (!descriptor.label?.startsWith("bdpt")) return pipeline;
      pending++;
      return pipeline.then(async (value) => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        pending--;
        return value;
      });
    };
    try {
      renderer.renderFrame(DEFAULT_CAMERA);
      const saved = await renderer.saveComparisonReference();
      const referenceSize = [renderer.stats.width, renderer.stats.height];
      renderer.setSettings({ ...settings, mode: "restir" });
      renderer.renderFrame(DEFAULT_CAMERA);
      const active = renderer.compareReferenceAfter("restir", 1000).then(
        () => "completed",
        (error) => String(error),
      );
      const started = performance.now();
      renderer.cancelComparison("cancelled during BDPT preparation");
      const cancelled = await active;
      const cancellationMs = performance.now() - started;
      const deadline = performance.now() + 20_000;
      while (renderer.stats.accumFrames < 2 && performance.now() < deadline) {
        renderer.renderFrame(DEFAULT_CAMERA);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const report = await renderer.compareReferenceAfter("restir", 100);
      return {
        saved,
        referenceSize,
        targetSize: [renderer.stats.width, renderer.stats.height],
        cancelled,
        cancellationMs,
        pending,
        compared: report !== null,
      };
    } finally {
      prototype.createComputePipelineAsync = compile;
      renderer.destroy();
      canvas.remove();
    }
  });
  test.skip(result === null, "WebGPU is unavailable in this browser.");
  expect(result.saved).toBe(true);
  expect(result.referenceSize).toEqual(result.targetSize);
  expect(result.referenceSize[0] * result.referenceSize[1]).toBeLessThanOrEqual(
    260744,
  );
  expect(result.cancelled).toContain("cancelled during BDPT preparation");
  expect(result.cancellationMs).toBeLessThan(250);
  expect(result.compared).toBe(true);
});
