import { expect, test } from "@playwright/test";

test("shows warmup before sampling and completes three slow captures", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    const requestFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) =>
      requestFrame(() => {
        window.setTimeout(() => callback(performance.now()), 200);
      });
  });
  await page.goto("/");
  const gpuAvailable = await page.evaluate(async () =>
    Boolean(await navigator.gpu?.requestAdapter()),
  );
  test.skip(!gpuAvailable, "WebGPU unavailable.");
  await expect(page.getByTestId("stat-accumulated")).not.toHaveText("0");
  await expect(page.getByText(/Each run warms up for 30 frames/)).toBeVisible();
  await page.getByRole("button", { name: "Measure 3 runs" }).click();
  await expect(
    page.getByRole("button", { name: "Warming up 1/3…" }),
  ).toBeVisible();
  await expect(
    page.getByText(/Warming up run 1 of 3: [1-9][0-9]* \/ 30 frames/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Measuring 1/3…" }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByText(/Measuring run 1 of 3: [0-9.]+ \/ 5 seconds/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Warming up 2/3…" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Copy result" })).toBeVisible({
    timeout: 60_000,
  });
});
