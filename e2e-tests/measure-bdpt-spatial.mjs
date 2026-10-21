import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { chromium } from "playwright";

const census = process.argv.includes("--census");
const [
  baseURL,
  output,
  scene = "classic",
  samples = "4",
  bounces = "3",
  width = "352",
  height = "738",
] = process.argv.slice(2).filter((argument) => argument !== "--census");
if (!baseURL || !output)
  throw Error(
    "Usage: node e2e-tests/measure-bdpt-spatial.mjs [--census] BASE_URL OUTPUT_JSON [SCENE SAMPLES BOUNCES WIDTH HEIGHT]",
  );
const profile = mkdtempSync(join(tmpdir(), "web-gi-spatial-208-"));
const cdpEndpoint = process.env["CDP_ENDPOINT"];
let browser;
let page;
let deadline;
try {
  if (cdpEndpoint) {
    browser = await chromium.connectOverCDP(cdpEndpoint);
    page = await browser.contexts()[0].newPage();
  } else {
    browser = await chromium.launchPersistentContext(profile, {
      viewport: { width: 430, height: 900 },
      deviceScaleFactor: 1,
      channel: "chrome",
      headless: false,
      args: ["--enable-unsafe-webgpu"],
    });
    page = browser.pages()[0];
  }
  page.setDefaultTimeout(120000);
  console.log(census ? "Census" : "Profiling", scene, samples, bounces);
  await page.goto(
    new URL("/?diagnostics=core&bdptDispatchPixels=0", baseURL).href,
  );
  await page.getByRole("heading", { name: "GPU diagnostics" }).waitFor();
  const result = await Promise.race([
    page.evaluate(
      async ({ census, ...options }) => {
        if (census)
          return (
            await import("/e2e-tests/bdpt-spatial-census.js")
          ).profileSpatialCensus(options);
        const { profileSpatial } =
          await import("/e2e-tests/bdpt-spatial-profile.js");
        return profileSpatial(options);
      },
      {
        census,
        expectedShader: [
          "common",
          "scene",
          "bdpt-resampling",
          "bdpt-transport",
          "bdpt-subpath",
          "bdpt-camera",
          "bdpt-mis",
          "bdpt-candidate",
          "bdpt-replay",
          "bdpt-reservoir",
          "bdpt-initial",
          "bdpt-motion",
          "bdpt-spatial",
        ]
          .map((name) =>
            readFileSync(
              new URL(`../src/gi/shaders/${name}.wgsl`, import.meta.url),
              "utf8",
            ),
          )
          .join("\n"),
        scene,
        samples: Number(samples),
        bounces: Number(bounces),
        width: Number(width),
        height: Number(height),
      },
    ),
    new Promise((_, reject) => {
      deadline = setTimeout(
        () => reject(Error("Spatial profiling exceeded 180 seconds")),
        180000,
      );
    }),
  ]);
  clearTimeout(deadline);
  if (!result.shaderHash || !result.positivePixels)
    throw Error("Stale profiling module; restart the dev server");
  const report = {
    schemaVersion: 1,
    cpu: cdpEndpoint ? undefined : cpus()[0]?.model,
    revision: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    ...result,
  };
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} finally {
  clearTimeout(deadline);
  await page?.close();
  await browser?.close();
  rmSync(profile, { recursive: true });
}
