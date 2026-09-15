import { expect, test } from "@playwright/test";

const requireGpu = async (page) => {
  const available = await page.evaluate(async () =>
    Boolean(await navigator.gpu?.requestAdapter()),
  );
  test.skip(!available, "WebGPU unavailable");
};

test.use({ viewport: { width: 430, height: 500 } });

test("BDPT waits for GPU completion before another frame or resize allocation", async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (!globalThis.GPUQueue) return;
    window.__submits = 0;
    const submit = GPUQueue.prototype.submit;
    GPUQueue.prototype.submit = function (...args) {
      window.__submits++;
      return submit.apply(this, args);
    };
    const done = GPUQueue.prototype.onSubmittedWorkDone;
    let held = false;
    GPUQueue.prototype.onSubmittedWorkDone = async function () {
      await done.call(this);
      if (!held) {
        held = true;
        await new Promise((resolve) => {
          window.__releaseFrame = resolve;
        });
      }
    };
  });
  await page.goto("/?restir=bdpt");
  await requireGpu(page);
  await page.waitForFunction(() => window.__releaseFrame);
  await expect(page.getByRole("status")).toContainText("Waiting for GPU");
  await expect(page.getByRole("status")).toContainText(
    "Rendering the first frame",
  );
  expect(await page.evaluate(() => window.__submits)).toBe(1);
  await page.setViewportSize({ width: 460, height: 520 });
  await page.locator("canvas").dispatchEvent("wheel", { deltaY: 40 });
  await page.waitForTimeout(350);
  expect(await page.evaluate(() => window.__submits)).toBe(1);
  await page.evaluate(() => window.__releaseFrame());
  await expect
    .poll(() => page.evaluate(() => window.__submits), { timeout: 30_000 })
    .toBeGreaterThan(2);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("resizes do not overlap pending BDPT resource initialization", async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (!globalThis.GPUDevice) return;
    window.__initialAllocations = 0;
    const create = GPUDevice.prototype.createBuffer;
    GPUDevice.prototype.createBuffer = function (descriptor) {
      if (descriptor.label === "bdpt-camera-candidates")
        window.__initialAllocations++;
      return create.call(this, descriptor);
    };
    const compile = GPUDevice.prototype.createComputePipelineAsync;
    GPUDevice.prototype.createComputePipelineAsync = async function (
      descriptor,
    ) {
      const result = await compile.call(this, descriptor);
      if (descriptor.label === "bdpt-spatial")
        await new Promise((resolve) => {
          window.__releaseInitialization = resolve;
        });
      return result;
    };
  });
  await page.goto("/?restir=bdpt");
  await requireGpu(page);
  await page.waitForFunction(() => window.__releaseInitialization);
  await expect(page.getByRole("status")).toContainText(
    "Preparing spatial reuse",
  );
  await expect(page.getByTestId("renderer-step")).toHaveText("Step 5/7");
  await expect(page.getByTestId("renderer-elapsed")).not.toHaveText(
    "0s elapsed",
  );
  await page.screenshot({ path: test.info().outputPath("bdpt-preparing.png") });
  expect(await page.evaluate(() => window.__initialAllocations)).toBe(1);
  for (const width of [440, 450, 460]) {
    await page.setViewportSize({ width, height: 500 });
    await page.waitForTimeout(100);
  }
  expect(await page.evaluate(() => window.__initialAllocations)).toBe(1);
  await page.evaluate(() => window.__releaseInitialization());
  await expect(page.getByTestId("stat-accumulated")).not.toHaveText("0", {
    timeout: 30_000,
  });
  await expect(
    page.getByText("Preparing ReSTIR BDPT…", { exact: true }),
  ).toHaveCount(0);
  expect(await page.evaluate(() => window.__initialAllocations)).toBe(2);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("explicit BDPT pixel cap exercises normal rendering without capping ReSTIR GI", async ({
  page,
}) => {
  await page.goto("/?restir=bdpt&bdptPixels=1209");
  await requireGpu(page);
  await expect(page.getByTestId("stat-accumulated")).not.toHaveText("0", {
    timeout: 30_000,
  });
  const pixels = () =>
    page.locator("canvas").evaluate((canvas) => canvas.width * canvas.height);
  expect(await pixels()).toBeLessThanOrEqual(1209);
  await page.getByRole("button", { name: "Controls", exact: true }).click();
  await page.getByLabel("ReSTIR method").selectOption("gi");
  await expect.poll(pixels).toBeGreaterThan(1209);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("reuse query controls apply before BDPT starts and remain editable", async ({
  page,
}) => {
  await page.goto(
    "/?restir=bdpt&temporal=off&spatial=off&denoise=off&bdptPixels=1209",
  );
  await requireGpu(page);
  await expect(page.getByTestId("stat-accumulated")).not.toHaveText("0", {
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Controls", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "Temporal reuse", exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Spatial reuse", exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "À-trous filter", exact: true }),
  ).not.toBeChecked();
  await page
    .getByRole("checkbox", { name: "Temporal reuse", exact: true })
    .click();
  await expect(
    page.getByRole("checkbox", { name: "Temporal reuse", exact: true }),
  ).toBeChecked();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
