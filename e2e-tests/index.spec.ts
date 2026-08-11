import { expect, test } from "@playwright/test";

import { isPreviewTarget } from "./target";

test("renders the control panel and starts (or reports) the WebGPU renderer", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page).toHaveTitle("web-gi — Real-time GI on WebGPU");
  await expect(page.getByRole("heading", { name: "web-gi" })).toBeVisible();
  await expect(page.getByLabel("Render output")).toBeVisible();

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

  // Denoised path tracing bypasses resampling but keeps the shared filter.
  await page.getByRole("radio", { name: "Denoised PT" }).click();
  await expect(spatialReuse).toBeDisabled();
  await expect(page.getByLabel("À-trous filter")).toBeEnabled();

  // Reference path tracing bypasses both resampling and filtering.
  await page.getByRole("radio", { name: "Reference PT" }).click();
  await expect(
    page.getByRole("radio", { name: "Reference PT" }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(spatialReuse).toBeDisabled();
  await expect(page.getByLabel("À-trous filter")).toBeDisabled();

  await page.getByRole("radio", { name: "ReSTIR" }).click();
  await expect(spatialReuse).toBeEnabled();
});

test("loads the heavy benchmark preset from a short query", async ({
  page,
}) => {
  await page.goto("/?preset=heavy&mode=path-traced&measure=auto");

  await expect(
    page.getByRole("radio", { name: "Denoised PT" }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(page.getByLabel("Scene")).toHaveValue("manyLights");
  await expect(page.getByLabel("RIS candidates")).toHaveValue("32");
  await expect(page.getByLabel("Spatial neighbours")).toHaveValue("8");
  await expect(page.getByLabel("Bounces")).toHaveValue("6");
  await expect(page.getByLabel("Resolution scale")).toHaveValue("0.75");
});

test("starts an automatic comparison from the reference renderer", async ({
  page,
}) => {
  await page.goto("/?preset=heavy&compare=path-traced");

  await expect(
    page.getByRole("radio", { name: "Reference PT" }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(page.getByLabel("Scene")).toHaveValue("manyLights");
  await expect(page.getByLabel("Bounces")).toHaveValue("6");
});

test("renders finite Denoised PT output when WebGPU is available", async ({
  page,
}) => {
  const gpuErrors: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (
      message.type() === "error" &&
      (text.includes("[wgsl]") || text.includes("uncaptured WebGPU error"))
    ) {
      gpuErrors.push(text);
    }
  });
  await page.goto("/");

  const notice = page.getByRole("alert");
  const accumulated = page.getByTestId("stat-accumulated");
  await expect
    .poll(
      async () => {
        if ((await notice.count()) > 0) return "notice";
        return Number((await accumulated.textContent()) ?? "0") >= 30
          ? "ready"
          : "pending";
      },
      { timeout: 20_000 },
    )
    .not.toBe("pending");
  test.skip((await notice.count()) > 0, "requires a WebGPU adapter");

  const before = Number((await accumulated.textContent()) ?? "0");
  await page.getByRole("radio", { name: "Denoised PT" }).click();
  await expect
    .poll(async () => Number((await accumulated.textContent()) ?? "0"))
    .toBeLessThan(before);
  await expect
    .poll(async () => Number((await accumulated.textContent()) ?? "0"))
    .toBeGreaterThan(0);

  const output = await page.evaluate(async () => {
    const hooks: unknown = Reflect.get(globalThis, "__gi");
    if (hooks === null || typeof hooks !== "object") return null;
    const capture: unknown = Reflect.get(hooks, "capture");
    if (typeof capture !== "function") return null;
    const image: unknown = await Reflect.apply(capture, hooks, []);
    if (image === null || typeof image !== "object") return null;
    const data: unknown = Reflect.get(image, "data");
    if (!(data instanceof Float32Array)) return null;
    let energy = 0;
    for (let index = 0; index < data.length; index += 4) {
      const red = data[index];
      const green = data[index + 1];
      const blue = data[index + 2];
      if (
        red === undefined ||
        green === undefined ||
        blue === undefined ||
        !Number.isFinite(red) ||
        !Number.isFinite(green) ||
        !Number.isFinite(blue)
      ) {
        return { finite: false, energy };
      }
      energy += red + green + blue;
    }
    return { finite: true, energy };
  });
  expect(output).not.toBeNull();
  expect(output?.finite).toBe(true);
  expect(output?.energy).toBeGreaterThan(0);
  expect(gpuErrors).toEqual([]);
});

test("offers every scene and switches between them", async ({ page }) => {
  await page.goto("/");

  const scene = page.getByLabel("Scene");
  await expect(scene).toHaveValue("classic");
  await expect(scene.locator("option")).toHaveCount(5);

  await scene.selectOption("pillars");
  await expect(scene).toHaveValue("pillars");
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

test("serves the SPA shell for a deep route with no file on disk", async ({
  page,
}) => {
  await page.goto("/some/deep/route");

  await expect(page).toHaveTitle("web-gi — Real-time GI on WebGPU");
  await expect(page.getByRole("heading", { name: "web-gi" })).toBeVisible();
});

test("serves the app from hashed production assets", async ({ page }) => {
  test.skip(!isPreviewTarget, "only meaningful against the production build");

  await page.goto("/");

  const scriptSrc =
    (await page.locator('script[type="module"]').getAttribute("src")) ?? "";
  expect(scriptSrc).toMatch(/^\/assets\/index-[\w-]+\.js$/);

  const response = await page.request.get(scriptSrc);
  expect(response.status()).toBe(200);
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

    const canvas = page.getByLabel("Render output");
    const controlsButton = page.getByRole("button", { name: "Controls" });
    const panelElement = page.locator("#render-controls");
    const panel = page.getByRole("dialog", { name: "Rendering controls" });

    await expect(canvas).toBeVisible();
    await expect(controlsButton).toBeVisible();
    await expect(panelElement).not.toBeVisible();

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

    const canvas = page.getByLabel("Render output");
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
