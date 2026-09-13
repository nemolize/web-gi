import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { cpus, hostname } from "node:os";
import process from "node:process";

import { chromium } from "playwright";
const [
  baseURL,
  baselineRef,
  outputPath,
  scene = "classic",
  samples = "4",
  bounces = "3",
  cap = "0",
] = process.argv.slice(2);
if (!baseURL || !baselineRef || !outputPath)
  throw Error(
    "Usage: node e2e-tests/measure-bdpt.mjs BASE_URL BASELINE_REF OUTPUT_JSON [SCENE SAMPLES BOUNCES DISPATCH_CAP]",
  );
const paths = ["bdpt-subpath", "bdpt-replay", "bdpt-spatial"];
const sources = paths.map((n) => ({
  current: readFileSync("src/gi/shaders/" + n + ".wgsl", "utf8"),
  old: execFileSync(
    "git",
    ["show", baselineRef + ":src/gi/shaders/" + n + ".wgsl"],
    { encoding: "utf8" },
  ),
}));
const browser = await chromium.launch({
  channel: "chrome",
  args: ["--enable-unsafe-webgpu"],
});
const results = [];
try {
  for (const variant of [
    "before",
    "after",
    "after",
    "before",
    "before",
    "after",
  ]) {
    const page = await browser.newPage({
      viewport: { width: 430, height: 900 },
      deviceScaleFactor: 2.25,
    });
    page.on("pageerror", (error) => console.error(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") console.error(message.text());
    });
    await page.addInitScript(
      ({ variant, sources }) => {
        const create = GPUDevice.prototype.createShaderModule;
        window.__shaderChecks = [];
        GPUDevice.prototype.createShaderModule = function (desc) {
          const originalCode = desc.code;
          const capacity = /const BDPT_MAX_VERTICES: u32 = (\d+)u;/.exec(
            desc.code,
          )?.[1];
          const normalized = desc.code.replace(
            /const BDPT_MAX_VERTICES: u32 = \d+u;/,
            "const BDPT_MAX_VERTICES: u32 = 32u;",
          );
          if (desc.label === "bdpt-spatial") {
            for (const s of sources) {
              if (!normalized.includes(s.current))
                throw Error("Unexpected shader source");
            }
            window.__shaderChecks.push({
              variant,
              capacity: variant === "before" ? 32 : Number(capacity),
            });
          }
          if (variant === "before") {
            desc = { ...desc, code: normalized };
            for (const s of sources)
              desc = { ...desc, code: desc.code.replace(s.current, s.old) };
          }
          if (variant === "after" && desc.code !== originalCode)
            throw Error("Optimized shader was modified by the benchmark");
          return create.call(this, desc);
        };
      },
      { variant, sources },
    );
    console.log("Starting", variant);
    await page.goto(baseURL + "/?restir=bdpt&bdptDispatchPixels=" + cap);
    await page.getByRole("button", { name: "Controls", exact: true }).click();
    await page.getByLabel("Scene", { exact: true }).selectOption(scene);
    await page.getByLabel("Spatial neighbours").fill(samples);
    await page.getByLabel("Bounces").fill(bounces);
    const effectiveSettings = {
      scene: await page.getByLabel("Scene", { exact: true }).inputValue(),
      samples: await page.getByLabel("Spatial neighbours").inputValue(),
      bounces: await page.getByLabel("Bounces").inputValue(),
    };
    if (
      effectiveSettings.scene !== scene ||
      effectiveSettings.samples !== samples ||
      effectiveSettings.bounces !== bounces
    )
      throw Error("Settings mismatch");
    await page.getByRole("button", { name: "Close controls" }).click();
    await page.waitForFunction(
      () => {
        const alert = document.querySelector('[role="alert"]');
        if (alert) throw Error(alert.textContent);
        return (
          Number(
            document.querySelector('[data-testid="stat-accumulated"]')
              ?.textContent,
          ) > 10
        );
      },
      {},
      { timeout: 120000 },
    );
    const metadata = await page.evaluate(async () => {
      const a = await navigator.gpu.requestAdapter();
      return {
        userAgent: navigator.userAgent,
        adapter: {
          vendor: a.info.vendor,
          architecture: a.info.architecture,
          description: a.info.description,
        },
      };
    });
    const start = await page.evaluate(() => ({
      t: performance.now(),
      n: Number(
        document.querySelector('[data-testid="stat-accumulated"]').textContent,
      ),
    }));
    await page.waitForFunction(
      (n) =>
        Number(
          document.querySelector('[data-testid="stat-accumulated"]')
            .textContent,
        ) >=
        n + 30,
      start.n,
      { timeout: 120000 },
    );
    const end = await page.evaluate(() => ({
      t: performance.now(),
      n: Number(
        document.querySelector('[data-testid="stat-accumulated"]').textContent,
      ),
      checks: window.__shaderChecks,
      size: [
        document.querySelector("canvas").width,
        document.querySelector("canvas").height,
      ],
    }));
    if (!end.checks.length) throw Error("No shader proof");
    const errors = await page.getByRole("alert").allTextContents();
    if (errors.length) throw Error(errors.join("\n"));
    const r = {
      effectiveSettings,
      variant,
      metadata,
      ...end,
      frames: end.n - start.n,
      ms: (end.t - start.t) / (end.n - start.n),
    };
    results.push(r);
    console.log(JSON.stringify(r));
    await page.close();
  }
  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        host: hostname(),
        cpu: cpus()[0]?.model,
        baselineRef,
        scene,
        samples,
        bounces,
        cap,
        viewport: { width: 430, height: 900, dpr: 2.25 },
        warmupFrames: 10,
        results,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
