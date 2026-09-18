import { expect, test } from "@playwright/test";

for (const variant of [
  "full",
  "no-inverse",
  "no-forward",
  "no-replay",
  "one-neighbor",
]) {
  test(`isolated spatial compilation: ${variant}`, async ({ page }) => {
    test.setTimeout(90_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`/?diagnostics=bdpt-spatial-${variant}`);
    await expect(page.getByRole("combobox")).toHaveValue(
      `bdpt-spatial-${variant}`,
    );
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
      timeout: 60_000,
    });
    const report = await page.getByLabel("Diagnostic report").inputValue();
    expect(report).not.toContain("FAIL");
    expect(report.match(/\] PASS /g)).toHaveLength(1);
    expect(report).toContain(
      `spatial-${variant} / vertices=10 / workgroup=1x1`,
    );
    expect(errors).toEqual([]);
  });
}

for (const failTemporal of [false, true]) {
  test(`temporal precedes spatial on one device (failure=${failTemporal})`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.addInitScript((fail) => {
      const original = GPUDevice.prototype.createComputePipelineAsync;
      const devices = new Set();
      window.__compileTrace = [];
      GPUDevice.prototype.createComputePipelineAsync = async function (
        descriptor,
      ) {
        devices.add(this);
        window.__compileTrace.push({
          label: descriptor.label,
          sameDevice: devices.size === 1,
          event: "start",
        });
        if (fail)
          throw new GPUPipelineError("injected temporal failure", {
            reason: "internal",
          });
        const pipeline = await original.call(this, descriptor);
        window.__compileTrace.push({
          label: descriptor.label,
          event: "complete",
        });
        return pipeline;
      };
    }, failTemporal);
    await page.goto("/?diagnostics=bdpt-spatial-after-temporal");
    await expect(page.getByRole("combobox")).toHaveValue(
      "bdpt-spatial-after-temporal",
    );
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
      /Releasing/,
      { timeout: 70_000 },
    );
    const report = await page.getByLabel("Diagnostic report").inputValue();
    const trace = await page.evaluate(() => window.__compileTrace);
    expect(
      trace
        .filter((item) => item.event === "start")
        .every((item) => item.sameDevice),
    ).toBe(true);
    if (failTemporal) {
      expect(trace).toHaveLength(1);
      expect(report).toContain("FAIL temporal");
      expect(report).not.toContain("START spatial");
      expect(report).toContain("Releasing 0 retained");
    } else {
      expect(trace.map((item) => item.event)).toEqual([
        "start",
        "complete",
        "start",
        "complete",
      ]);
      expect(trace[0].label).toContain("temporal /");
      expect(trace[2].label).toContain("spatial-full /");
      expect(report).not.toContain("FAIL");
      expect(report).toContain("DONE.");
      expect(report).toContain("Releasing 2 retained");
    }
  });
}
