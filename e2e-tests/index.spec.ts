import { expect, test } from "@playwright/test";

test("renders the control panel and starts (or reports) the WebGPU renderer", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page).toHaveTitle("web-gi — Real-time GI Cornell Box");
  await expect(page.getByRole("heading", { name: "web-gi" })).toBeVisible();
  await expect(page.getByLabel("Cornell box render")).toBeVisible();

  // WebGPU availability depends on the runner, so accept either outcome: a
  // renderer that has accumulated at least one frame, or an explicit notice.
  const accumulated = page.getByTestId("stat-accumulated");
  const notice = page.getByRole("alert");

  await expect
    .poll(
      async () => {
        if ((await notice.count()) > 0) return "notice";
        const text = await accumulated.textContent();
        return Number(text ?? "0") > 0 ? "rendering" : "pending";
      },
      { timeout: 20_000 },
    )
    .not.toBe("pending");
});

test("exposes the ReSTIR stages as independent toggles", async ({ page }) => {
  await page.goto("/");

  const spatialReuse = page
    .getByRole("region", { name: "Indirect light (ReSTIR GI)" })
    .getByLabel("Spatial reuse");

  await expect(page.getByRole("radio", { name: "ReSTIR" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(spatialReuse).toBeEnabled();

  // Reference path tracing bypasses resampling entirely.
  await page.getByRole("radio", { name: "Reference PT" }).click();
  await expect(
    page.getByRole("radio", { name: "Reference PT" }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(spatialReuse).toBeDisabled();

  await page.getByRole("radio", { name: "ReSTIR" }).click();
  await expect(spatialReuse).toBeEnabled();
});

test("keeps desktop sidebar keyboard navigation untrapped", async ({
  page,
}) => {
  await page.goto("/");

  const resetView = page.getByRole("button", { name: "Reset view" });
  await resetView.focus();
  await page.keyboard.press("Escape");
  await expect(resetView).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(resetView).not.toBeFocused();
});

test.describe("mobile controls", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test("keeps the render full-screen until the controls are requested", async ({
    page,
  }) => {
    await page.goto("/");

    const canvas = page.getByLabel("Cornell box render");
    const controlsButton = page.getByRole("button", { name: "Controls" });
    const panelElement = page.locator("#render-controls");
    const panel = page.getByRole("dialog", { name: "Rendering controls" });

    await expect(canvas).toBeVisible();
    await expect(controlsButton).toBeVisible();
    await expect(panelElement).not.toBeVisible();
    await expect(page.getByRole("region", { name: "Stats" })).toBeVisible();

    await expect
      .poll(async () => {
        const box = await canvas.boundingBox();
        return box === null ? null : { width: box.width, height: box.height };
      })
      .toEqual({ width: 390, height: 844 });

    await controlsButton.click();
    await expect(panel).toBeVisible();
    await expect(page.getByRole("heading", { name: "web-gi" })).toBeVisible();
    const closeButton = panel.getByRole("button", { name: "Close controls" });
    await expect(closeButton).toBeFocused();

    const panelBox = await panel.boundingBox();
    expect(panelBox?.width).toBe(390);
    expect(panelBox?.height).toBeLessThanOrEqual(844 * 0.78);

    await page.keyboard.press("Shift+Tab");
    await expect(
      panel.getByRole("button", { name: "Reset view" }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(closeButton).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(panelElement).not.toBeVisible();
    await expect(controlsButton).toBeFocused();
  });

  test("keeps on-demand controls on landscape phones", async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await page.goto("/");

    const canvas = page.getByLabel("Cornell box render");
    const controlsButton = page.getByRole("button", { name: "Controls" });

    await expect(controlsButton).toBeVisible();
    await expect(
      page.getByRole("dialog", { name: "Rendering controls" }),
    ).not.toBeVisible();
    await expect
      .poll(async () => {
        const box = await canvas.boundingBox();
        return box === null ? null : { width: box.width, height: box.height };
      })
      .toEqual({ width: 844, height: 390 });
  });

  test("preserves visible focus across the desktop breakpoint", async ({
    page,
  }) => {
    await page.goto("/");

    const controlsButton = page.getByRole("button", { name: "Controls" });
    await controlsButton.click();
    await expect(
      page
        .getByRole("dialog", { name: "Rendering controls" })
        .getByRole("button", { name: "Close controls" }),
    ).toBeFocused();

    await page.setViewportSize({ width: 1024, height: 844 });
    await expect(page.getByRole("radio", { name: "ReSTIR" })).toBeFocused();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(controlsButton).toBeFocused();
    await expect(page.locator("#render-controls")).not.toBeVisible();

    await controlsButton.click();
    const exposure = page.getByLabel("Exposure");
    await exposure.focus();
    await page.setViewportSize({ width: 1024, height: 844 });
    await expect(exposure).toBeFocused();
  });
});
