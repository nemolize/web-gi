import { expect, test } from "@playwright/test";

import { runBatchedProbe } from "./bdpt-batched-probe";

for (const [workgroupSize, cap] of [
  [8, 256],
  [4, 64],
  [1, 256],
]) {
  test(`BDPT batching preserves camera samples and coverage at ${workgroupSize}x${workgroupSize}`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.goto("/?diagnostics=core");
    test.skip(
      !(await page.evaluate(async () =>
        Boolean(await navigator.gpu?.requestAdapter()),
      )),
      "WebGPU unavailable",
    );
    const source = await page.request.get("/src/gi/bdpt/runtime.ts");
    test.skip(
      !source.headers()["content-type"]?.includes("javascript"),
      "Development modules unavailable",
    );
    const result = await runBatchedProbe(page, workgroupSize, cap);
    expect(result.errors).toEqual([]);
    expect(result.compiledSizes.length).toBeGreaterThanOrEqual(7);
    expect(result.compiledSizes.every((size) => size === workgroupSize)).toBe(
      true,
    );
    expect(result.coverageErrors).toEqual([]);
    for (const frame of result.frames) {
      expect(frame.cameraMismatches).toBe(0);
      for (const stats of [...frame.baseline, ...frame.batched]) {
        expect(stats.finite).toBe(true);
        expect(stats.positive).toBeGreaterThan(0);
      }
    }
    for (const stage of [0, 1]) {
      const baseline = result.frames.reduce(
        (sum, frame) => sum + frame.baseline[stage].mean,
        0,
      );
      const batched = result.frames.reduce(
        (sum, frame) => sum + frame.batched[stage].mean,
        0,
      );
      expect(Math.abs(batched - baseline) / baseline).toBeLessThan(0.2);
    }
  });
}
