import { expect, test } from "@playwright/test";

import { isPreviewTarget } from "./target";

for (const [scene, samples, bounces] of [
  ["classic", 4, 3],
  ["glassShapes", 8, 6],
  ["classic", 0, 3],
]) {
  test(`spatial census preserves frozen production output: ${scene}, ${samples} neighbors`, async ({
    page,
  }) => {
    test.skip(isPreviewTarget, "Imports development renderer modules.");
    test.setTimeout(180000);
    await page.goto("/?diagnostics=core&bdptDispatchPixels=0");
    await page.getByRole("heading", { name: "GPU diagnostics" }).waitFor();
    const result = await page.evaluate(
      async (options) => {
        const adapter = await navigator.gpu?.requestAdapter();
        if (!adapter?.features.has("timestamp-query")) return null;
        const { profileSpatialCensus } =
          await import("/e2e-tests/bdpt-spatial-census.js");
        return profileSpatialCensus(options);
      },
      { scene, samples, bounces, width: 48, height: 64, repeats: 2 },
    );
    test.skip(result === null, "WebGPU timestamps unavailable.");
    expect(result.mismatchWords).toBe(0);
    expect(result.runs).toHaveLength(2);
    const { forward, inverse, centerPrepare } = result.replays;
    const { forwardShifts, forwardRejected, inverseShifts, inverseRejected } =
      result.shifts;
    if (!samples) {
      expect(result.activePixels).toBe(0);
      expect(result.acceptedNeighbors).toBe(0);
      for (const phase of Object.values(result.replays))
        for (const count of Object.values(phase)) expect(count).toBe(0);
      for (const count of Object.values(result.shifts)) expect(count).toBe(0);
      return;
    }
    expect(result.activePixels).toBeGreaterThan(0);
    expect(result.acceptedNeighbors).toBeGreaterThanOrEqual(
      result.activePixels,
    );
    expect(centerPrepare.calls).toBeLessThanOrEqual(result.activePixels);
    expect(centerPrepare.calls).toBe(centerPrepare.lightBuilds);
    expect(forwardShifts).toBeGreaterThan(0);
    expect(forward.lightBuilds).toBe(forwardShifts);
    expect(forward.lightReuses).toBeLessThanOrEqual(forwardShifts);
    expect(forward.calls).toBe(forward.lightBuilds + forward.lightReuses);
    expect(forwardRejected).toBeLessThanOrEqual(forwardShifts);
    expect(inverse.lightReuses).toBe(0);
    expect(inverse.calls).toBeLessThanOrEqual(inverseShifts);
    expect(inverseRejected).toBeLessThanOrEqual(inverseShifts);
    expect(forwardShifts).toBeLessThanOrEqual(result.acceptedNeighbors);
    expect(inverseShifts).toBeLessThanOrEqual(result.acceptedNeighbors);
    for (const phase of [forward, inverse, centerPrepare]) {
      expect(phase.productive).toBeLessThanOrEqual(phase.calls);
      expect(phase.cameraSide).toBeLessThanOrEqual(phase.calls);
      expect(phase.reconnecting).toBeLessThanOrEqual(phase.cameraSide);
      expect(phase.cameraVertices).toBeGreaterThanOrEqual(phase.calls);
    }
    expect(result.overhead.ratioMin).toBeGreaterThan(0);
    expect(typeof result.overhead.distorted).toBe("boolean");
  });
}

test("spatial census rejects stale composed shader sources", async ({
  page,
}) => {
  test.skip(isPreviewTarget, "Imports development renderer modules.");
  await page.goto("/?diagnostics=core&bdptDispatchPixels=0");
  const supported = await page.evaluate(async () =>
    (await navigator.gpu?.requestAdapter())?.features.has("timestamp-query"),
  );
  test.skip(!supported, "WebGPU timestamps unavailable.");
  await expect(
    page.evaluate(async () => {
      const { profileSpatialCensus } =
        await import("/e2e-tests/bdpt-spatial-census.js");
      return profileSpatialCensus({
        width: 48,
        height: 64,
        repeats: 2,
        expectedShader: "stale replay dependency",
      });
    }),
  ).rejects.toThrow("Served spatial shader differs from disk");
});

test("spatial census shader rejects a missing marker", async ({ page }) => {
  test.skip(isPreviewTarget, "Imports development renderer modules.");
  await page.goto("/?diagnostics=core");
  await expect(
    page.evaluate(async () => {
      const { censusSpatialShader } =
        await import("/e2e-tests/bdpt-spatial-census-shader.js");
      return censusSpatialShader("fn main() {}");
    }),
  ).rejects.toThrow("Census marker missing or repeated");
});
