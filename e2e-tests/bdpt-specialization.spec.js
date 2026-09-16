import { expect, test } from "@playwright/test";

import { isPreviewTarget } from "./target";

test("BDPT changes capacity across settings and discards obsolete compilation", async ({
  page,
}) => {
  test.skip(isPreviewTarget, "Imports development renderer modules.");
  await page.goto("/?diagnostics=core");
  const result = await page.evaluate(async () => {
    if (!(await navigator.gpu?.requestAdapter())) return null;
    const { GiRenderer } = await import("/src/gi/renderer.ts");
    const { DEFAULT_SETTINGS } = await import("/src/gi/settings.ts");
    const { DEFAULT_CAMERA } = await import("/src/gi/camera.ts");
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "width:120px;height:90px";
    document.body.append(canvas);
    let settings = {
      ...DEFAULT_SETTINGS,
      restirMethod: "bdpt",
      smoothMotion: false,
    };
    const renderer = await GiRenderer.create(canvas, settings);
    const compile = GPUDevice.prototype.createComputePipelineAsync;
    let release;
    let held = false;
    const capacities = [];
    GPUDevice.prototype.createComputePipelineAsync = async function (
      descriptor,
    ) {
      const result = await compile.call(this, descriptor);
      if (descriptor.label === "bdpt-initial-camera" && !held) {
        held = true;
        await new Promise((resolve) => {
          release = resolve;
        });
      }
      return result;
    };
    const wait = async (predicate) => {
      const deadline = performance.now() + 60000;
      while (!predicate()) {
        if (performance.now() >= deadline)
          throw Error("BDPT initialization did not finish");
        renderer.renderFrame(DEFAULT_CAMERA);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    try {
      await wait(() => release !== undefined);
      settings = { ...settings, scene: "glassShapes", maxBounces: 6 };
      renderer.setSettings(settings);
      release();
      await renderer.bdptInitialization;
      const obsoleteDiscarded = renderer.bdpt === null;
      for (const [scene, maxBounces, capacity] of [
        ["glassShapes", 6, 21],
        ["classic", 3, 10],
        ["glassShapes", 12, 27],
        ["glassShapes", 1, 16],
        ["classic", 3, 10],
      ]) {
        settings = { ...settings, scene, maxBounces };
        renderer.setSettings(settings);
        await wait(
          () =>
            renderer.bdpt?.maxVertices === capacity &&
            renderer.stats.accumFrames >= 3,
        );
        const image = await renderer.captureLinearImage();
        if (!image) throw Error("Missing specialized output");
        capacities.push({
          capacity: renderer.bdpt.maxVertices,
          finite: image.data.every(Number.isFinite),
          positive: image.data.some(
            (value, index) => index % 4 !== 3 && value > 0,
          ),
        });
      }
      return { obsoleteDiscarded, capacities };
    } finally {
      GPUDevice.prototype.createComputePipelineAsync = compile;
      renderer.destroy();
      canvas.remove();
    }
  });
  test.skip(result === null, "WebGPU unavailable.");
  expect(result.obsoleteDiscarded).toBe(true);
  expect(result.capacities.map((v) => v.capacity)).toEqual([
    21, 10, 27, 16, 10,
  ]);
  for (const output of result.capacities) {
    expect(output.finite).toBe(true);
    expect(output.positive).toBe(true);
  }
});
