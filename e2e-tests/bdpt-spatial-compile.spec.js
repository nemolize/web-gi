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
