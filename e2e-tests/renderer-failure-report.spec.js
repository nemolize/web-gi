import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 430, height: 900 } });

test("device loss preserves a copyable renderer snapshot and retry recovers", async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (!navigator.gpu) return;
    const requestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
    navigator.gpu.requestAdapter = async (...args) => {
      const adapter = await requestAdapter(...args);
      if (!adapter) return adapter;
      const requestDevice = adapter.requestDevice.bind(adapter);
      adapter.requestDevice = async (...args) => {
        const device = await requestDevice(...args);
        const lost = device.lost;
        Object.defineProperty(device, "lost", {
          value: lost.then(() => ({
            reason: "unknown",
            message: "Injected GPU reset",
          })),
        });
        window.__loseRenderer = () => device.destroy();
        return device;
      };
      return adapter;
    };
  });
  await page.goto("/");
  const available = await page.evaluate(async () =>
    Boolean(await navigator.gpu?.requestAdapter()),
  );
  test.skip(!available, "WebGPU unavailable");
  await expect(page.getByTestId("stat-accumulated")).not.toHaveText("0", {
    timeout: 30_000,
  });
  await page.evaluate(() => window.__loseRenderer());
  await expect(
    page.getByRole("heading", { name: "Renderer unavailable" }),
  ).toBeVisible();
  await page.getByText("Diagnostic report", { exact: true }).click();
  const report = await page
    .getByLabel("Renderer diagnostic report")
    .inputValue();
  expect(report).toContain("Renderer failure report v1");
  expect(report).toContain("Adapter:");
  expect(report).toContain("Settings:");
  expect(report).toContain("Last submitted frame stats (not GPU completion):");
  expect(report).toContain("Injected GPU reset");
  await page.evaluate(() => {
    navigator.clipboard.writeText = async (text) => {
      window.__copiedReport = text;
    };
  });
  await page.getByRole("button", { name: "Copy diagnostic report" }).click();
  await expect(page.getByRole("status")).toHaveText("Copied.");
  expect(await page.evaluate(() => window.__copiedReport)).toBe(report);
  await page.evaluate(() => {
    navigator.clipboard.writeText = async () => {
      throw new Error("denied");
    };
  });
  await page.getByRole("button", { name: "Copy diagnostic report" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Select the report below",
  );
  expect(await page.getByLabel("Renderer diagnostic report").inputValue()).toBe(
    report,
  );
  await page.screenshot({
    path: test.info().outputPath("renderer-failure-report.png"),
  });
  await page.getByRole("button", { name: "Retry renderer" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByTestId("stat-accumulated")).not.toHaveText("0", {
    timeout: 30_000,
  });
});
