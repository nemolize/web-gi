import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

import { isPreviewTarget } from "./target";

const referenceSpatial = readFileSync(
  new URL("./bdpt-spatial-independent.wgsl", import.meta.url),
  "utf8",
);

for (const [scene, samples, bounces] of [
  ["classic", 4, 3],
  ["glassShapes", 8, 6],
  ["classic", 0, 3],
  ["glassShapes", 32, 6],
]) {
  test(`spatial reuse and profiling match independent replay: ${scene}, ${samples} neighbors`, async ({
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
        const { profileSpatial } =
          await import("/e2e-tests/bdpt-spatial-profile.js");
        return profileSpatial(options);
      },
      {
        scene,
        samples,
        bounces,
        width: 48,
        height: 64,
        repeats: 2,
        referenceSpatial,
      },
    );
    test.skip(result === null, "WebGPU timestamps unavailable.");
    expect(result.mismatchWords).toBe(0);
    expect(result.runs).toHaveLength(2);
    expect(result.acceptedNeighbors).toBeGreaterThanOrEqual(
      result.activePixels,
    );
    if (samples) expect(result.activePixels).toBeGreaterThan(0);
    else expect(result.activePixels).toBe(0);
    for (const run of result.runs)
      for (const ms of Object.values(run.ms))
        expect(ms).toBeGreaterThanOrEqual(0);
  });
}

test("spatial profile rejects stale composed shader sources", async ({
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
      const { profileSpatial } =
        await import("/e2e-tests/bdpt-spatial-profile.js");
      return profileSpatial({
        width: 48,
        height: 64,
        repeats: 2,
        expectedShader: "stale replay dependency",
      });
    }),
  ).rejects.toThrow("Served spatial shader differs from disk");
});
