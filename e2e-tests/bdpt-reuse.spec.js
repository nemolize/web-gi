import { expect, test } from "@playwright/test";

import { attachBdptComparisonImage } from "./bdpt-image";
import { runBdptRenderProbe } from "./bdpt-render-probe";
import { isPreviewTarget } from "./target";

test("BDPT spatiotemporal passes preserve energy and clear reservoir history", async ({
  page,
}) => {
  test.skip(
    isPreviewTarget,
    "The pass harness imports development modules; application integration is pending.",
  );
  test.setTimeout(180_000);
  await page.goto("/");
  const result = await runBdptRenderProbe(page, { reuse: true, frames: 256 });
  test.skip(result === null, "WebGPU is unavailable in this browser.");
  expect(result.errors).toEqual([]);
  expect(result.finite).toBe(true);
  expect(result.confidenceValid).toBe(true);
  expect(result.darkCleared).toBe(true);
  expect(result.spatialSelectionsChanged).toBeGreaterThan(0);
  expect(result.causticsPreserved).toBe(true);
  expect(result.causticSamples).toBeGreaterThan(0);
  expect(Math.abs(result.bdptMean / result.referenceMean - 1)).toBeLessThan(
    0.03,
  );
  console.log({
    referenceMean: result.referenceMean,
    bdptMean: result.bdptMean,
  });
  await attachBdptComparisonImage(page, result, test.info());
});

test("BDPT reuse bypasses spatial selection and supports a one-frame history cap", async ({
  page,
}) => {
  test.skip(
    isPreviewTarget,
    "The pass harness imports development modules; application integration is pending.",
  );
  await page.goto("/");
  const result = await runBdptRenderProbe(page, {
    reuse: true,
    frames: 16,
    spatialSamples: 0,
    historyCap: 1,
  });
  test.skip(result === null, "WebGPU is unavailable in this browser.");
  expect(result.errors).toEqual([]);
  expect(result.spatialSelectionsChanged).toBe(0);
  expect(result.causticsPreserved).toBe(true);
  expect(result.confidenceValid).toBe(true);
  expect(result.darkCleared).toBe(true);
});

test("BDPT motion reuse keeps confidence independent of realized light samples", async ({
  page,
}) => {
  test.skip(isPreviewTarget, "The pass harness imports development modules.");
  test.setTimeout(180_000);
  await page.goto("/");
  const options = { reuse: true, frames: 256, cameraMotion: true };
  const lit = await runBdptRenderProbe(page, options);
  test.skip(lit === null, "WebGPU is unavailable in this browser.");
  const dark = await runBdptRenderProbe(page, { ...options, unlit: true });
  expect(dark).not.toBeNull();
  for (const result of [lit, dark]) {
    expect(result.errors).toEqual([]);
    expect(result.finite).toBe(true);
    expect(result.confidenceValid).toBe(true);
    expect(result.darkCleared).toBe(true);
  }
  expect(lit.confidenceSignature).toBe(dark.confidenceSignature);
  expect(lit.causticSamples).toBeGreaterThan(0);
  expect(dark.causticSamples).toBe(0);
  expect(dark.bdptMean).toBe(0);
  expect(Math.abs(lit.bdptMean / lit.referenceMean - 1)).toBeLessThan(0.03);
  console.log({ motionReference: lit.referenceMean, motionBdpt: lit.bdptMean });
  await attachBdptComparisonImage(page, lit, test.info());
});
