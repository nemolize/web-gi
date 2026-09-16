import { expect, test } from "@playwright/test";

import { attachBdptComparisonImage } from "./bdpt-image";
import { runBdptRenderProbe } from "./bdpt-render-probe";
import { isPreviewTarget } from "./target";

test("BDPT initial passes route glass caustics and clear light lists between frames", async ({
  page,
}) => {
  test.skip(
    isPreviewTarget,
    "The initial-pass harness imports development modules; application integration is pending.",
  );
  test.setTimeout(120_000);
  await page.goto("/");
  const result = await runBdptRenderProbe(page);
  test.skip(result === null, "WebGPU is unavailable in this browser.");
  expect(result.errors).toEqual([]);
  console.log({
    referenceMean: result.referenceMean,
    bdptMean: result.bdptMean,
  });
  expect(Math.abs(result.bdptMean / result.referenceMean - 1)).toBeLessThan(
    0.02,
  );
  expect(result.finite).toBe(true);
  expect(result.confidenceValid).toBe(true);
  expect(result.darkCleared).toBe(true);
  expect(result.lightPathCount).toBe(result.width * result.height);
  expect(result.causticSamples).toBeGreaterThan(0);
  expect(result.emptySamples).toBeGreaterThan(0);
  expect(Math.max(...result.image)).toBeGreaterThan(0);
  await attachBdptComparisonImage(page, result, test.info());
});
