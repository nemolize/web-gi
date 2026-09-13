import { expect, test } from "@playwright/test";

import { isPreviewTarget } from "./target";

for (const maximum of [4, 1]) {
  test(`BDPT starts compilation at ${maximum}x${maximum} from the URL`, async ({
    page,
  }) => {
    test.skip(isPreviewTarget, "Imports development renderer modules.");
    await page.goto(
      `/?diagnostics=core&bdptWorkgroupSize=${maximum}&bdptDispatchPixels=4096`,
    );
    const result = await page.evaluate(async (maximum) => {
      if (!(await navigator.gpu?.requestAdapter())) return null;
      const { GiRenderer } = await import("/src/gi/renderer.ts");
      const { DEFAULT_SETTINGS } = await import("/src/gi/settings.ts");
      const { DEFAULT_CAMERA } = await import("/src/gi/camera.ts");
      const original = GPUDevice.prototype.createComputePipelineAsync;
      const attempts = [];
      GPUDevice.prototype.createComputePipelineAsync = function (descriptor) {
        if (descriptor.label?.startsWith("bdpt-")) {
          const size = descriptor.compute.constants.BDPT_WORKGROUP_SIZE;
          attempts.push({ label: descriptor.label, size });
          if (size > maximum)
            return Promise.reject(new Error("Forbidden larger workgroup"));
        }
        return original.call(this, descriptor);
      };
      const canvas = document.createElement("canvas");
      canvas.style.cssText = "width:123px;height:91px";
      document.body.append(canvas);
      let renderer;
      const logs = [];
      try {
        renderer = await GiRenderer.create(
          canvas,
          { ...DEFAULT_SETTINGS, restirMethod: "bdpt", smoothMotion: false },
          (line) => logs.push(line),
        );
        const deadline = performance.now() + 60000;
        while (renderer.stats.accumFrames < 3) {
          if (performance.now() > deadline)
            throw Error("No completed BDPT frame");
          renderer.renderFrame(DEFAULT_CAMERA);
          await renderer.bdptInitialization;
          await renderer.bdptPresentation;
          if (renderer.allocationError) throw Error(renderer.allocationError);
        }
        const image = await renderer.captureLinearImage();
        return {
          attempts,
          logs,
          finite: image.data.every(Number.isFinite),
          positive: image.data.some(
            (value, index) => index % 4 !== 3 && value > 0,
          ),
        };
      } finally {
        renderer?.destroy();
        canvas.remove();
        GPUDevice.prototype.createComputePipelineAsync = original;
      }
    }, maximum);
    test.skip(result === null, "WebGPU unavailable.");
    expect(result.attempts).toHaveLength(7);
    expect(result.attempts.every((attempt) => attempt.size === maximum)).toBe(
      true,
    );
    expect(result.logs).toContain(`BDPT workgroup size limit: ${maximum}`);
    expect(result.finite).toBe(true);
    expect(result.positive).toBe(true);
  });
}
