import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { chromium } from "playwright";

const [
  baseURL,
  output,
  scene = "classic",
  samples = "4",
  bounces = "3",
  width = "352",
  height = "738",
] = process.argv.slice(2);
if (!baseURL || !output)
  throw Error(
    "Usage: node e2e-tests/measure-bdpt-spatial.mjs BASE_URL OUTPUT_JSON [SCENE SAMPLES BOUNCES WIDTH HEIGHT]",
  );
const profile = mkdtempSync(join(tmpdir(), "web-gi-spatial-208-"));
let browser;
let deadline;
try {
  browser = await chromium.launchPersistentContext(profile, {
    viewport: { width: 430, height: 900 },
    deviceScaleFactor: 1,
    channel: "chrome",
    headless: false,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = browser.pages()[0];
  page.setDefaultTimeout(120000);
  console.log("Profiling", scene, samples, bounces);
  await page.goto(
    new URL("/?diagnostics=core&bdptDispatchPixels=0", baseURL).href,
  );
  await page.getByRole("heading", { name: "GPU diagnostics" }).waitFor();
  const result = await Promise.race([
    page.evaluate(
      async (options) => {
        const { profileSpatial } =
          await import("/e2e-tests/bdpt-spatial-profile.js");
        return profileSpatial(options);
      },
      {
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
    cpu: cpus()[0]?.model,
    revision: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    ...result,
  };
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} finally {
  clearTimeout(deadline);
  await browser?.close();
  rmSync(profile, { recursive: true });
}
