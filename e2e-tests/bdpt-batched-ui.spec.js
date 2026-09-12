import { expect, test } from "@playwright/test";

test("batched BDPT defers scene changes while a tile is pending and exposes progress", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1100, height: 480 });
  await page.addInitScript(() => {
    if (!globalThis.GPUQueue) return;
    window.__historyClears = 0;
    const clear = GPUCommandEncoder.prototype.clearBuffer;
    GPUCommandEncoder.prototype.clearBuffer = function (buffer, ...rest) {
      if (buffer.label.startsWith("bdpt-history-")) window.__historyClears++;
      return clear.call(this, buffer, ...rest);
    };
    const write = GPUQueue.prototype.writeBuffer;
    GPUQueue.prototype.writeBuffer = function (buffer, offset, data, ...rest) {
      if (window.__armTileHold && buffer.label === "bdpt-dispatch-region") {
        window.__tileWritten = true;
      }
      return write.call(this, buffer, offset, data, ...rest);
    };
    const done = GPUQueue.prototype.onSubmittedWorkDone;
    GPUQueue.prototype.onSubmittedWorkDone = async function () {
      await done.call(this);
      if (window.__armTileHold && window.__tileWritten) {
        window.__armTileHold = false;
        await new Promise((resolve) => {
          window.__releaseTile = resolve;
        });
      }
    };
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("/?bdptDispatchPixels=4096");
  test.skip(
    !(await page.evaluate(async () =>
      Boolean(await navigator.gpu?.requestAdapter()),
    )),
    "WebGPU unavailable",
  );
  await page.getByLabel("Resolution scale").fill("0.25");
  await page.evaluate(() => {
    window.__armTileHold = true;
  });
  await page.getByLabel("ReSTIR method").selectOption("bdpt");
  await page.waitForFunction(
    () => window.__releaseTile,
    {},
    { timeout: 60_000 },
  );
  await expect(page.getByText(/Step \d+\/\d+/)).toBeVisible({
    timeout: 10_000,
  });
  await page.getByLabel("Scene", { exact: true }).selectOption("glassShapes");
  await page.setViewportSize({ width: 1200, height: 540 });
  await page.evaluate(() => window.__releaseTile());
  await expect
    .poll(
      async () => {
        const alert = await page.getByRole("alert").allTextContents();
        if (alert.length) throw new Error(alert.join("\n"));
        return Number(await page.getByTestId("stat-accumulated").textContent());
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThan(3);
  const captured = await page.evaluate(async () => {
    const result = await globalThis.__gi?.capture();
    if (!result) return null;
    return {
      width: result.width,
      height: result.height,
      finite: result.data.every(Number.isFinite),
      positive: result.data.some((v, i) => i % 4 !== 3 && v > 0),
    };
  });
  expect(captured).toMatchObject({
    width: 220,
    height: 135,
    finite: true,
    positive: true,
  });
  await page.getByLabel("Smooth camera motion").uncheck();
  await expect
    .poll(
      async () =>
        Number(await page.getByTestId("stat-accumulated").textContent()),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(3);
  await page.evaluate(() => {
    window.__releaseTile = null;
    window.__tileWritten = false;
    window.__armTileHold = true;
  });
  await page.waitForFunction(
    () => window.__releaseTile,
    {},
    { timeout: 60_000 },
  );
  const beforeMotion = await page.evaluate(() => ({
    clears: window.__historyClears,
    frames: Number(
      document.querySelector('[data-testid="stat-accumulated"]').textContent,
    ),
  }));
  await page.locator("canvas").dispatchEvent("wheel", { deltaY: 40 });
  await page.evaluate(() => window.__releaseTile());
  await expect
    .poll(
      async () =>
        Number(await page.getByTestId("stat-accumulated").textContent()),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(beforeMotion.frames + 2);
  expect(await page.evaluate(() => window.__historyClears)).toBe(
    beforeMotion.clears,
  );
  await page.getByLabel("ReSTIR method").selectOption("gi");
  await expect
    .poll(async () =>
      Number(await page.getByTestId("stat-accumulated").textContent()),
    )
    .toBeGreaterThan(3);
  expect(errors).toEqual([]);
});
