import { expect, test } from "@playwright/test";

test("BDPT diagnostics compile isolated stages without starting the renderer", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?bdptDiagnostics=1");
  await expect(
    page.getByRole("heading", { name: "GPU diagnostics" }),
  ).toBeVisible();
  await expect(page.locator("canvas")).toHaveCount(0);
  test.skip(
    !(await page.evaluate(async () =>
      Boolean(await navigator.gpu?.requestAdapter()),
    )),
    "WebGPU is unavailable.",
  );
  await page
    .getByRole("button", { name: "Run diagnostics", exact: true })
    .click();
  await expect(page.getByLabel("Diagnostic report")).toHaveValue(/DONE\./, {
    timeout: 150_000,
  });
  const report = await page.getByLabel("Diagnostic report").inputValue();
  expect(report).not.toContain("FAIL");
  expect(report.match(/^\[\+\d+\.\d{3}s\] PASS /gm)).toHaveLength(24);
  expect(report).toContain('"vendor"');
  expect(errors).toEqual([]);
});

test("BDPT diagnostics retain failures and can stop an outstanding compiler", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = GPUDevice.prototype.createComputePipelineAsync;
    GPUDevice.prototype.createComputePipelineAsync = function (descriptor) {
      if (descriptor.label?.startsWith("primary-hit"))
        return Promise.reject(
          new GPUPipelineError("injected internal failure", {
            reason: "internal",
          }),
        );
      if (descriptor.label?.startsWith("camera-subpath"))
        return new Promise(() => {});
      return original.call(this, descriptor);
    };
  });
  await page.goto("/?bdptDiagnostics=1");
  test.skip(
    !(await page.evaluate(async () =>
      Boolean(await navigator.gpu?.requestAdapter()),
    )),
    "WebGPU is unavailable.",
  );
  await page
    .getByRole("button", { name: "Run diagnostics", exact: true })
    .click();
  await expect(page.getByLabel("Diagnostic report")).toHaveValue(
    /START camera-subpath/,
    { timeout: 30_000 },
  );
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByLabel("Diagnostic report")).toHaveValue(/Stopped\./);
  const report = await page.getByLabel("Diagnostic report").inputValue();
  expect(report).toContain("FAIL primary-hit");
  expect(report).not.toContain("START light-subpath");
  await expect(
    page.getByRole("button", { name: "Run diagnostics", exact: true }),
  ).toBeEnabled();
});

test("BDPT diagnostics stop on device loss instead of reporting successful compilation", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = GPUDevice.prototype.createComputePipelineAsync;
    GPUDevice.prototype.createComputePipelineAsync = function (descriptor) {
      this.destroy();
      return original.call(this, descriptor);
    };
  });
  await page.goto("/?bdptDiagnostics=1");
  test.skip(
    !(await page.evaluate(async () =>
      Boolean(await navigator.gpu?.requestAdapter()),
    )),
    "WebGPU is unavailable.",
  );
  await page
    .getByRole("button", { name: "Run diagnostics", exact: true })
    .click();
  await expect(page.getByLabel("Diagnostic report")).toHaveValue(
    /GPU device lost/,
    { timeout: 30_000 },
  );
  const report = await page.getByLabel("Diagnostic report").inputValue();
  expect(report).not.toContain("PASS");
  expect(report).not.toContain("START camera-subpath");
  expect(report).not.toContain("DONE");
});

