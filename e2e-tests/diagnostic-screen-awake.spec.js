import { expect, test } from "@playwright/test";

for (const [suite, button] of [
  ["core", "Run diagnostics"],
  ["bdpt-spatial-ab", "Run comparison"],
]) {
  test(`${suite} releases its screen lock when stopped during startup`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      window.wakeReleases = 0;
      Object.defineProperty(navigator, "gpu", {
        configurable: true,
        value: {
          requestAdapter: () =>
            new Promise((resolve) => {
              window.finishAdapterRequest = resolve;
            }),
        },
      });
      Object.defineProperty(navigator, "wakeLock", {
        configurable: true,
        value: {
          request: async () =>
            Object.assign(new EventTarget(), {
              released: false,
              release: async () => {
                window.wakeReleases++;
              },
            }),
        },
      });
    });
    await page.goto(`/?diagnostics=${suite}`);
    await page.getByRole("button", { name: button, exact: true }).click();
    await expect(page.getByLabel("Screen wake lock")).toContainText(
      "active during diagnostics",
    );
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    expect(await page.evaluate(() => window.wakeReleases)).toBe(1);
    await page.evaluate(() => window.finishAdapterRequest(null));
    await expect(
      page.getByRole("button", { name: button, exact: true }),
    ).toBeEnabled();
    await expect(page.getByLabel("Screen wake lock")).toHaveCount(0);
  });
}
