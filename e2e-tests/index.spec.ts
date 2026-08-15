import { expect, type Locator, test } from "@playwright/test";

import { isPreviewTarget } from "./target";

const waitForAccumulatedFrames = async (
  accumulated: Locator,
  frames: number,
): Promise<void> => {
  await expect
    .poll(async () => Number((await accumulated.textContent()) ?? "0"), {
      timeout: 20_000,
    })
    .toBeGreaterThanOrEqual(frames);
};

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

test("loads the paired comparison matrix from one preset", async ({ page }) => {
  await page.goto(
    "/?preset=matrix&compare=restir&mode=path-traced&measure=auto",
  );

  await expect(page).toHaveURL(/\?preset=matrix/);
  await expect(
    page.getByRole("radio", { name: "Reference PT" }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(page.getByLabel("RIS candidates")).toHaveValue("32");
  await expect(page.getByLabel("Spatial neighbours")).toHaveValue("8");
  await expect(page.getByLabel("Bounces")).toHaveValue("6");
});

test("renders finite glass-shape output when WebGPU is available", async ({
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

  const scene = page.getByLabel("Scene");
  const beforeSceneChange = Number((await accumulated.textContent()) ?? "0");
  await scene.selectOption("glassShapes");
  await expect(scene).toHaveValue("glassShapes");
  await expect
    .poll(async () => Number((await accumulated.textContent()) ?? "0"))
    .toBeLessThan(beforeSceneChange);

  const captureOutput = async () =>
    page.evaluate(async () => {
      const hooks: unknown = Reflect.get(globalThis, "__gi");
      if (hooks === null || typeof hooks !== "object") return null;
      const capture: unknown = Reflect.get(hooks, "capture");
      if (typeof capture !== "function") return null;
      const image: unknown = await Reflect.apply(capture, hooks, []);
      if (image === null || typeof image !== "object") return null;
      const data: unknown = Reflect.get(image, "data");
      if (!(data instanceof Float32Array)) return null;
      let energy = 0;
      let glassEnergy = 0;
      let glassPixels = 0;
      let transmittedPixels = 0;
      let transmittedSpherePixels = 0;
      let transmittedPedestalBoxPixels = 0;
      let transmittedBackdropBoxPixels = 0;
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
        const diagnostic = data[index + 3] ?? 0;
        if (diagnostic > 0.5) {
          glassEnergy += red + green + blue;
          glassPixels++;
        }
        if (diagnostic > 1.5) transmittedPixels++;
        if (diagnostic > 1.5 && diagnostic < 2.5) {
          transmittedSpherePixels++;
        }
        if (diagnostic > 2.5 && diagnostic < 3.5) {
          transmittedPedestalBoxPixels++;
        }
        if (diagnostic > 3.5 && diagnostic < 4.5) {
          transmittedBackdropBoxPixels++;
        }
      }
      return {
        finite: true,
        energy,
        glassEnergy,
        glassPixels,
        transmittedPixels,
        transmittedSpherePixels,
        transmittedPedestalBoxPixels,
        transmittedBackdropBoxPixels,
        pixels: data.length / 4,
      };
    });

  const modes = ["ReSTIR", "Denoised PT", "Reference PT"] as const;
  for (const [index, mode] of modes.entries()) {
    if (index > 0) {
      const before = Number((await accumulated.textContent()) ?? "0");
      const control = page.getByRole("radio", { name: mode });
      await control.click();
      await expect(control).toHaveAttribute("aria-checked", "true");
      await expect
        .poll(async () => Number((await accumulated.textContent()) ?? "0"))
        .toBeLessThan(before);
    }
    await waitForAccumulatedFrames(accumulated, 30);
    const output = await captureOutput();
    expect(output, mode).not.toBeNull();
    expect(output?.finite, mode).toBe(true);
    expect(output?.energy, mode).toBeGreaterThan(0);
    expect(output?.glassPixels, mode).toBeGreaterThan(0);
    expect(output?.glassPixels, mode).toBeLessThan(output?.pixels ?? 0);
    expect(output?.glassEnergy, mode).toBeGreaterThan(0);
    expect(output?.transmittedPixels, mode).toBeGreaterThan(0);
    expect(output?.transmittedSpherePixels, mode).toBeGreaterThan(0);
    expect(output?.transmittedPedestalBoxPixels, mode).toBeGreaterThan(0);
    expect(output?.transmittedBackdropBoxPixels, mode).toBeGreaterThan(0);
  }
  expect(gpuErrors).toEqual([]);
});

test("offers every scene and switches between them", async ({ page }) => {
  await page.goto("/");

  const scene = page.getByLabel("Scene");
  await expect(scene).toHaveValue("classic");
  await expect(scene.locator("option")).toHaveCount(6);

  await scene.selectOption("glassShapes");
  await expect(scene).toHaveValue("glassShapes");
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
