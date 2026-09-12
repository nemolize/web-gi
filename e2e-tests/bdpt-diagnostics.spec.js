import { expect, test } from "@playwright/test";

test("BDPT diagnostics compile isolated stages without starting the renderer", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?bdptDiagnostics=1");
  await expect(
    page.getByRole("heading", { name: "BDPT compiler diagnostics" }),
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
  expect(report.match(/^PASS /gm)).toHaveLength(14);
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
