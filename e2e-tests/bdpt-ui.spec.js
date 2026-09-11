import { expect, test } from "@playwright/test";

const waitForFrames = async (page) => {
  await expect
    .poll(
      async () => {
        const alerts = await page.getByRole("alert").allTextContents();
        if (alerts.length) throw new Error(alerts.join("\n"));
        const frames = Number(
          await page.getByTestId("stat-accumulated").textContent(),
        );
        return (await capture(page)) ? frames : 0;
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThan(8);
};

const capture = async (page) =>
  page.evaluate(async () => {
    if (!globalThis.__gi) return null;
    const image = await globalThis.__gi.capture();
    if (!image) return null;
    let total = 0;
    let finite = true;
    for (let i = 0; i < image.data.length; i++) {
      finite &&= Number.isFinite(image.data[i]);
      if (i % 4 !== 3) total += image.data[i];
    }
    return {
      width: image.width,
      height: image.height,
      finite,
      mean: total / (image.width * image.height * 3),
    };
  });

test("switches all ReSTIR methods and renders BDPT through motion and resize", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1100, height: 480 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("/");
  const adapter = await page.evaluate(async () =>
    Boolean(await navigator.gpu?.requestAdapter()),
  );
  test.skip(!adapter, "WebGPU is unavailable in this browser.");
  await page.getByLabel("Resolution scale").fill("0.25");
  await page.getByLabel("Scene", { exact: true }).selectOption("glassShapes");
  const method = page.getByLabel("ReSTIR method");
  await expect(method.locator("option")).toHaveText([
    "ReSTIR",
    "ReSTIR + PT fallback",
    "ReSTIR BDPT",
  ]);
  const measurements = {};
  for (const name of ["gi", "pt-fallback", "bdpt"]) {
    await method.selectOption(name);
    await waitForFrames(page);
    measurements[name] = await capture(page);
    expect(measurements[name]).not.toBeNull();
    if (measurements[name]) {
      expect(measurements[name].finite).toBe(true);
      expect(measurements[name].mean).toBeGreaterThan(0);
    }
    await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
  }
  await expect(page.getByLabel("RIS candidates")).toHaveCount(0);
  await page.getByLabel("Smooth camera motion").uncheck();
  await page.locator("canvas").dispatchEvent("wheel", { deltaY: 50 });
  await waitForFrames(page);
  await page.getByLabel("Smooth camera motion").check();
  await page.locator("canvas").dispatchEvent("wheel", { deltaY: -40 });
  await page.setViewportSize({ width: 1200, height: 540 });
  await expect
    .poll(async () => (await capture(page))?.width ?? 0, { timeout: 60_000 })
    .toBe(220);
  await waitForFrames(page);
  const moved = await capture(page);
  expect(moved?.finite).toBe(true);
  expect(moved?.mean).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath("bdpt-moved.png") });
  await method.selectOption("gi");
  await waitForFrames(page);
  await method.selectOption("bdpt");
  await waitForFrames(page);
  expect(errors).toEqual([]);
  console.log({ measurements, moved });
});

test("switching away during BDPT compilation releases the stale buffers", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1100, height: 480 });
  await page.addInitScript(() => {
    globalThis.bdptResources = { pending: 0, bytes: 0 };
    const prototype = globalThis.GPUDevice?.prototype;
    if (!prototype) return;
    const compile = prototype.createComputePipelineAsync;
    prototype.createComputePipelineAsync = function (descriptor) {
      const result = Reflect.apply(compile, this, [descriptor]);
      if (!descriptor.label?.startsWith("bdpt")) return result;
      globalThis.bdptResources.pending++;
      return result.then(async (pipeline) => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        globalThis.bdptResources.pending--;
        return pipeline;
      });
    };
    const allocate = prototype.createBuffer;
    prototype.createBuffer = function (descriptor) {
      const buffer = Reflect.apply(allocate, this, [descriptor]);
      if (!descriptor.label?.startsWith("bdpt")) return buffer;
      globalThis.bdptResources.bytes += descriptor.size;
      const destroy = buffer.destroy.bind(buffer);
      let destroyed = false;
      buffer.destroy = () => {
        if (!destroyed) globalThis.bdptResources.bytes -= descriptor.size;
        destroyed = true;
        destroy();
      };
      return buffer;
    };
  });
  await page.goto("/?restir=bdpt");
  const adapter = await page.evaluate(async () =>
    Boolean(await navigator.gpu?.requestAdapter()),
  );
  test.skip(!adapter, "WebGPU is unavailable in this browser.");
  await expect
    .poll(() => page.evaluate(() => globalThis.bdptResources.pending))
    .toBeGreaterThan(0);
  await page.getByLabel("ReSTIR method").selectOption("gi");
  await waitForFrames(page);
  await expect
    .poll(() => page.evaluate(() => globalThis.bdptResources.pending), {
      timeout: 20_000,
    })
    .toBe(0);
  await expect
    .poll(() => page.evaluate(() => globalThis.bdptResources.bytes), {
      timeout: 20_000,
    })
    .toBe(0);
});

test("a failed BDPT compiler does not prevent switching to ReSTIR", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1100, height: 480 });
  await page.addInitScript(() => {
    const prototype = globalThis.GPUDevice?.prototype;
    if (!prototype) return;
    const compile = prototype.createComputePipelineAsync;
    prototype.createComputePipelineAsync = function (descriptor) {
      if (descriptor.label?.startsWith("bdpt"))
        return Promise.reject(new Error("Injected BDPT compile failure"));
      return Reflect.apply(compile, this, [descriptor]);
    };
  });
  await page.goto("/?restir=bdpt");
  const adapter = await page.evaluate(async () =>
    Boolean(await navigator.gpu?.requestAdapter()),
  );
  test.skip(!adapter, "WebGPU is unavailable in this browser.");
  await expect(page.getByRole("alert")).toContainText(
    "Injected BDPT compile failure",
    { timeout: 20_000 },
  );
  await page.getByLabel("ReSTIR method").selectOption("gi");
  await waitForFrames(page);
  expect((await capture(page))?.mean).toBeGreaterThan(0);
});