test("generic diagnostics offer core probes and remain accessible from the renderer", async ({
  page,
}) => {
  await page.goto("/");
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.getByRole("link", { name: "GPU diagnostics" }).click();
  await expect(page.getByLabel("Diagnostic suite")).toHaveValue("core");
  await expect(page.locator("canvas")).toHaveCount(0);
  test.skip(
    !(await page.evaluate(async () =>
      Boolean(await navigator.gpu?.requestAdapter()),
    )),
    "WebGPU is unavailable.",
  );
  await page
    .getByRole("button", { name: "Run diagnostics", exact: true })
    .click();
  await expect(page.getByLabel("Diagnostic report")).toHaveValue(/DONE\./, {
    timeout: 30_000,
  });
  const report = await page.getByLabel("Diagnostic report").inputValue();
  expect(report).toContain("Core WebGPU v1");
  expect(report).not.toContain("FAIL");
  expect(report.match(/^\[\+\d+\.\d{3}s\] PASS /gm)).toHaveLength(3);
  await page.getByLabel("Diagnostic suite").selectOption("bdpt");
  await expect(page.getByLabel("Diagnostic report")).toHaveValue("");
  await page.goto("/?diagnostics=bdpt");
  await expect(page.getByLabel("Diagnostic suite")).toHaveValue("bdpt");
});

test("GPU diagnostics remain usable when WebGPU is absent", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "gpu", { value: undefined });
    delete globalThis.GPUShaderStage;
  });
  await page.goto("/?diagnostics=core");
  await expect(
    page.getByRole("heading", { name: "GPU diagnostics" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Run diagnostics", exact: true })
    .click();
  await expect(page.getByLabel("Diagnostic report")).toHaveValue(
    /No WebGPU adapter available/,
  );
  await page.getByLabel("Diagnostic suite").selectOption("bdpt");
  await page
    .getByRole("button", { name: "Run diagnostics", exact: true })
    .click();
  await expect(page.getByLabel("Diagnostic report")).toHaveValue(
    /No WebGPU adapter available/,
  );
});

test("BDPT execution diagnostics read nonzero radiance from production passes", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto("/?diagnostics=bdpt-execution");
  const available = await page.evaluate(async () =>
    Boolean(await navigator.gpu?.requestAdapter()),
  );
  test.skip(!available, "WebGPU is unavailable");
  await page
    .getByRole("button", { name: "Run diagnostics", exact: true })
    .click();
  const report = page.getByLabel("Diagnostic report");
  await expect(report).toHaveValue(/DONE\./, { timeout: 150_000 });
  const text = await report.inputValue();
  expect(text).toContain("GPU execution and readback");
  expect(text).toContain("READY production BDPT pipelines");
  expect(text.match(/COMPILE PASS bdpt-/g)).toHaveLength(7);
  expect(
    text.split("\n").every((line) => /^\[\+\d+\.\d{3}s\] /.test(line)),
  ).toBe(true);
  expect(text).not.toMatch(/FAIL|GPU ERROR|finite=false/);
  expect(text.match(/finite=true positive=/g)).toHaveLength(9);
  expect(text).toContain("PASS glass / 39x31 / 3 frames");
});

test("stopped execution diagnostics discard reports from delayed GPU work", async ({
  page,
}) => {
  await page.goto("/?diagnostics=bdpt-execution");
  const available = await page.evaluate(async () =>
    Boolean(await navigator.gpu?.requestAdapter()),
  );
  test.skip(!available, "WebGPU is unavailable");
  await page.evaluate(() => {
    const original = GPUDevice.prototype.createComputePipelineAsync;
    GPUDevice.prototype.createComputePipelineAsync = async function (
      descriptor,
    ) {
      const pipeline = await original.call(this, descriptor);
      if (descriptor.label === "bdpt-initial-camera") {
        window.__diagnosticPaused = true;
        await new Promise((resolve) => {
          window.__releaseDiagnostic = resolve;
        });
      }
      return pipeline;
    };
  });
  await page
    .getByRole("button", { name: "Run diagnostics", exact: true })
    .click();
  await page.waitForFunction(() => window.__diagnosticPaused);
  await expect(page.getByLabel("Diagnostic report")).toHaveValue(/WAIT glass/, {
    timeout: 10_000,
  });
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  const report = page.getByLabel("Diagnostic report");
  await expect(report).toHaveValue(/Stopped\./);
  const stopped = await report.inputValue();
  await page.evaluate(() => window.__releaseDiagnostic());
  await page.waitForTimeout(500);
  expect(await report.inputValue()).toBe(stopped);
});
