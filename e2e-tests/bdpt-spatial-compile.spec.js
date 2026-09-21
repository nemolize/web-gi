import { expect, test } from "@playwright/test";

for (const variant of [
  "full",
  "no-inverse",
  "no-forward",
  "no-replay",
  "one-neighbor",
  "inverse-one-neighbor",
  "inverse-two-neighbors",
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

for (const [suite, first, second] of [
  ["bdpt-spatial-after-temporal", "temporal", "spatial-full"],
  ["bdpt-temporal-after-spatial", "spatial-full", "temporal"],
]) {
  for (const failFirst of [false, true]) {
    test(`${suite} uses one device (failure=${failFirst})`, async ({
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
            throw new GPUPipelineError("injected prerequisite failure", {
              reason: "internal",
            });
          const pipeline = await original.call(this, descriptor);
          window.__compileTrace.push({
            label: descriptor.label,
            event: "complete",
          });
          return pipeline;
        };
      }, failFirst);
      await page.goto(`/?diagnostics=${suite}`);
      await expect(page.getByRole("combobox")).toHaveValue(suite);
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
      if (failFirst) {
        expect(trace).toHaveLength(1);
        expect(report).toContain(`FAIL ${first}`);
        expect(report).not.toContain(`START ${second}`);
        expect(report).toContain("Releasing 0 retained");
      } else {
        expect(trace.map((item) => item.event)).toEqual([
          "start",
          "complete",
          "start",
          "complete",
        ]);
        expect(trace[0].label).toContain(`${first} /`);
        expect(trace[2].label).toContain(`${second} /`);
        expect(report).not.toContain("FAIL");
        expect(report).toContain("DONE.");
        expect(report).toContain("Releasing 2 retained");
      }
    });
  }
}

for (const phase of [
  "prepare",
  "apply",
  "combined",
  "combined-twice",
  "combined-loop-two",
]) {
  test(`isolated inverse ${phase} compiles`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto(`/?diagnostics=bdpt-inverse-${phase}`);
    await expect(page.getByRole("combobox")).toHaveValue(
      `bdpt-inverse-${phase}`,
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
      timeout: 40_000,
    });
    const report = await page.getByLabel("Diagnostic report").inputValue();
    expect(report).not.toContain("FAIL");
    expect(report.match(/\] PASS /g)).toHaveLength(1);
  });
}
